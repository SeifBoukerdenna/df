use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use rust_decimal::Decimal;
use tokio::sync::{mpsc, watch, Mutex};
use tracing::{debug, error, info, warn};

use crate::config::schema::AppConfig;
use crate::config::wallets::TrackedWallet;
use crate::core::book::OrderBook;
use crate::core::event::NormalizedEvent;
use crate::core::fees;
use crate::core::types::*;
use crate::ingestion::rest_book;
use crate::ingestion::rest_wallets::{self, DetectedWalletTrade, PollCycleMetrics};
use crate::ingestion::ws_market::{self, WsMarketEvent};
use crate::sim::fill::{self, FillRequest};
use crate::sim::portfolio::Portfolio;
use crate::storage::db::Store;

/// Session state managed by the engine.
pub struct EngineState {
    pub session_id: String,
    pub portfolio: Portfolio,
    pub books: HashMap<TokenId, OrderBook>,
    pub config: AppConfig,
    pub last_event_id: i64,
    pub started_at: std::time::Instant,
    pub wallet_trades_seen: u64,
    pub first_trade_captures: u64,
    pub first_trade_misses: u64,
    pub book_warmups: u64,
    /// Tracks which token_ids had their book warmed via REST before first fill.
    warmed_tokens: HashSet<TokenId>,
    /// Latest poll cycle metrics per category.
    pub latest_dir_cycle: Option<PollCycleMetrics>,
    pub latest_arb_cycle: Option<PollCycleMetrics>,
}

/// Run the full engine loop. This is the main entry point for `df run`.
pub async fn run_session(
    config: AppConfig,
    wallets: Vec<TrackedWallet>,
    store: Arc<Store>,
) -> Result<(), Box<dyn std::error::Error>> {
    let session_id = Utc::now().format("%Y-%m-%d-%H%M%S").to_string();
    let http_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?;

    info!(session_id = %session_id, "starting session");

    // Log session start event
    {
        let start_event = NormalizedEvent::HealthEvent {
            kind: "session_start".into(),
            message: format!(
                "Session started: capital=${}, wallets={}, polling={}, fee_policy={}",
                config.session.starting_capital,
                wallets.len(),
                config.latency.polling_mode,
                config.fees.unavailable_policy,
            ),
            ts: Utc::now(),
        };
        if let Err(e) = store.append_event(&session_id, &start_event) {
            warn!(error = %e, "failed to log session start");
        }
    }

    // === Phase 1: Proactive market discovery ===
    // Discover tokens that tracked wallets are currently active in.
    // Pre-subscribe WS and pre-warm books so the first trade doesn't miss.
    info!("discovering active markets from tracked wallets...");
    let discovered_tokens = rest_wallets::discover_active_tokens(&http_client, &wallets).await;

    // Pre-warm books via REST CLOB API (concurrent)
    let mut warmed_tokens = HashSet::new();
    let mut initial_books: HashMap<TokenId, OrderBook> = HashMap::new();
    if !discovered_tokens.is_empty() {
        let token_list: Vec<TokenId> = discovered_tokens.into_iter().collect();
        info!(tokens = token_list.len(), "pre-warming books via CLOB REST API");
        let snapshots = rest_book::fetch_books_batch(&http_client, &token_list).await;
        for snap in snapshots {
            let mut book = OrderBook::new(snap.token_id.clone());
            book.apply_snapshot(&snap.bids, &snap.asks);
            warmed_tokens.insert(snap.token_id.clone());
            initial_books.insert(snap.token_id, book);
        }
        info!(
            warmed = initial_books.len(),
            total = token_list.len(),
            "books pre-warmed"
        );
    }

    // Initialize portfolio
    let portfolio = Portfolio::new(config.session.starting_capital);

    let mut state = EngineState {
        session_id: session_id.clone(),
        portfolio,
        books: initial_books,
        config: config.clone(),
        last_event_id: 0,
        started_at: std::time::Instant::now(),
        wallet_trades_seen: 0,
        first_trade_captures: 0,
        first_trade_misses: 0,
        book_warmups: warmed_tokens.len() as u64,
        warmed_tokens,
        latest_dir_cycle: None,
        latest_arb_cycle: None,
    };

    // Shutdown signal
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    // Set up Ctrl+C handler
    let shutdown_tx_clone = shutdown_tx.clone();
    tokio::spawn(async move {
        tokio::signal::ctrl_c().await.ok();
        info!("received shutdown signal");
        let _ = shutdown_tx_clone.send(true);
    });

    // Channels
    let (ws_event_tx, mut ws_event_rx) = mpsc::channel::<WsMarketEvent>(1000);
    let (wallet_event_tx, mut wallet_event_rx) = mpsc::channel::<DetectedWalletTrade>(500);
    let (ws_subscribe_tx, ws_subscribe_rx) = mpsc::channel::<TokenId>(100);
    let (metrics_tx, mut metrics_rx) = mpsc::channel::<PollCycleMetrics>(50);
    let seen_tokens: Arc<Mutex<HashSet<TokenId>>> = Arc::new(Mutex::new(HashSet::new()));

    // Pre-populate seen_tokens with warmed tokens
    {
        let mut seen = seen_tokens.lock().await;
        for tid in state.warmed_tokens.iter() {
            seen.insert(tid.clone());
        }
    }

    // Start WebSocket market data with pre-discovered tokens
    let initial_ws_tokens: Vec<TokenId> = state.warmed_tokens.iter().cloned().collect();
    let ws_event_tx_for_ws = ws_event_tx.clone();
    tokio::spawn(async move {
        ws_market::run_ws_market(initial_ws_tokens, ws_event_tx_for_ws, ws_subscribe_rx).await;
    });

    // Drop the engine's copy — only WS and poller tasks hold senders.
    drop(ws_event_tx);

    // === Phase 2: Start parallel wallet poller ===
    // Category-aware cadences: directional gets faster polling.
    let dir_interval = Duration::from_millis(
        config.latency.directional_interval_ms.unwrap_or(match config.latency.polling_mode {
            PollingMode::Baseline => 3000,
            PollingMode::Aggressive => 1500,
        }),
    );
    let arb_interval = Duration::from_millis(
        config.latency.arbitrage_interval_ms.unwrap_or(match config.latency.polling_mode {
            PollingMode::Baseline => 5000,
            PollingMode::Aggressive => 3000,
        }),
    );

    let poller_client = http_client.clone();
    let poller_wallets = wallets.clone();
    let poller_shutdown = shutdown_rx.clone();
    let poller_seen = seen_tokens.clone();
    let poller_sub_tx = ws_subscribe_tx;
    tokio::spawn(async move {
        rest_wallets::run_wallet_poller(
            poller_client,
            poller_wallets,
            dir_interval,
            arb_interval,
            wallet_event_tx,
            poller_sub_tx,
            poller_seen,
            metrics_tx,
            poller_shutdown,
        )
        .await;
    });

    // Snapshot timer
    let snapshot_interval = Duration::from_secs(config.storage.snapshot_interval_secs);
    let mut snapshot_timer = tokio::time::interval(snapshot_interval);
    snapshot_timer.tick().await;

    // Stale check timer
    let stale_threshold = Duration::from_secs(config.ingestion.stale_threshold_secs);
    let mut stale_timer = tokio::time::interval(Duration::from_secs(10));
    stale_timer.tick().await;

    // Status print timer
    let mut status_timer = tokio::time::interval(Duration::from_secs(30));
    status_timer.tick().await;

    let mut shutdown_watch = shutdown_rx.clone();

    info!(
        dir_interval_ms = dir_interval.as_millis() as u64,
        arb_interval_ms = arb_interval.as_millis() as u64,
        pre_warmed_books = state.warmed_tokens.len(),
        fee_policy = %config.fees.unavailable_policy,
        "engine loop running — press Ctrl+C to stop"
    );

    loop {
        tokio::select! {
            // WebSocket events (book updates, trade prices)
            ws_event = ws_event_rx.recv() => {
                let Some(event) = ws_event else { break };
                handle_ws_event(&mut state, &store, event);
            }

            // Wallet trade detections
            wallet_trade = wallet_event_rx.recv() => {
                let Some(trade) = wallet_trade else { break };
                handle_wallet_trade(&mut state, &store, &http_client, trade).await;
            }

            // Poll cycle metrics
            metrics = metrics_rx.recv() => {
                if let Some(m) = metrics {
                    match m.category {
                        WalletCategory::Directional => state.latest_dir_cycle = Some(m),
                        WalletCategory::Arbitrage => state.latest_arb_cycle = Some(m),
                    }
                }
            }

            // Periodic snapshot
            _ = snapshot_timer.tick() => {
                save_snapshot(&state, &store);
            }

            // Stale book check
            _ = stale_timer.tick() => {
                for book in state.books.values_mut() {
                    book.check_staleness(stale_threshold);
                }
            }

            // Periodic status
            _ = status_timer.tick() => {
                print_status(&state);
            }

            // Shutdown
            _ = shutdown_watch.changed() => {
                if *shutdown_watch.borrow() {
                    info!("shutting down engine");
                    break;
                }
            }
        }
    }

    // Final snapshot
    save_snapshot(&state, &store);

    // Print final summary
    print_final_summary(&state);

    Ok(())
}

fn handle_ws_event(state: &mut EngineState, store: &Store, event: WsMarketEvent) {
    match event {
        WsMarketEvent::BookSnapshot {
            token_id,
            bids,
            asks,
            ..
        } => {
            let book = state
                .books
                .entry(token_id.clone())
                .or_insert_with(|| OrderBook::new(token_id.clone()));
            book.apply_snapshot(&bids, &asks);
        }
        WsMarketEvent::LastTradePrice {
            token_id, price, ..
        } => {
            if let Some(book) = state.books.get_mut(&token_id) {
                book.last_trade_price = Some(price);
            }
        }
        WsMarketEvent::Connected => {
            info!("WebSocket connected");
            let event = NormalizedEvent::HealthEvent {
                kind: "ws_connected".into(),
                message: "WebSocket connected".into(),
                ts: Utc::now(),
            };
            if let Ok(id) = store.append_event(&state.session_id, &event) {
                state.last_event_id = id;
            }
        }
        WsMarketEvent::Disconnected { reason } => {
            warn!(reason, "WebSocket disconnected — marking all books as rebuilding");
            for book in state.books.values_mut() {
                book.mark_rebuilding();
            }
            let event = NormalizedEvent::HealthEvent {
                kind: "ws_disconnected".into(),
                message: format!("WebSocket disconnected: {reason}"),
                ts: Utc::now(),
            };
            if let Ok(id) = store.append_event(&state.session_id, &event) {
                state.last_event_id = id;
            }
        }
    }
}

async fn handle_wallet_trade(
    state: &mut EngineState,
    store: &Store,
    http_client: &reqwest::Client,
    trade: DetectedWalletTrade,
) {
    state.wallet_trades_seen += 1;

    let detection_delay_ms = (trade.detected_at - trade.source_ts)
        .num_milliseconds()
        .max(0) as u64;

    // Is this the first trade we've seen on this token?
    let is_first_trade = !state.warmed_tokens.contains(&trade.token_id);

    // === Book warmup for new markets ===
    // If the book is missing or in Rebuilding/Stale state, try to fetch it via REST.
    // This is the critical path for first-trade capture.
    let book_needs_warmup = match state.books.get(&trade.token_id) {
        None => true,
        Some(b) => b.quality == DataQuality::Rebuilding || b.quality == DataQuality::Stale,
    };

    if book_needs_warmup {
        debug!(
            token = %trade.token_id,
            is_first = is_first_trade,
            "attempting REST book warmup for trade"
        );
        match rest_book::fetch_book(http_client, &trade.token_id).await {
            Ok(snapshot) => {
                let book = state
                    .books
                    .entry(trade.token_id.clone())
                    .or_insert_with(|| OrderBook::new(trade.token_id.clone()));
                book.apply_snapshot(&snapshot.bids, &snapshot.asks);
                state.warmed_tokens.insert(trade.token_id.clone());
                state.book_warmups += 1;
                debug!(
                    token = %trade.token_id,
                    bids = snapshot.bids.len(),
                    asks = snapshot.asks.len(),
                    "REST book warmup applied"
                );
            }
            Err(e) => {
                warn!(
                    token = %trade.token_id,
                    error = %e,
                    "REST book warmup failed"
                );
            }
        }
    }

    // Log the wallet trade event
    let wallet_event = NormalizedEvent::WalletTrade {
        wallet: trade.wallet.clone(),
        category: trade.category,
        token_id: trade.token_id.clone(),
        market_id: trade.market_id.clone(),
        side: trade.side,
        price: trade.price,
        size: trade.size,
        tx_hash: trade.tx_hash.clone(),
        detected_at: trade.detected_at,
        source_ts: trade.source_ts,
    };
    if let Ok(id) = store.append_event(&state.session_id, &wallet_event) {
        state.last_event_id = id;
    }

    info!(
        wallet = %trade.wallet,
        category = %trade.category,
        side = %trade.side,
        token = %trade.token_id,
        price = %trade.price,
        size = %trade.size,
        detection_ms = detection_delay_ms,
        first_trade = is_first_trade,
        "detected wallet trade"
    );

    // Resolve fees
    let resolved = fees::resolve_fee(
        http_client,
        store,
        &trade.token_id,
        state.config.fees.cache_ttl_secs,
    )
    .await;

    // Fee-unavailable policy check
    if resolved.source == FeeSource::Unavailable
        && state.config.fees.unavailable_policy == FeeUnavailablePolicy::Skip
    {
        warn!(
            token = %trade.token_id,
            "fee data unavailable — skipping trade (policy: skip)"
        );
        state.portfolio.record_miss();
        if is_first_trade {
            state.first_trade_misses += 1;
        }

        // Log as miss
        let fill_event = NormalizedEvent::SimulatedFill {
            wallet_trade_ref: trade.tx_hash,
            our_side: trade.side,
            fill_result: FillResult::Miss {
                reason: MissReason::Degraded,
            },
            avg_price: None,
            filled_qty: Decimal::ZERO,
            fee_rate: None,
            fee_amount: Decimal::ZERO,
            fee_source: FeeSource::Unavailable,
            slippage_bps: None,
            latency: LatencyComponents {
                detection_delay_ms: Some(detection_delay_ms),
                processing_delay_ms: Some(0),
                arrival_delay_ms: state.config.latency.arrival_delay_ms,
            },
            book_quality: state
                .books
                .get(&trade.token_id)
                .map(|b| b.quality)
                .unwrap_or(DataQuality::Rebuilding),
            exit_actionability: None,
        };
        if let Ok(id) = store.append_event(&state.session_id, &fill_event) {
            state.last_event_id = id;
        }
        return;
    }

    // Get current position qty for sell validation
    let current_qty = state.portfolio.position_qty(&trade.token_id);

    // Determine available capital for this trade
    let max_for_trade =
        state.config.session.max_position_fraction * state.portfolio.starting_capital;
    let available = state.portfolio.cash.min(max_for_trade);

    // Build fill request
    let processing_start = std::time::Instant::now();

    let book = state
        .books
        .entry(trade.token_id.clone())
        .or_insert_with(|| OrderBook::new(trade.token_id.clone()));

    let request = FillRequest {
        side: trade.side,
        desired_qty: trade.size,
        reference_price: trade.price,
        max_slippage_bps: state.config.session.max_slippage_bps,
        available_capital: available,
        fee_rate_bps: resolved.rate_bps,
        fee_source: resolved.source,
        current_position_qty: current_qty,
        latency: LatencyComponents {
            detection_delay_ms: Some(detection_delay_ms),
            processing_delay_ms: None,
            arrival_delay_ms: state.config.latency.arrival_delay_ms,
        },
    };

    let mut output = fill::simulate_fill(book, &request);
    output.latency.processing_delay_ms = Some(processing_start.elapsed().as_millis() as u64);

    // Track first-trade capture rate
    if is_first_trade {
        match &output.result {
            FillResult::Full | FillResult::Partial { .. } => {
                state.first_trade_captures += 1;
            }
            FillResult::Miss { .. } => {
                state.first_trade_misses += 1;
            }
        }
    }

    // Apply to portfolio
    match &output.result {
        FillResult::Full => {
            let apply_result = match trade.side {
                Side::Buy => state.portfolio.apply_buy(
                    &trade.token_id,
                    &trade.market_id,
                    &output,
                    &trade.wallet,
                    trade.category,
                ),
                Side::Sell => state.portfolio.apply_sell(&trade.token_id, &output),
            };
            if let Err(e) = apply_result {
                error!(error = %e, "portfolio error on full fill");
                state.portfolio.record_miss();
            } else {
                state.portfolio.record_full();
                info!(
                    side = %trade.side,
                    qty = %output.filled_qty,
                    price = %output.avg_price.unwrap_or_default(),
                    fee = %output.fee_amount,
                    fee_source = %output.fee_source,
                    slippage_bps = %output.slippage_bps.unwrap_or_default(),
                    first_trade = is_first_trade,
                    "full fill applied"
                );
            }
        }
        FillResult::Partial { filled_qty } => {
            let apply_result = match trade.side {
                Side::Buy => state.portfolio.apply_buy(
                    &trade.token_id,
                    &trade.market_id,
                    &output,
                    &trade.wallet,
                    trade.category,
                ),
                Side::Sell => state.portfolio.apply_sell(&trade.token_id, &output),
            };
            if let Err(e) = apply_result {
                error!(error = %e, "portfolio error on partial fill");
                state.portfolio.record_miss();
            } else {
                state.portfolio.record_partial();
                info!(
                    side = %trade.side,
                    filled = %filled_qty,
                    desired = %trade.size,
                    first_trade = is_first_trade,
                    "partial fill applied"
                );
            }
        }
        FillResult::Miss { reason } => {
            state.portfolio.record_miss();
            info!(
                side = %trade.side,
                reason = ?reason,
                first_trade = is_first_trade,
                "trade missed"
            );
        }
    }

    // Log the simulated fill event
    let fill_event = NormalizedEvent::SimulatedFill {
        wallet_trade_ref: trade.tx_hash,
        our_side: trade.side,
        fill_result: output.result,
        avg_price: output.avg_price,
        filled_qty: output.filled_qty,
        fee_rate: output.fee_rate_bps,
        fee_amount: output.fee_amount,
        fee_source: output.fee_source,
        slippage_bps: output.slippage_bps,
        latency: output.latency,
        book_quality: output.book_quality,
        exit_actionability: output.exit_actionability,
    };
    if let Ok(id) = store.append_event(&state.session_id, &fill_event) {
        state.last_event_id = id;
    }
}

fn save_snapshot(state: &EngineState, store: &Store) {
    match state.portfolio.to_json() {
        Ok(json) => {
            if let Err(e) =
                store.save_snapshot(&state.session_id, state.last_event_id, &json)
            {
                warn!(error = %e, "failed to save snapshot");
            }
        }
        Err(e) => {
            warn!(error = %e, "failed to serialize portfolio for snapshot");
        }
    }
}

fn format_elapsed(d: std::time::Duration) -> String {
    let secs = d.as_secs();
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    if h > 0 {
        format!("{h}h{m:02}m{s:02}s")
    } else if m > 0 {
        format!("{m}m{s:02}s")
    } else {
        format!("{s}s")
    }
}

fn print_status(state: &EngineState) {
    let p = &state.portfolio;
    let mode = state.config.session.marking_mode;
    let unrealized = p.unrealized_pnl(&state.books, mode);
    let account_val = p.account_value(&state.books, mode);
    let elapsed = format_elapsed(state.started_at.elapsed());

    let dir_cycle_ms = state
        .latest_dir_cycle
        .as_ref()
        .map(|m| m.cycle_duration.as_millis() as u64);
    let arb_cycle_ms = state
        .latest_arb_cycle
        .as_ref()
        .map(|m| m.cycle_duration.as_millis() as u64);

    info!(
        elapsed = %elapsed,
        cash = %p.cash,
        positions = p.positions.len(),
        books = state.books.len(),
        trades_seen = state.wallet_trades_seen,
        realized_net = %p.realized_pnl_net(),
        unrealized = %unrealized,
        account_value = %account_val,
        fills = p.fill_count,
        partials = p.partial_fill_count,
        misses = p.miss_count,
        first_captures = state.first_trade_captures,
        first_misses = state.first_trade_misses,
        dir_cycle_ms = ?dir_cycle_ms,
        arb_cycle_ms = ?arb_cycle_ms,
        "status"
    );
}

fn print_final_summary(state: &EngineState) {
    let p = &state.portfolio;
    let mode = state.config.session.marking_mode;
    let unrealized = p.unrealized_pnl(&state.books, mode);
    let account_val = p.account_value(&state.books, mode);
    let net = p.net_pnl(&state.books, mode);
    let elapsed = format_elapsed(state.started_at.elapsed());

    let first_total = state.first_trade_captures + state.first_trade_misses;
    let first_capture_pct = if first_total > 0 {
        (state.first_trade_captures as f64 / first_total as f64) * 100.0
    } else {
        0.0
    };

    println!();
    println!("=== Session Complete: {} ({elapsed}) ===", state.session_id);
    println!();
    println!("Portfolio:");
    println!("  Starting capital:  ${:.2}", p.starting_capital);
    println!("  Account value:     ${:.2}", account_val);
    println!("  Cash:              ${:.2}", p.cash);
    println!("  Open positions:    {}", p.positions.len());
    println!();
    println!("PnL (marking: {mode}):");
    println!("  Realized gross:    ${:.4}", p.realized_pnl_gross);
    println!("  Realized fees:     ${:.4}", p.realized_fees);
    println!("  Realized net:      ${:.4}", p.realized_pnl_net());
    println!("  Unrealized:        ${:.4}", unrealized);
    println!("  Net PnL:           ${:.4}", net);
    println!();
    println!("Fill Stats:");
    println!("  Trades detected:   {}", state.wallet_trades_seen);
    println!("  Full fills:        {}", p.fill_count);
    println!("  Partial fills:     {}", p.partial_fill_count);
    println!("  Misses:            {}", p.miss_count);
    println!("  Degraded fills:    {}", p.degraded_fill_count);
    println!("  Turnover:          ${:.2}", p.turnover);
    println!();
    println!("First-Trade Capture:");
    println!("  Books pre-warmed:  {}", state.book_warmups);
    println!("  First captures:    {}", state.first_trade_captures);
    println!("  First misses:      {}", state.first_trade_misses);
    println!("  Capture rate:      {first_capture_pct:.0}%");
    println!();
    println!("Scan Cycle Latency:");
    if let Some(ref m) = state.latest_dir_cycle {
        println!(
            "  Directional:       {}ms ({} wallets)",
            m.cycle_duration.as_millis(),
            m.wallet_count
        );
    }
    if let Some(ref m) = state.latest_arb_cycle {
        println!(
            "  Arbitrage:         {}ms ({} wallets)",
            m.cycle_duration.as_millis(),
            m.wallet_count
        );
    }
    println!("  Books tracked:     {}", state.books.len());
    println!();

    if net > Decimal::ZERO {
        println!("  Result: WIN (+${:.4})", net);
    } else if net < Decimal::ZERO {
        println!("  Result: LOSS (${:.4})", net);
    } else {
        println!("  Result: FLAT");
    }
    println!();
}

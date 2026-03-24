use std::path::PathBuf;
use std::sync::Arc;

use rust_decimal::Decimal;
use tracing::info;

use crate::config::schema::AppConfig;
use crate::config::wallets;
use crate::core::types::{PollingMode, WalletCategory};
use crate::sim::engine;
use crate::storage::db::Store;

pub async fn execute(config_path: &PathBuf, capital_override: Option<Decimal>) {
    let mut config = match AppConfig::load(config_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    };

    if let Some(capital) = capital_override {
        config.session.starting_capital = capital;
    }

    let loaded_wallets = match wallets::load_wallets(
        &config.wallets.directional_file,
        &config.wallets.arbitrage_file,
    ) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("error loading wallets: {e}");
            std::process::exit(1);
        }
    };

    let directional_count = loaded_wallets
        .iter()
        .filter(|w| w.category == WalletCategory::Directional)
        .count();
    let arbitrage_count = loaded_wallets
        .iter()
        .filter(|w| w.category == WalletCategory::Arbitrage)
        .count();

    // Compute effective polling intervals
    let dir_interval_ms = config.latency.directional_interval_ms.unwrap_or(
        match config.latency.polling_mode {
            PollingMode::Baseline => 3000,
            PollingMode::Aggressive => 1500,
        },
    );
    let arb_interval_ms = config.latency.arbitrage_interval_ms.unwrap_or(
        match config.latency.polling_mode {
            PollingMode::Baseline => 5000,
            PollingMode::Aggressive => 3000,
        },
    );

    println!("df — Polymarket paper-trading copy engine");
    println!();
    println!(
        "  Capital: ${:.2}  |  Max position: {:.0}%  |  Max slippage: {} bps",
        config.session.starting_capital,
        config.session.max_position_fraction * Decimal::new(100, 0),
        config.session.max_slippage_bps,
    );
    println!(
        "  Wallets: {} directional + {} arbitrage  |  Fee policy: {}",
        directional_count, arbitrage_count, config.fees.unavailable_policy,
    );
    println!(
        "  Polling: dir {}ms / arb {}ms (concurrent)  |  Arrival delay: {}ms",
        dir_interval_ms, arb_interval_ms, config.latency.arrival_delay_ms,
    );
    println!(
        "  DB: {}  |  Marking: {}",
        config.storage.db_path.display(),
        config.session.marking_mode,
    );
    println!();

    info!(
        wallets = loaded_wallets.len(),
        capital = %config.session.starting_capital,
        dir_interval_ms,
        arb_interval_ms,
        fee_policy = %config.fees.unavailable_policy,
        "session ready to start"
    );

    // Open storage
    let store = match Store::open(&config.storage.db_path) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("error opening database: {e}");
            std::process::exit(1);
        }
    };

    // Run the engine
    if let Err(e) = engine::run_session(config, loaded_wallets, store).await {
        eprintln!("engine error: {e}");
        std::process::exit(1);
    }
}

//! Terminal UI for the live engine session.
//!
//! Uses crossterm for cursor control to maintain a persistent stats header
//! at the top while trades scroll below it. The header redraws in place
//! every 5 seconds without cluttering the trade feed.

use std::io::{self, Write};

use crossterm::{cursor, execute, terminal};
use rust_decimal::Decimal;

use crate::core::types::*;

// ANSI colors
const GREEN: &str = "\x1b[32m";
const RED: &str = "\x1b[31m";
const YELLOW: &str = "\x1b[33m";
const CYAN: &str = "\x1b[36m";
const DIM: &str = "\x1b[2m";
const BOLD: &str = "\x1b[1m";
const RESET: &str = "\x1b[0m";

/// Number of lines the stats header occupies (including borders).
const HEADER_LINES: u16 = 7;

/// Shared state for the TUI — updated by the engine, read by the renderer.
#[allow(dead_code)]
pub struct TuiState {
    pub initialized: bool,
    pub trade_feed: Vec<String>,
    pub max_feed_lines: usize,
}

impl TuiState {
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self {
            initialized: false,
            trade_feed: Vec::new(),
            max_feed_lines: 200,
        }
    }
}

/// Snapshot of engine state for rendering. Avoids borrowing EngineState directly.
pub struct RenderSnapshot {
    pub elapsed: String,
    pub net_pnl: Decimal,
    pub realized_net: Decimal,
    pub unrealized: Decimal,
    pub fees: Decimal,
    pub cash: Decimal,
    pub account_value: Decimal,
    pub fill_rate: f64,
    pub positions: usize,
    pub books: usize,
    pub dir_fills: u64,
    pub dir_misses: u64,
    pub dir_lag: Option<f64>,
    pub dir_realized_net: Decimal,
    pub dir_unrealized: Decimal,
    pub arb_fills: u64,
    pub arb_misses: u64,
    pub arb_lag: Option<f64>,
    pub arb_realized_net: Decimal,
    pub arb_unrealized: Decimal,
    pub trades_seen: u64,
}

fn color_pnl(v: Decimal) -> String {
    if v > Decimal::ZERO {
        format!("{GREEN}+${v:.2}{RESET}")
    } else if v < Decimal::ZERO {
        format!("{RED}-${:.2}{RESET}", v.abs())
    } else {
        format!("{DIM}$0.00{RESET}")
    }
}

/// Print the initial header frame. Called once at startup.
pub fn print_header(snap: &RenderSnapshot) {
    let mut out = io::stdout();

    // Print the header block
    render_header_block(&mut out, snap);

    // Separator
    println!("{DIM}  ────────────────────────────────────────────────────────────────────────────────{RESET}");
    println!();

    let _ = out.flush();
}

/// Redraw the header in place using cursor movement.
pub fn update_header(snap: &RenderSnapshot) {
    let mut out = io::stdout();

    // Move cursor up to the header start
    let _ = execute!(out, cursor::MoveUp(HEADER_LINES + 2)); // +2 for separator + blank line
    let _ = execute!(out, cursor::MoveToColumn(0));

    // Clear and redraw each header line
    render_header_block(&mut out, snap);

    // Redraw separator
    println!("{DIM}  ────────────────────────────────────────────────────────────────────────────────{RESET}");
    println!();

    let _ = out.flush();
}

fn render_header_block(out: &mut impl Write, s: &RenderSnapshot) {
    // Line 1: Title bar with PnL
    let verdict = if s.realized_net < Decimal::ZERO && s.net_pnl > Decimal::ZERO {
        format!("{YELLOW}{BOLD}UNREALIZED{RESET}")
    } else if s.net_pnl > Decimal::ZERO {
        format!("{GREEN}{BOLD}PROFIT{RESET}")
    } else if s.net_pnl < Decimal::ZERO {
        format!("{RED}{BOLD}LOSS{RESET}")
    } else {
        format!("{DIM}FLAT{RESET}")
    };

    let _ = execute!(out, terminal::Clear(terminal::ClearType::CurrentLine));
    println!("  {BOLD}{CYAN}df{RESET}  {DIM}[{}]{RESET}  Net: {}  {verdict}                                              ",
        s.elapsed, color_pnl(s.net_pnl));

    // Line 2: PnL breakdown
    let _ = execute!(out, terminal::Clear(terminal::ClearType::CurrentLine));
    println!("  {DIM}realized={RESET}{}  {DIM}unrealized={RESET}{}  {DIM}fees={RESET}{RED}${:.2}{RESET}                          ",
        color_pnl(s.realized_net), color_pnl(s.unrealized), s.fees);

    // Line 3: Portfolio + fill stats
    let fill_color = if s.fill_rate >= 50.0 { GREEN } else if s.fill_rate >= 25.0 { YELLOW } else { RED };
    let _ = execute!(out, terminal::Clear(terminal::ClearType::CurrentLine));
    println!("  {DIM}account={RESET}{BOLD}${:.0}{RESET}  {DIM}cash={RESET}${:.0}  {DIM}fill={RESET}{fill_color}{BOLD}{:.0}%{RESET}  {DIM}pos={RESET}{BOLD}{}{RESET}  {DIM}books={RESET}{}  {DIM}trades={RESET}{}                  ",
        s.account_value, s.cash, s.fill_rate, s.positions, s.books, s.trades_seen);

    // Line 4: blank separator
    let _ = execute!(out, terminal::Clear(terminal::ClearType::CurrentLine));
    println!();

    // Line 5: Directional with PnL
    let dir_lag = s.dir_lag.map(|v| format!(" {DIM}lag={:.0}s{RESET}", v / 1000.0)).unwrap_or_default();
    let dir_total_pnl = s.dir_realized_net + s.dir_unrealized;
    let _ = execute!(out, terminal::Clear(terminal::ClearType::CurrentLine));
    println!("  {CYAN}{BOLD}directional{RESET}  {}  {DIM}(real={} unreal={}){RESET}  {GREEN}{}{RESET}f/{RED}{}{RESET}m{dir_lag}                     ",
        color_pnl(dir_total_pnl), color_pnl(s.dir_realized_net), color_pnl(s.dir_unrealized),
        s.dir_fills, s.dir_misses);

    // Line 6: Arbitrage with PnL
    let arb_lag = s.arb_lag.map(|v| format!(" {DIM}lag={:.0}s{RESET}", v / 1000.0)).unwrap_or_default();
    let arb_total_pnl = s.arb_realized_net + s.arb_unrealized;
    let _ = execute!(out, terminal::Clear(terminal::ClearType::CurrentLine));
    println!("  {YELLOW}{BOLD}arbitrage{RESET}    {}  {DIM}(real={} unreal={}){RESET}  {GREEN}{}{RESET}f/{RED}{}{RESET}m{arb_lag}                     ",
        color_pnl(arb_total_pnl), color_pnl(s.arb_realized_net), color_pnl(s.arb_unrealized),
        s.arb_fills, s.arb_misses);

    // Line 7: blank
    let _ = execute!(out, terminal::Clear(terminal::ClearType::CurrentLine));
    println!();
}

/// Format a trade event as a compact colored line for the feed.
pub fn format_trade_line(
    result: &FillResult,
    side: Side,
    wallet_name: &str,
    market_name: &str,
    avg_price: Option<Decimal>,
    filled_qty: Decimal,
    fee_amount: Decimal,
    detection_delay_ms: Option<u64>,
) -> String {
    let side_str = match side {
        Side::Buy => format!("{GREEN}BUY{RESET}"),
        Side::Sell => format!("{RED}SELL{RESET}"),
    };

    let (result_str, detail_str) = match result {
        FillResult::Full => {
            let price = avg_price.unwrap_or(Decimal::ZERO);
            (
                format!("{GREEN}FILL{RESET}"),
                format!("{filled_qty}@${price:.3} {DIM}fee=${fee_amount:.4}{RESET}"),
            )
        }
        FillResult::Partial { filled_qty: qty } => {
            let price = avg_price.unwrap_or(Decimal::ZERO);
            (
                format!("{YELLOW}PART{RESET}"),
                format!("{qty}@${price:.3}"),
            )
        }
        FillResult::Miss { reason } => {
            (
                format!("{RED}MISS{RESET}"),
                format!("{DIM}{reason:?}{RESET}"),
            )
        }
    };

    let lag = detection_delay_ms
        .map(|d| if d >= 1000 { format!(" {DIM}{:.0}s{RESET}", d as f64 / 1000.0) }
             else { format!(" {DIM}{}ms{RESET}", d) })
        .unwrap_or_default();

    // Truncate market name for compact display
    let market_short = if market_name.len() > 45 {
        format!("{}...", &market_name[..42])
    } else {
        market_name.to_string()
    };

    format!("    {result_str} {side_str} {wallet_name:<10} {detail_str}  {DIM}{market_short}{RESET}{lag}")
}

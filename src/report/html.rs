use std::fmt::Write as FmtWrite;
use std::fs;
use std::path::Path;

use rust_decimal::Decimal;

use super::analytics::SessionAnalytics;

/// Generate a self-contained HTML report and write it to disk.
pub fn generate_html_report(
    analytics: &SessionAnalytics,
    output_path: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let html = render_html(analytics);
    fs::write(output_path, html)?;
    Ok(())
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn render_html(a: &SessionAnalytics) -> String {
    let mut html = String::with_capacity(16 * 1024);

    let result_class = if a.realized_pnl_net > Decimal::ZERO {
        "win"
    } else if a.realized_pnl_net < Decimal::ZERO {
        "loss"
    } else {
        "flat"
    };

    let _ = write!(
        html,
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>df Session Report — {session_id}</title>
<style>
:root {{ --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #c9d1d9; --muted: #8b949e;
  --green: #3fb950; --red: #f85149; --blue: #58a6ff; --yellow: #d29922; }}
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
body {{ background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; padding: 24px; max-width: 1200px; margin: 0 auto; }}
h1 {{ font-size: 24px; margin-bottom: 4px; }}
h2 {{ font-size: 18px; margin: 24px 0 12px; color: var(--blue); border-bottom: 1px solid var(--border); padding-bottom: 6px; }}
h3 {{ font-size: 15px; margin: 16px 0 8px; color: var(--muted); }}
.subtitle {{ color: var(--muted); margin-bottom: 24px; }}
.grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 24px; }}
.card {{ background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 16px; }}
.card .label {{ color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }}
.card .value {{ font-size: 24px; font-weight: 600; margin-top: 4px; }}
.win {{ color: var(--green); }}
.loss {{ color: var(--red); }}
.flat {{ color: var(--muted); }}
table {{ width: 100%; border-collapse: collapse; margin-bottom: 16px; background: var(--card); border-radius: 6px; overflow: hidden; }}
th {{ text-align: left; padding: 8px 12px; background: var(--border); color: var(--text); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }}
td {{ padding: 8px 12px; border-top: 1px solid var(--border); font-size: 13px; }}
tr:hover td {{ background: rgba(88,166,255,0.04); }}
.tag {{ display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }}
.tag-full {{ background: rgba(63,185,80,0.15); color: var(--green); }}
.tag-partial {{ background: rgba(210,153,34,0.15); color: var(--yellow); }}
.tag-miss {{ background: rgba(248,81,73,0.15); color: var(--red); }}
.tag-buy {{ background: rgba(63,185,80,0.15); color: var(--green); }}
.tag-sell {{ background: rgba(248,81,73,0.15); color: var(--red); }}
.mono {{ font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; }}
footer {{ margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; text-align: center; }}
</style>
</head>
<body>
<h1>df Session Report</h1>
<p class="subtitle">Session: {session_id}{time_range}</p>
"#,
        session_id = a.session_id,
        time_range = match (&a.first_event_ts, &a.last_event_ts) {
            (Some(first), Some(last)) => {
                let duration = *last - *first;
                let hours = duration.num_hours();
                let mins = duration.num_minutes() % 60;
                format!(" &mdash; {}h{:02}m", hours, mins)
            }
            _ => String::new(),
        },
    );

    // Summary cards
    let _ = write!(
        html,
        r#"<h2>Summary</h2>
<div class="grid">
<div class="card">
  <div class="label">Starting Capital</div>
  <div class="value">${starting:.2}</div>
</div>
<div class="card">
  <div class="label">Realized PnL (Net)</div>
  <div class="value {result_class}">${net:.4}</div>
</div>
<div class="card">
  <div class="label">Realized Fees</div>
  <div class="value">${fees:.4}</div>
</div>
<div class="card">
  <div class="label">Fill Rate</div>
  <div class="value">{fill_rate}%</div>
</div>
<div class="card">
  <div class="label">Total Trades Detected</div>
  <div class="value">{trades}</div>
</div>
<div class="card">
  <div class="label">Turnover</div>
  <div class="value">${turnover:.2}</div>
</div>
</div>
"#,
        starting = a.starting_capital,
        result_class = result_class,
        net = a.realized_pnl_net,
        fees = a.realized_fees,
        fill_rate = a.fill_rate_pct,
        trades = a.total_wallet_trades,
        turnover = a.turnover,
    );

    // Fill breakdown
    let _ = write!(
        html,
        r#"<h2>Fill Breakdown</h2>
<div class="grid">
<div class="card">
  <div class="label">Full Fills</div>
  <div class="value win">{fills}</div>
</div>
<div class="card">
  <div class="label">Partial Fills</div>
  <div class="value" style="color:var(--yellow)">{partials}</div>
</div>
<div class="card">
  <div class="label">Misses</div>
  <div class="value loss">{misses}</div>
</div>
<div class="card">
  <div class="label">Degraded</div>
  <div class="value" style="color:var(--yellow)">{degraded}</div>
</div>
</div>
"#,
        fills = a.total_fills,
        partials = a.total_partials,
        misses = a.total_misses,
        degraded = a.degraded_fill_count,
    );

    // Latency
    let _ = write!(html, r#"<h2>Latency</h2><div class="grid">"#);
    if let Some(avg) = a.avg_detection_delay_ms {
        let _ = write!(
            html,
            r#"<div class="card"><div class="label">Avg Detection Delay</div><div class="value">{avg:.0}ms</div></div>"#,
        );
    }
    if let Some(median) = a.median_detection_delay_ms {
        let _ = write!(
            html,
            r#"<div class="card"><div class="label">Median Detection Delay</div><div class="value">{median}ms</div></div>"#,
        );
    }
    if let Some(avg) = a.avg_processing_delay_ms {
        let _ = write!(
            html,
            r#"<div class="card"><div class="label">Avg Processing Delay</div><div class="value">{avg:.1}ms</div></div>"#,
        );
    }
    let _ = write!(html, "</div>");

    // Miss reasons
    if !a.miss_reasons.is_empty() {
        let _ = write!(
            html,
            r#"<h2>Miss Reasons</h2><table><tr><th>Reason</th><th>Count</th></tr>"#
        );
        let mut sorted: Vec<_> = a.miss_reasons.iter().collect();
        sorted.sort_by(|a, b| b.1.cmp(a.1));
        for (reason, count) in sorted {
            let _ = write!(html, "<tr><td>{reason}</td><td>{count}</td></tr>");
        }
        let _ = write!(html, "</table>");
    }

    // Book quality at fill time
    if !a.book_quality_counts.is_empty() {
        let _ = write!(
            html,
            r#"<h2>Book Quality at Fill Time</h2><table><tr><th>Quality</th><th>Count</th></tr>"#
        );
        let mut sorted: Vec<_> = a.book_quality_counts.iter().collect();
        sorted.sort_by(|a, b| b.1.cmp(a.1));
        for (quality, count) in sorted {
            let _ = write!(html, "<tr><td>{quality}</td><td>{count}</td></tr>");
        }
        let _ = write!(html, "</table>");
    }

    // Fee sources
    if !a.fee_source_counts.is_empty() {
        let _ = write!(
            html,
            r#"<h2>Fee Source Breakdown</h2><table><tr><th>Source</th><th>Count</th></tr>"#
        );
        for (source, count) in &a.fee_source_counts {
            let _ = write!(html, "<tr><td>{source}</td><td>{count}</td></tr>");
        }
        let _ = write!(html, "</table>");
    }

    // Per-wallet stats
    if !a.wallet_stats.is_empty() {
        let _ = write!(
            html,
            r#"<h2>Per-Wallet Stats</h2>
<table>
<tr><th>Wallet</th><th>Category</th><th>Trades</th><th>Fills</th><th>Misses</th></tr>"#
        );
        for w in &a.wallet_stats {
            let addr_short = if w.wallet.len() > 10 {
                format!("{}…{}", &w.wallet[..6], &w.wallet[w.wallet.len() - 4..])
            } else {
                w.wallet.clone()
            };
            let _ = write!(
                html,
                r#"<tr><td class="mono" title="{full}">{short}</td><td>{cat}</td><td>{trades}</td><td>{fills}</td><td>{misses}</td></tr>"#,
                full = w.wallet,
                short = addr_short,
                cat = w.category,
                trades = w.trade_count,
                fills = w.fill_count,
                misses = w.miss_count,
            );
        }
        let _ = write!(html, "</table>");
    }

    // Per-token stats
    if !a.token_stats.is_empty() {
        let _ = write!(
            html,
            r#"<h2>Per-Token Stats</h2>
<table>
<tr><th>Market</th><th>Outcome</th><th>Buys</th><th>Sells</th><th>Volume</th><th>Realized PnL</th></tr>"#
        );
        for t in &a.token_stats {
            let market_label = t.market_question.as_deref().unwrap_or_else(|| {
                if t.token_id.len() > 16 { &t.token_id[..16] } else { &t.token_id }
            });
            let outcome_label = t.outcome_label.as_deref().unwrap_or("—");
            let pnl_class = if t.realized_pnl > Decimal::ZERO {
                "win"
            } else if t.realized_pnl < Decimal::ZERO {
                "loss"
            } else {
                ""
            };
            let _ = write!(
                html,
                r#"<tr><td title="{full}">{market}</td><td>{outcome}</td><td>{buys}</td><td>{sells}</td><td>${vol:.2}</td><td class="{pnl_class}">${pnl:.4}</td></tr>"#,
                full = t.token_id,
                market = html_escape(market_label),
                outcome = outcome_label,
                buys = t.buy_count,
                sells = t.sell_count,
                vol = t.total_volume,
                pnl_class = pnl_class,
                pnl = t.realized_pnl,
            );
        }
        let _ = write!(html, "</table>");
    }

    // Trade log
    if !a.trades.is_empty() {
        let _ = write!(
            html,
            r#"<h2>Trade Log</h2>
<table>
<tr><th>Time</th><th>Wallet</th><th>Side</th><th>Market</th><th>Wallet Price</th><th>Our Price</th><th>Qty</th><th>Fee</th><th>Slippage</th><th>Detection</th><th>Result</th></tr>"#
        );
        for t in &a.trades {
            let addr_short = if t.wallet.len() > 10 {
                format!("{}…{}", &t.wallet[..6], &t.wallet[t.wallet.len() - 4..])
            } else {
                t.wallet.clone()
            };
            let market_label = match (&t.market_question, &t.outcome_label) {
                (Some(q), Some(o)) => {
                    let q_short = if q.len() > 40 { format!("{}…", &q[..40]) } else { q.clone() };
                    format!("{q_short} ({o})")
                }
                _ => {
                    if t.token_id.len() > 12 {
                        format!("{}…", &t.token_id[..12])
                    } else {
                        t.token_id.clone()
                    }
                }
            };
            let side_class = match t.side {
                crate::core::types::Side::Buy => "tag-buy",
                crate::core::types::Side::Sell => "tag-sell",
            };
            let result_class = match t.fill_result.as_str() {
                "full" => "tag-full",
                "partial" => "tag-partial",
                _ => "tag-miss",
            };
            let our_price_str = t
                .our_price
                .map(|p| format!("${p:.4}"))
                .unwrap_or_else(|| "—".into());
            let slippage_str = t
                .slippage_bps
                .map(|s| format!("{s}bps"))
                .unwrap_or_else(|| "—".into());
            let detection_str = t
                .detection_delay_ms
                .map(|d| format!("{d}ms"))
                .unwrap_or_else(|| "—".into());

            let _ = write!(
                html,
                r#"<tr>
<td class="mono">{ts}</td>
<td class="mono" title="{wallet_full}">{wallet_short}</td>
<td><span class="tag {side_class}">{side}</span></td>
<td title="{token_full}">{market_label}</td>
<td>${wprice:.4}</td>
<td>{our_price}</td>
<td>{qty}</td>
<td>${fee:.4}</td>
<td>{slippage}</td>
<td>{detection}</td>
<td><span class="tag {result_class}">{result}</span></td>
</tr>"#,
                ts = t.ts.format("%H:%M:%S"),
                wallet_full = t.wallet,
                wallet_short = addr_short,
                side_class = side_class,
                side = t.side,
                token_full = t.token_id,
                market_label = html_escape(&market_label),
                wprice = t.wallet_price,
                our_price = our_price_str,
                qty = t.our_qty,
                fee = t.fee_amount,
                slippage = slippage_str,
                detection = detection_str,
                result_class = result_class,
                result = t.fill_result,
            );
        }
        let _ = write!(html, "</table>");
    }

    // Footer
    let _ = write!(
        html,
        r#"
<footer>Generated by df — Polymarket paper-trading copy engine</footer>
</body>
</html>"#
    );

    html
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::report::analytics::SessionAnalytics;
    use rust_decimal_macros::dec;
    use std::collections::HashMap;

    #[test]
    fn render_html_produces_valid_structure() {
        let a = SessionAnalytics {
            session_id: "test-session".into(),
            starting_capital: dec!(10000),
            total_events: 0,
            total_wallet_trades: 0,
            total_fills: 0,
            total_partials: 0,
            total_misses: 0,
            fill_rate_pct: dec!(0),
            realized_pnl_gross: dec!(0),
            realized_fees: dec!(0),
            realized_pnl_net: dec!(0),
            turnover: dec!(0),
            wallet_stats: vec![],
            token_stats: vec![
                crate::report::analytics::TokenStats {
                    token_id: "12345".into(),
                    market_question: Some("Will it rain?".into()),
                    outcome_label: Some("Yes".into()),
                    buy_count: 1,
                    sell_count: 0,
                    total_volume: dec!(50),
                    realized_pnl: dec!(0),
                },
            ],
            miss_reasons: HashMap::new(),
            avg_detection_delay_ms: Some(2500.0),
            avg_processing_delay_ms: Some(1.5),
            median_detection_delay_ms: Some(2000),
            fee_source_counts: HashMap::new(),
            degraded_fill_count: 0,
            book_quality_counts: HashMap::new(),
            trades: vec![],
            first_event_ts: None,
            last_event_ts: None,
        };
        let html = render_html(&a);
        assert!(html.contains("<!DOCTYPE html>"));
        assert!(html.contains("test-session"));
        assert!(html.contains("Will it rain?"));
        assert!(html.contains("Yes"));
        assert!(html.contains("2500"));
        assert!(html.contains("</html>"));
    }
}

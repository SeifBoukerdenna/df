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

fn pnl_class(v: Decimal) -> &'static str {
    if v > Decimal::ZERO { "win" } else if v < Decimal::ZERO { "loss" } else { "flat" }
}

fn fmt_pnl(v: Decimal) -> String {
    if v >= Decimal::ZERO {
        format!("+${v:.4}")
    } else {
        format!("-${:.4}", v.abs())
    }
}

fn render_html(a: &SessionAnalytics) -> String {
    let mut html = String::with_capacity(32 * 1024);

    let duration_str = match (&a.first_event_ts, &a.last_event_ts) {
        (Some(first), Some(last)) => {
            let d = *last - *first;
            let h = d.num_hours();
            let m = d.num_minutes() % 60;
            format!("{}h{:02}m", h, m)
        }
        _ => "—".into(),
    };

    // Determine honest verdict
    let is_misleading = a.realized_pnl_net < Decimal::ZERO;

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
  --green: #3fb950; --red: #f85149; --blue: #58a6ff; --yellow: #d29922; --orange: #db6d28; }}
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
body {{ background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; padding: 24px; max-width: 1400px; margin: 0 auto; }}
h1 {{ font-size: 24px; margin-bottom: 4px; }}
h2 {{ font-size: 18px; margin: 32px 0 12px; color: var(--blue); border-bottom: 1px solid var(--border); padding-bottom: 6px; }}
.subtitle {{ color: var(--muted); margin-bottom: 16px; }}
.grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }}
.grid-2 {{ display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }}
.card {{ background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 16px; }}
.card .label {{ color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }}
.card .value {{ font-size: 22px; font-weight: 600; margin-top: 2px; }}
.card .sub {{ color: var(--muted); font-size: 12px; margin-top: 2px; }}
.win {{ color: var(--green); }}
.loss {{ color: var(--red); }}
.flat {{ color: var(--muted); }}
.banner {{ padding: 12px 16px; border-radius: 6px; margin-bottom: 20px; font-size: 13px; }}
.banner-warn {{ background: rgba(219,109,40,0.12); border: 1px solid var(--orange); color: var(--orange); }}
.banner-ok {{ background: rgba(63,185,80,0.08); border: 1px solid var(--green); color: var(--green); }}
table {{ width: 100%; border-collapse: collapse; margin-bottom: 16px; background: var(--card); border-radius: 6px; overflow: hidden; }}
th {{ text-align: left; padding: 8px 12px; background: var(--border); color: var(--text); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }}
td {{ padding: 6px 12px; border-top: 1px solid var(--border); font-size: 13px; }}
tr:hover td {{ background: rgba(88,166,255,0.04); }}
.tag {{ display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }}
.tag-full {{ background: rgba(63,185,80,0.15); color: var(--green); }}
.tag-partial {{ background: rgba(210,153,34,0.15); color: var(--yellow); }}
.tag-miss {{ background: rgba(248,81,73,0.15); color: var(--red); }}
.tag-buy {{ background: rgba(63,185,80,0.15); color: var(--green); }}
.tag-sell {{ background: rgba(248,81,73,0.15); color: var(--red); }}
.tag-dir {{ background: rgba(88,166,255,0.15); color: var(--blue); }}
.tag-arb {{ background: rgba(210,153,34,0.15); color: var(--yellow); }}
.mono {{ font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; }}
.right {{ text-align: right; }}
.top-row td {{ border-left: 3px solid var(--green); }}
footer {{ margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; text-align: center; }}
</style>
</head>
<body>
<h1>df Session Report</h1>
<p class="subtitle">Session: {session_id} &mdash; Duration: {duration}</p>
"#,
        session_id = a.session_id,
        duration = duration_str,
    );

    // === TRUTHFULNESS BANNER ===
    if is_misleading {
        let _ = write!(
            html,
            r#"<div class="banner banner-warn">
Realized PnL is negative ({realized}). The positive net figure includes unrealized mark-to-market gains on {positions} open positions. These gains require successful exits and are not confirmed profit.
</div>"#,
            realized = fmt_pnl(a.realized_pnl_net),
            positions = a.total_fills.saturating_sub(a.total_partials), // rough open count
        );
    } else if a.realized_pnl_net > Decimal::ZERO {
        let _ = write!(
            html,
            r#"<div class="banner banner-ok">Realized PnL is positive ({realized}). This session has confirmed profit from closed trades.</div>"#,
            realized = fmt_pnl(a.realized_pnl_net),
        );
    }

    // === VERDICT CARDS ===
    let unrealized_str = a.unrealized_pnl_after_fees
        .map(|v| fmt_pnl(v))
        .unwrap_or_else(|| "N/A (cold report)".into());
    let unrealized_class = a.unrealized_pnl_after_fees
        .map(|v| pnl_class(v))
        .unwrap_or("flat");
    let unrealized_sub = match (a.unrealized_pnl, a.unrealized_pnl_after_fees) {
        (Some(raw), Some(after)) => {
            let exit_fees = raw - after;
            format!("Raw: {} | Est. exit fees: ${exit_fees:.4}", fmt_pnl(raw))
        }
        _ => "No live book state available".into(),
    };
    let net_str = a.net_pnl.map(|v| fmt_pnl(v)).unwrap_or_else(|| "N/A".into());
    let net_class = a.net_pnl.map(|v| pnl_class(v)).unwrap_or("flat");

    let _ = write!(
        html,
        r#"<h2>Verdict</h2>
<div class="grid">
<div class="card">
  <div class="label">Net PnL (after est. exit fees)</div>
  <div class="value {nc}">{net}</div>
  <div class="sub">Realized + Unrealized after fees</div>
</div>
<div class="card">
  <div class="label">Realized PnL (Net)</div>
  <div class="value {rc}">{realized}</div>
  <div class="sub">Gross: ${rg:.4} | Fees: ${rf:.4}</div>
</div>
<div class="card">
  <div class="label">Unrealized PnL (after exit fees)</div>
  <div class="value {uc}">{unrealized}</div>
  <div class="sub">{unrealized_sub}</div>
</div>
<div class="card">
  <div class="label">Starting Capital</div>
  <div class="value">${starting:.2}</div>
</div>
<div class="card">
  <div class="label">Fill Rate</div>
  <div class="value">{fill_rate}%</div>
  <div class="sub">{fills}f + {partials}p / {total} total</div>
</div>
<div class="card">
  <div class="label">Turnover</div>
  <div class="value">${turnover:.2}</div>
  <div class="sub">{trades} trades detected, {misses} missed</div>
</div>
</div>
"#,
        nc = net_class,
        net = net_str,
        rc = pnl_class(a.realized_pnl_net),
        realized = fmt_pnl(a.realized_pnl_net),
        rg = a.realized_pnl_gross,
        rf = a.realized_fees,
        uc = unrealized_class,
        unrealized = unrealized_str,
        unrealized_sub = unrealized_sub,
        starting = a.starting_capital,
        fill_rate = a.fill_rate_pct,
        fills = a.total_fills,
        partials = a.total_partials,
        total = a.total_fills + a.total_partials + a.total_misses,
        trades = a.total_wallet_trades,
        misses = a.total_misses,
        turnover = a.turnover,
    );

    // Fee warning
    if a.realized_fees > Decimal::ZERO && a.realized_pnl_gross != Decimal::ZERO {
        let fee_ratio = a.realized_fees / a.realized_pnl_gross.abs();
        if fee_ratio > Decimal::new(5, 1) { // fees > 50% of gross
            let _ = write!(
                html,
                r#"<div class="banner banner-warn">Fees (${fees:.2}) are consuming {pct:.0}% of gross PnL (${gross:.2}). Fee drag is a major factor in this session.</div>"#,
                fees = a.realized_fees,
                pct = fee_ratio * Decimal::new(100, 0),
                gross = a.realized_pnl_gross.abs(),
            );
        }
    }

    // === CATEGORY BREAKDOWN === (sorted: directional first)
    if !a.category_stats.is_empty() {
        let mut sorted_cats = a.category_stats.clone();
        sorted_cats.sort_by_key(|c| match c.category {
            crate::core::types::WalletCategory::Directional => 0,
            crate::core::types::WalletCategory::Arbitrage => 1,
        });

        let _ = write!(html, r#"<h2>Category Breakdown</h2><div class="grid-2">"#);
        for cs in &sorted_cats {
            let cat_tag = match cs.category {
                crate::core::types::WalletCategory::Directional => "tag-dir",
                crate::core::types::WalletCategory::Arbitrage => "tag-arb",
            };
            let avg_lag = cs.avg_detection_delay_ms
                .map(|v| format!("{:.0}ms", v))
                .unwrap_or_else(|| "—".into());
            let median_lag = cs.median_detection_delay_ms
                .map(|v| format!("{v}ms"))
                .unwrap_or_else(|| "—".into());
            let _ = write!(
                html,
                r#"<div class="card">
  <div class="label"><span class="tag {cat_tag}">{cat}</span></div>
  <table style="margin-top:8px">
    <tr><td>Trades</td><td class="right">{trades}</td></tr>
    <tr><td>Fills / Misses</td><td class="right">{fills} / {misses}</td></tr>
    <tr><td>Fill Rate</td><td class="right">{fill_rate}%</td></tr>
    <tr><td>Realized Net</td><td class="right {nc}">{net}</td></tr>
    <tr><td>Volume</td><td class="right">${vol:.2}</td></tr>
    <tr><td>Fees Paid</td><td class="right">${fees:.4}</td></tr>
    <tr><td>Avg Detection Lag</td><td class="right">{avg_lag}</td></tr>
    <tr><td>Median Detection Lag</td><td class="right">{median_lag}</td></tr>
  </table>
</div>"#,
                cat_tag = cat_tag,
                cat = cs.category,
                trades = cs.trade_count,
                fills = cs.fill_count,
                misses = cs.miss_count,
                fill_rate = cs.fill_rate_pct,
                nc = pnl_class(cs.realized_pnl_net),
                net = fmt_pnl(cs.realized_pnl_net),
                vol = cs.volume,
                fees = cs.realized_fees,
            );
        }
        let _ = write!(html, "</div>");
    }

    // === WALLET LEADERBOARD ===
    if !a.wallet_stats.is_empty() {
        let mut sorted_wallets = a.wallet_stats.clone();
        sorted_wallets.sort_by(|a, b| b.realized_pnl.cmp(&a.realized_pnl));

        let _ = write!(
            html,
            r#"<h2>Wallet Leaderboard</h2>
<table>
<tr><th>Wallet</th><th>Category</th><th>Fill Rate</th><th>Fills/Misses</th><th class="right">Volume</th><th class="right">Fees</th><th class="right">Realized</th><th class="right">Unrealized</th><th class="right">Exposure</th></tr>"#
        );
        for (idx, w) in sorted_wallets.iter().enumerate() {
            let row_class = if idx < 3 { r#" class="top-row""# } else { "" };
            let cat_tag = match w.category {
                crate::core::types::WalletCategory::Directional => "tag-dir",
                crate::core::types::WalletCategory::Arbitrage => "tag-arb",
            };
            // Wallet name with optional profile link
            let name_html = match &w.profile_url {
                Some(url) => format!(
                    r#"<a href="{}" style="color:var(--blue);text-decoration:none" target="_blank">{}</a>"#,
                    html_escape(url),
                    html_escape(&w.display_name),
                ),
                None => html_escape(&w.display_name),
            };
            let _ = write!(
                html,
                r#"<tr{row_class}>
<td class="mono" title="{full}">{name_html}</td>
<td><span class="tag {cat_tag}">{cat}</span></td>
<td>{fill_rate}%</td>
<td>{fills}/{misses}</td>
<td class="right">${vol:.2}</td>
<td class="right">${fees:.4}</td>
<td class="right {pc}">{pnl}</td>
<td class="right {uc}">{unrealized}</td>
<td class="right">${exposure:.2}</td>
</tr>"#,
                full = w.wallet,
                name_html = name_html,
                cat_tag = cat_tag,
                cat = w.category,
                fill_rate = w.fill_rate_pct,
                fills = w.fill_count,
                misses = w.miss_count,
                vol = w.volume,
                fees = w.fees_paid,
                pc = pnl_class(w.realized_pnl),
                pnl = fmt_pnl(w.realized_pnl),
                uc = pnl_class(w.unrealized_pnl),
                unrealized = fmt_pnl(w.unrealized_pnl),
                exposure = w.open_exposure,
            );
        }
        let _ = write!(html, "</table>");
    }

    // === MISS REASONS ===
    if !a.miss_reasons.is_empty() {
        let _ = write!(
            html,
            r#"<h2>Miss Reasons</h2><table><tr><th>Reason</th><th class="right">Count</th><th class="right">%</th></tr>"#
        );
        let total_misses = a.total_misses.max(1);
        let mut sorted: Vec<_> = a.miss_reasons.iter().collect();
        sorted.sort_by(|a, b| b.1.cmp(a.1));
        for (reason, count) in sorted {
            let pct = (*count as f64 / total_misses as f64) * 100.0;
            let _ = write!(
                html,
                r#"<tr><td>{reason}</td><td class="right">{count}</td><td class="right">{pct:.0}%</td></tr>"#
            );
        }
        let _ = write!(html, "</table>");
    }

    // === LATENCY ===
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

    // === BOOK QUALITY ===
    if !a.book_quality_counts.is_empty() {
        let _ = write!(
            html,
            r#"<h2>Book Quality at Fill Time</h2><table><tr><th>Quality</th><th class="right">Count</th></tr>"#
        );
        let mut sorted: Vec<_> = a.book_quality_counts.iter().collect();
        sorted.sort_by(|a, b| b.1.cmp(a.1));
        for (quality, count) in sorted {
            let _ = write!(html, r#"<tr><td>{quality}</td><td class="right">{count}</td></tr>"#);
        }
        let _ = write!(html, "</table>");
    }

    // === FEE SOURCES ===
    if !a.fee_source_counts.is_empty() {
        let _ = write!(
            html,
            r#"<h2>Fee Source Breakdown</h2><table><tr><th>Source</th><th class="right">Count</th></tr>"#
        );
        for (source, count) in &a.fee_source_counts {
            let _ = write!(html, r#"<tr><td>{source}</td><td class="right">{count}</td></tr>"#);
        }
        let _ = write!(html, "</table>");
    }

    // === TOP MARKETS ===
    if !a.token_stats.is_empty() {
        let mut sorted_tokens = a.token_stats.clone();
        sorted_tokens.sort_by(|a, b| b.total_volume.cmp(&a.total_volume));
        let show_count = sorted_tokens.len().min(30);

        let _ = write!(
            html,
            r#"<h2>Top Markets (by volume)</h2>
<table>
<tr><th>Market</th><th>Outcome</th><th class="right">Buys</th><th class="right">Sells</th><th class="right">Volume</th><th class="right">Realized PnL</th></tr>"#
        );
        for t in &sorted_tokens[..show_count] {
            let market_label = t.market_question.as_deref().unwrap_or_else(|| {
                if t.token_id.len() > 16 { &t.token_id[..16] } else { &t.token_id }
            });
            let outcome_label = t.outcome_label.as_deref().unwrap_or("—");
            let _ = write!(
                html,
                r#"<tr><td title="{full}">{market}</td><td>{outcome}</td><td class="right">{buys}</td><td class="right">{sells}</td><td class="right">${vol:.2}</td><td class="right {pc}">{pnl}</td></tr>"#,
                full = t.token_id,
                market = html_escape(market_label),
                outcome = outcome_label,
                buys = t.buy_count,
                sells = t.sell_count,
                vol = t.total_volume,
                pc = pnl_class(t.realized_pnl),
                pnl = fmt_pnl(t.realized_pnl),
            );
        }
        let _ = write!(html, "</table>");
    }

    // === TRADE LOG ===
    if !a.trades.is_empty() {
        let show_count = a.trades.len().min(500);
        let _ = write!(
            html,
            r#"<h2>Trade Log ({showing} of {total})</h2>
<table>
<tr><th>Time</th><th>Wallet</th><th>Side</th><th>Market</th><th class="right">Wallet Price</th><th class="right">Our Price</th><th class="right">Qty</th><th class="right">Fee</th><th>Slippage</th><th>Detection</th><th>Result</th></tr>"#,
            showing = show_count,
            total = a.trades.len(),
        );
        for t in &a.trades[..show_count] {
            let market_label = match (&t.market_question, &t.outcome_label) {
                (Some(q), Some(o)) => {
                    let q_short = if q.len() > 35 { format!("{}…", &q[..35]) } else { q.clone() };
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
            let our_price_str = t.our_price
                .map(|p| format!("${p:.4}"))
                .unwrap_or_else(|| "—".into());
            let slippage_str = t.slippage_bps
                .map(|s| format!("{s}bps"))
                .unwrap_or_else(|| "—".into());
            let detection_str = t.detection_delay_ms
                .map(|d| {
                    if d >= 1000 { format!("{:.1}s", d as f64 / 1000.0) }
                    else { format!("{d}ms") }
                })
                .unwrap_or_else(|| "—".into());

            let _ = write!(
                html,
                r#"<tr>
<td class="mono">{ts}</td>
<td title="{wallet_full}">{wallet_name}</td>
<td><span class="tag {side_class}">{side}</span></td>
<td title="{token_full}">{market_label}</td>
<td class="right">${wprice:.4}</td>
<td class="right">{our_price}</td>
<td class="right">{qty}</td>
<td class="right">${fee:.4}</td>
<td>{slippage}</td>
<td>{detection}</td>
<td><span class="tag {result_class}">{result}</span></td>
</tr>"#,
                ts = t.ts.format("%H:%M:%S"),
                wallet_full = t.wallet,
                wallet_name = html_escape(&t.wallet_display_name),
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

    fn base_analytics() -> SessionAnalytics {
        SessionAnalytics {
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
            unrealized_pnl: None,
            unrealized_pnl_after_fees: None,
            net_pnl: None,
            wallet_stats: vec![],
            category_stats: vec![],
            token_stats: vec![],
            miss_reasons: HashMap::new(),
            avg_detection_delay_ms: None,
            avg_processing_delay_ms: None,
            median_detection_delay_ms: None,
            category_detection_delays: HashMap::new(),
            fee_source_counts: HashMap::new(),
            degraded_fill_count: 0,
            book_quality_counts: HashMap::new(),
            trades: vec![],
            first_event_ts: None,
            last_event_ts: None,
        }
    }

    #[test]
    fn render_html_produces_valid_structure() {
        let mut a = base_analytics();
        a.token_stats = vec![
            crate::report::analytics::TokenStats {
                token_id: "12345".into(),
                market_question: Some("Will it rain?".into()),
                outcome_label: Some("Yes".into()),
                buy_count: 1,
                sell_count: 0,
                total_volume: dec!(50),
                realized_pnl: dec!(0),
            },
        ];
        a.avg_detection_delay_ms = Some(2500.0);
        a.avg_processing_delay_ms = Some(1.5);
        a.median_detection_delay_ms = Some(2000);

        let html = render_html(&a);
        assert!(html.contains("<!DOCTYPE html>"));
        assert!(html.contains("test-session"));
        assert!(html.contains("Will it rain?"));
        assert!(html.contains("Verdict"));
        assert!(html.contains("</html>"));
    }

    #[test]
    fn unrealized_pnl_shown_when_present() {
        let mut a = base_analytics();
        a.unrealized_pnl = Some(dec!(500));
        a.unrealized_pnl_after_fees = Some(dec!(480));
        a.net_pnl = Some(dec!(480));

        let html = render_html(&a);
        assert!(html.contains("+$480"), "should display unrealized after fees");
        assert!(!html.contains("N/A"), "should not show N/A when unrealized is present");
    }

    #[test]
    fn unrealized_pnl_shows_na_when_cold() {
        let a = base_analytics();
        let html = render_html(&a);
        assert!(html.contains("N/A"), "should show N/A for cold report without live state");
    }

    #[test]
    fn misleading_banner_shown_when_realized_negative() {
        let mut a = base_analytics();
        a.session_id = "test".into();
        a.total_wallet_trades = 10;
        a.total_fills = 5;
        a.total_misses = 5;
        a.fill_rate_pct = dec!(50);
        a.realized_pnl_gross = dec!(10);
        a.realized_fees = dec!(20);
        a.realized_pnl_net = dec!(-10);
        a.turnover = dec!(100);

        let html = render_html(&a);
        assert!(html.contains("banner-warn"), "should show warning banner when realized is negative");
        assert!(html.contains("not confirmed profit"));
    }
}

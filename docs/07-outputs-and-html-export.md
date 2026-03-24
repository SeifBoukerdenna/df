# 07 — Outputs and HTML Export

## Main output question
At session end, the system must clearly answer:
- did the simulated portfolio win or lose?
- by how much?
- after realistic fees, slippage, latency, partial fills, and missed fills, was copying these wallets worth it?

## Required outputs
At minimum support:
- overall session PnL
- realized vs unrealized PnL
- fees paid
- slippage drag
- latency stats
- bankroll usage
- drawdown
- PnL by wallet
- PnL by wallet category
- PnL by market
- fill / miss / partial-fill stats
- actionable vs non-actionable exit stats

## HTML report
The system must export a clean, human-readable HTML session report.

The report should include:
- session start/end
- tracked-wallet summary
- configuration summary
- overall portfolio outcome
- key metrics
- per-wallet results
- directional vs arbitrage comparison
- notable winning trades
- notable losing trades
- skipped trades and why they were skipped
- degraded-state warnings
- assumptions and fallbacks used during the session

The HTML should be good enough to:
- review manually
- archive
- compare across sessions
- share internally

CSV/JSON exports are nice to have, but HTML is required.

# df

Polymarket paper-trading copy engine. Tracks wallets, simulates fills against live orderbook data, and tells you whether copying those wallets would have been profitable — after fees, slippage, latency, and partial fills.

## Quickstart

```bash
# Build
cargo build --release

# Check your wallets are valid
./target/release/df wallets --check

# Sanity run (5 minutes, see if trades appear)
./target/release/df run

# Generate HTML report from last session
./target/release/df report
open sessions/*.html
```

## Configuration

The default config is at `config/default.toml`. Override with `--config path/to/custom.toml`.

Key settings:

| Setting | Default | What it does |
|---|---|---|
| `session.starting_capital` | `10000` | Paper capital in USDC |
| `session.max_position_fraction` | `0.10` | Max % of capital per trade |
| `session.max_slippage_bps` | `200` | Skip trades above this slippage |
| `latency.polling_mode` | `aggressive` | `aggressive` (1.5s/3s) or `baseline` (3s/5s) |
| `fees.unavailable_policy` | `skip` | `skip` = honest miss, `degrade` = fill with zero fee |

## Tracked wallets

Add wallet addresses (one per line, 0x-prefixed) to:

- `config/tracked_wallets/directional_wallets.txt` — conviction/event-driven bets (polled faster)
- `config/tracked_wallets/arbitrage_wallets.txt` — structural inefficiency plays

Max recommended: ~40 wallets total (rate limit constraint).

## Commands

```bash
# Live session (Ctrl+C to stop gracefully)
df run
df run --capital 5000                   # override capital
df run --config config/custom.toml      # custom config

# Overnight run (macOS — keeps machine awake)
caffeinate -dims ./target/release/df run

# Check past sessions
df status

# HTML report (auto-picks latest session)
df report
df report --session 2026-03-24-143022   # specific session

# Deterministic replay
df replay --session 2026-03-24-143022

# Validate wallets
df wallets --check

# Dump effective config
df config
```

## How it works

1. **Discovery** — On startup, fetches recent trades for all tracked wallets to discover active markets. Pre-warms orderbooks via REST.
2. **Polling** — Two parallel loops poll wallets concurrently: directional (1.5s cycle) and arbitrage (3s cycle). Rate-limited to stay within Polymarket API limits.
3. **Book data** — WebSocket streams live orderbook snapshots. REST fallback for first trades on new markets.
4. **Fill simulation** — Walks the live orderbook depth, applies fees (sourced from CLOB API with caching), checks slippage, respects capital limits.
5. **Accounting** — FIFO cost basis, session-scoped positions (sells only apply to positions opened this session), realized + unrealized PnL.
6. **Reporting** — HTML report with per-market PnL, per-wallet stats, trade log, latency metrics, miss reasons.

## Data

- `data/df.db` — SQLite database (events, snapshots, fee cache, market metadata)
- `sessions/` — Generated HTML reports

## Architecture

```
ingestion/
  rest_wallets   — parallel wallet polling (Data API, 200 req/10s)
  rest_book      — orderbook warmup (CLOB API, 1500 req/10s)
  rest_metadata  — market names from Gamma API
  ws_market      — live book data via WebSocket

sim/
  engine         — main event loop, orchestration
  fill           — orderbook depth-walk fill simulator
  portfolio      — position tracking, PnL accounting
  replay         — deterministic session replay

report/
  analytics      — compute session stats from event log
  html           — self-contained HTML report generator
```

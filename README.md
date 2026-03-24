# df

Paper-trading copy engine for Polymarket. Tracks curated wallets in real time, simulates copying their trades against live orderbooks, and answers one question:

**"If I had simply followed these wallets, would I have made money after fees, slippage, and latency?"**

No live execution. No real money. Just honest research.

## Quick start

```bash
cargo build --release

# Validate your wallet list
./target/release/df wallets

# Start a session (Ctrl+C to stop)
./target/release/df run

# Open the report it generates on exit
open sessions/*.html
```

## Commands

### `df run` — Start a live session

```bash
df run                                    # uses config/default.toml
df run --config config/live.toml          # custom config
df run --capital 50000                    # override starting capital
```

Runs until you press Ctrl+C. On exit it prints a full summary and generates an HTML report with live unrealized PnL.

For a clean operator view (suppress tracing logs):
```bash
RUST_LOG=error ./target/release/df run
```

For overnight runs on macOS:
```bash
caffeinate -dims ./target/release/df run --config config/live.toml
```

### `df report` — Generate HTML report

```bash
df report                                 # latest session
df report --session 2026-03-24-143022     # specific session
```

Reports generated from `df run` (at session end) include live unrealized PnL. Reports generated cold via `df report` show realized PnL only.

### `df status` — List past sessions

```bash
df status           # table view
df status --json    # machine-readable
```

### `df replay` — Deterministic replay

```bash
df replay --session 2026-03-24-143022
```

Replays the event log and recomputes portfolio state. Useful for verifying accounting.

### `df wallets` — List and validate tracked wallets

```bash
df wallets                # list all wallets with names
df wallets --check        # validate address format
```

### `df config` — Dump effective configuration

```bash
df config
df config --config config/live.toml
```

## Wallet configuration

Wallets are configured in TOML files with optional metadata:

```toml
# config/tracked_wallets/directional_wallets.toml

[[wallet]]
address = "0x87650b9f63563f7c456d9bbcceee5f9faf06ed81"
name = "whale-01"
profile_url = "https://polymarket.com/profile/0x8765..."
notes = "very active on politics"

[[wallet]]
address = "0xb0f85baa97990910a3e8ac2b4a58a322f01ecef5"
name = "insider-02"
```

Fields:
- `address` (required) — 0x-prefixed Ethereum address (42 chars)
- `name` (optional) — display name shown in terminal and reports
- `profile_url` (optional) — clickable link in HTML reports
- `notes` (optional) — your own reference notes

Two wallet files:
- `config/tracked_wallets/directional_wallets.toml` — conviction/event-driven traders (polled every 1.5s)
- `config/tracked_wallets/arbitrage_wallets.toml` — structural arb traders (polled every 3s)

Legacy `.txt` format (one address per line) is also supported. The engine auto-detects the format.

## Wallet categories

The engine tracks two categories of wallets with different behavior:

**Directional** — wallets making conviction bets. Signals persist for hours. Wide slippage tolerance (500 bps default) because the point is to follow the trade, not optimize entry. No detection age limit. This is the primary research target.

**Arbitrage** — wallets exploiting structural inefficiencies. Signals decay in seconds. Tighter slippage (200 bps). Trades older than 15s are skipped as stale. Tracked for research but structurally disadvantaged by REST polling latency.

Category-specific parameters are configured in `[category.directional]` and `[category.arbitrage]` sections of the config file.

## Configuration

Config is TOML. The engine ships with two files:
- `config/default.toml` — conservative defaults
- `config/live.toml` — aggressive settings for real research

### Key settings

| Setting | Default | Description |
|---|---|---|
| `session.starting_capital` | `1000000` | Paper capital in USDC |
| `session.max_position_fraction` | `0.10` | Max fraction of capital per trade |
| `session.max_slippage_bps` | `300` | Global slippage limit in basis points |
| `session.marking_mode` | `conservative` | How to value open positions: `conservative` (best bid), `midpoint`, or `last_trade` |
| `latency.polling_mode` | `aggressive` | `aggressive` or `baseline` |
| `latency.arrival_delay_ms` | `500` | Simulated order arrival delay |
| `fees.cache_ttl_secs` | `3600` | Fee rate cache lifetime |
| `fees.unavailable_policy` | `skip` | `skip` = miss honestly, `degrade` = fill with zero fee |

### Category overrides

```toml
[category.directional]
max_slippage_bps = "500"       # wide tolerance — directional signals persist, don't miss them

[category.arbitrage]
max_slippage_bps = "200"       # tighter for fast-decaying signals
max_position_fraction = "0.05" # smaller sizing
max_detection_age_ms = 15000   # skip trades older than 15s
```

Available overrides per category: `max_slippage_bps`, `max_position_fraction`, `arrival_delay_ms`, `max_detection_age_ms`, `fee_unavailable_policy`.

### On-chain detection (optional)

For faster trade detection (~2-4s vs ~30s), add a Polygon WebSocket RPC URL:

```toml
[ingestion]
polygon_rpc_ws = "wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY"
```

Falls back to REST polling if not configured. Most useful for arbitrage wallets; directional wallets work fine with REST only.

**Alchemy CU cost:** The listener uses wallet-filtered subscriptions (4 subs total), so you only receive events involving your tracked wallets — not all Polymarket trades. Alchemy charges ~40 CU per log notification pushed. With 50 wallets making ~20-100 trades/day, expect ~500-4,000 CU/hour. Alchemy free tier is 30M CU/month (~41,000 CU/hour budget), so **free tier handles 50 wallets comfortably** with headroom. If your wallets are extremely active, monitor usage at dashboard.alchemy.com.

## What you see while running

Every 30 seconds, a status line:

```
[1h05m]  +$500.00  real=-$100.00  unreal=+$600.00  fees=$200.00  fill=38%  pos=200 UNREALIZED  |  dir:100f/200m lag=25.0s  arb:20f/80m lag=28.0s
```

- `+$500.00` — net PnL (realized + unrealized)
- `real=-$100.00` — realized PnL from closed trades
- `unreal=+$600.00` — unrealized mark-to-market on open positions
- `fees=$200.00` — total fees paid
- `fill=38%` — fill rate (fills / attempts)
- `pos=200` — open positions
- `UNREALIZED` — honesty flag (realized is negative, profit is just marks)
- `dir:100f/200m` — directional: 100 fills, 200 misses
- `lag=25.0s` — average detection latency

Every 5 minutes, a wallet leaderboard:

```
┌─ Wallet Snapshot (open positions, unrealized PnL)
│  + whale-01      +$320.00  exp=$2400
│  + insider-02    +$210.00  exp=$1800
│  + dir-11        +$180.00  exp=$900
└─
```

## What the report shows

The HTML report (generated at session end or via `df report`) includes:

- **Verdict** — net PnL, realized PnL, unrealized PnL after estimated exit fees
- **Truthfulness banner** — warns if realized is negative but net appears positive
- **Category breakdown** — directional vs arbitrage: fill rate, PnL, fees, detection latency
- **Wallet leaderboard** — sorted by realized PnL, with unrealized, exposure, fill rate, and clickable profile links
- **Miss reasons** — why trades were skipped (slippage, depth, stale book, detection too old, etc.)
- **Latency stats** — average and median detection delay
- **Top markets** — by volume
- **Trade log** — chronological, capped at 500 entries

## Vocabulary

| Term | Meaning |
|---|---|
| **Fill** | We successfully simulated copying the trade |
| **Miss** | We could not copy the trade (slippage, no depth, stale book, etc.) |
| **Partial fill** | We copied some but not all of the trade size |
| **Realized PnL** | Profit/loss from positions that were opened AND closed during the session |
| **Unrealized PnL** | Mark-to-market value of positions still open |
| **Fill rate** | Percentage of detected trades that resulted in a fill |
| **Detection lag** | Time between the wallet's trade on Polymarket and when we detected it |
| **Slippage** | Price difference between the wallet's fill and our simulated fill (in basis points) |
| **Trade-time snapshot** | Book state captured at the moment a trade happened on the WS feed, used for fill simulation instead of the current (potentially post-trade) book |
| **Liquidity decay** | The tracked wallet already consumed depth from the book; we subtract their fill before simulating ours |
| **Conservative marking** | Open positions valued at best bid (what we could actually sell at) |
| **Detection too old** | Trade was detected but too stale for the category's latency budget |
| **Exit fee** | Estimated fee to close an open position, deducted from unrealized PnL for honesty |

## Data storage

- `data/df.db` — SQLite database (WAL mode). Contains events, snapshots, fee cache, market metadata.
- `sessions/` — Generated HTML reports (self-contained, no dependencies).

## Scaling

The system comfortably handles 30-40 wallets. The bottleneck is the Data API rate limit (~200 req/10s shared across both categories). At 30 wallets polling every 1.5-3s, you're using about half the budget.

To track more wallets:
- Increase polling intervals slightly (e.g., `directional_interval_ms = 2000`)
- Or prioritize directional wallets and reduce arbitrage count

## Limitations

- **REST detection latency** — The Data API indexes trades ~10-30s after execution. On-chain detection (Polygon WS) reduces this to ~2-4s but requires an RPC key.
- **No market resolution** — When a market resolves, positions stay at their last mark rather than settling at 0 or 1.
- **Multi-wallet same-token** — If two wallets buy the same token, they share one position entry. Source wallet attribution tracks only the first buyer.
- **Session-scoped** — Sells only apply to positions opened during the current session. No carry-over between sessions.

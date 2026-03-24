# 01 — Product Goals

## What this project is
A Polymarket-only **paper-trading copy-trading research engine**.

Its job is to answer, as honestly as possible:
- if we tracked a curated set of wallets,
- detected their trades as fast as realistically possible,
- and copied them with a simulated session portfolio,
- what would our PnL actually look like?

## What matters
The system must quantify:
- realized PnL
- unrealized PnL
- total fees paid
- total slippage paid
- average bps impact
- fill rate
- partial-fill rate
- missed-trade rate
- bankroll usage
- drawdown
- profitability by wallet
- profitability by wallet category
- profitability by market
- profitability by latency bucket

## What does not matter
Do not prioritize:
- speculative narratives about why a wallet traded
- social-style profiling of tracked wallets
- vanity dashboards before correctness
- optimistic backtests with best-case fills

## Wallet categories
We track two categories only:

### Directional wallets
These may reflect:
- conviction bets
- event-driven bets
- slower, more copyable opportunities

Source file:
- `config/tracked_wallets/directional_wallets.txt`

### Arbitrage wallets
These may reflect:
- structural inefficiencies
- fast flow-sensitive activity
- opportunities that may disappear after latency

Source file:
- `config/tracked_wallets/arbitrage_wallets.txt`

## Session model
Default behavior is a **singleton session portfolio**:
- configurable starting capital
- one paper portfolio for the whole session
- no personal wallet needed
- no live execution credentials required
- no synthetic inventory from outside the session

Optional extensions may be added later, but the default remains:
- one session
- one portfolio
- one running PnL state

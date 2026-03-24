# 04 — Simulation and Accounting

## The standard of realism
A copied trade is only valid if we can answer:
1. Was the tracked-wallet trade detectable?
2. When was it detectable?
3. What was the visible market state at our simulated arrival time?
4. Could we fill the desired size?
5. At what weighted average price?
6. What fees applied?
7. Was the fill full, partial, or impossible?
8. What did this do to our portfolio afterward?

If any answer is unknown, do not silently assume the best case.

## Position lifecycle rules
Critical rule:
- **SELL** and **REDEEM** only apply to positions previously opened by the simulated session portfolio.

Therefore:
- do not realize profit from exits if we never bought earlier in the session
- do not synthesize inventory
- do not teleport into historical positions
- do not assume pre-session holdings

Tracked-wallet exits can be marked:
- actionable
- partially actionable
- non-actionable

## Accounting model
At minimum track:
- `cash`
- `reserved_cash`
- `position_qty`
- `position_cost_basis`
- `realized_pnl_gross`
- `realized_fees`
- `realized_pnl_net`
- `unrealized_pnl`
- `account_value`
- `turnover`
- `fill_count`
- `partial_fill_count`
- `miss_count`

## Required identities
- `account_value = cash + market_value(open_positions)`
- `net_pnl = realized_pnl_gross - realized_fees + unrealized_pnl`
- `starting_capital + net_pnl = account_value`

Never blur fees into gross PnL.
Track them separately.

## Fill realism
Support:
- depth-walking book fills
- partial fills
- size-aware skips
- max-slippage guards
- latency/drift overlays
- configurable arrival delay models

Default realistic mode should not use no-slippage assumptions except for diagnostics.

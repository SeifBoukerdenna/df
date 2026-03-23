# CLAUDE.md

Read this file first, then consult the referenced docs in `docs/`.

## Mission
Build the most realistic and fastest possible **paper-trading** copy-trading research engine for **Polymarket only**.

The only question that matters is:
- if we copied these tracked wallets, what would have happened to **our** simulated session portfolio?
- did we win or lose?
- by how much after fees, slippage, latency, partial fills, and missed fills?

## Core rules
1. **Paper trading only.** No live execution.
2. **Zero fake assumptions.** Read the actual Polymarket docs before implementing exchange-specific logic.
3. **Trustworthiness over vanity.** If confidence is low, mark results degraded instead of pretending.
4. **Fastest plausible setup.** Optimize for useful real-world speed, not theoretical nonsense.
5. **Long-running stability is mandatory.** Design for 8h+/24h+ sessions.
6. **Session realism.** Sells/redeems only apply to positions previously bought during the same simulated session.
7. **Real fee sourcing.** Do not hardcode one global fee model if a real source exists.
8. **No storytelling detours.** Focus on what happened to the simulated portfolio, not why the tracked wallet traded.
9. **Carte blanche on stack.** The repo is empty; choose the best language(s) and architecture for the constraints.
10. **Meaningful testing, not coverage theater.** Add tests where they improve trust.

## Tracked wallets
Use these exact files:
- `config/tracked_wallets/directional_wallets.txt`
- `config/tracked_wallets/arbitrage_wallets.txt`

Store **wallet addresses**, one per line. Do **not** use profile URLs as the source of truth.

## Reference docs
- `docs/01-product-goals.md`
- `docs/02-polymarket-reality.md`
- `docs/03-architecture-guidelines.md`
- `docs/04-simulation-accounting.md`
- `docs/05-fees-and-market-data.md`
- `docs/06-reliability-and-testing.md`
- `docs/07-outputs-and-html-export.md`
- `docs/08-implementation-plan.md`

## First task
1. Inspect the repo.
2. Inspect the current Polymarket docs and any SDK usage.
3. Propose the best architecture for:
   - long-running live paper trading
   - low-latency wallet tracking
   - realistic fill simulation
   - trustworthy accounting
   - market-sourced fee resolution
   - HTML session export
4. Then implement it in small, reviewable steps with tests.

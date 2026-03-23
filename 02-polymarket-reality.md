# 02 — Polymarket Reality

## Ground rule
Do not treat Polymarket like a generic AMM or a naive fully onchain exchange.

Before implementing exchange-specific logic:
- read the current Polymarket docs
- inspect the actual API payloads
- verify SDK behavior if using an SDK

## Design implication
The system must separate:
- market metadata discovery
- market/book/trade ingestion
- tracked-wallet activity reconstruction
- local orderbook state
- fill simulation
- portfolio accounting

## Fastest plausible setup
For this project, “fastest possible” means:
- best practical real-time data ingestion
- hot local state
- low-latency wallet-trade detection or reconstruction
- realistic arrival-price modeling
- deterministic replay

Do not over-index on generic blockchain trading myths if they do not improve Polymarket copy-trading realism.

## Data quality mindset
Every event should have:
- a source
- a timestamp
- a normalized representation
- a confidence level where relevant
- enough evidence for replay and debugging

If a tracked-wallet trade cannot be attributed with confidence, do not silently promote it to truth.

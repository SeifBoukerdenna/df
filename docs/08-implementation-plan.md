# 08 — Implementation Plan

## Phase 1 — Documentation-grounded design
Before writing major exchange-specific logic:
1. inspect the current Polymarket docs
2. inspect real API payloads
3. map identifiers and schemas
4. define the event model
5. define the portfolio/accounting model
6. define the fee-source strategy
7. define the HTML export requirements

Deliverables:
- design notes
- assumptions register
- config schema
- event schema
- portfolio schema

## Phase 2 — Live ingestion foundation
Implement:
- metadata bootstrap
- real-time market-data ingestion
- wallet file loading
- basic persistence/checkpointing
- health logging

Deliverables:
- clean startup
- clean subscription behavior
- reconnect support
- minimal snapshots

## Phase 3 — Wallet activity tracking
Implement:
- tracked-wallet registry
- wallet activity collection/reconstruction
- normalized wallet-trade events
- dedupe logic
- source confidence labeling
- audit trail

Deliverables:
- per-wallet normalized event stream
- raw-to-normalized traceability

## Phase 4 — Book state + fill simulator
Implement:
- local book state
- arrival-price simulation
- depth walking
- latency overlays
- fee application
- partial fill logic
- skip rules

Deliverables:
- trustworthy fill simulation
- explainable copied trades

## Phase 5 — Session portfolio engine
Implement:
- singleton session portfolio
- cash management
- position lifecycle
- realized/unrealized PnL
- actionable vs non-actionable exits
- replay determinism

Deliverables:
- correct accounting
- no fake inventory
- deterministic replay

## Phase 6 — Long-run stability + reporting
Implement:
- soak-tested long-session behavior
- recovery/restart validation
- reporting CLI
- HTML session export

Deliverables:
- stable long-run paper-trading engine
- trustworthy findings export

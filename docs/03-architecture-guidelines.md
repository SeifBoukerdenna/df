# 03 — Architecture Guidelines

## Carte blanche
The repo is empty.
Choose the best architecture and language(s) for the actual constraints.

You may choose:
- Rust
- Go
- C++
- Python
- TypeScript
- or a mixed system

Pick based on:
- hot-path latency
- deterministic replay
- long-running reliability
- maintainability
- observability
- export/reporting needs
- feasibility for a single developer

## Preferred principles
- keep hot-path logic efficient
- keep accounting logic explicit and trustworthy
- keep state replayable
- keep configs externalized
- keep logs structured
- keep modules small and composable

## Recommended subsystem split
- `ingestion/`
  - market streams
  - metadata refresh
  - wallet activity collectors
- `core/`
  - IDs and schemas
  - book state
  - fees
  - latency models
  - portfolio models
- `sim/`
  - fill engine
  - replay engine
  - scenario runner
- `storage/`
  - checkpoints
  - snapshots
  - event log
- `reports/`
  - summaries
  - analytics
  - HTML export
- `ops/`
  - health
  - metrics
  - config validation

## Hot-path guidance
Prioritize performance for:
1. market-data ingestion
2. orderbook updates
3. wallet-trade detection
4. fill simulation
5. persistence overhead

Avoid:
- blocking I/O in hot paths
- excessive object churn
- wasteful polling
- repeated serialization/deserialization in tight loops
- synchronous logging in hot loops

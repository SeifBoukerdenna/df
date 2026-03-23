# 05 — Fees and Market Data

## Absolute fee rules
- Do **not** hardcode one global fee assumption.
- Do **not** blindly “apply fees.”
- Do **not** assume fee behavior is identical across all markets forever.

## Required fee behavior
For each simulated fill, use real fee information from an official or directly observed source when available.

The system should:
- determine whether fees are enabled where relevant
- fetch fee information from a real source when possible
- cache carefully
- record the source of fee data where practical
- degrade clearly if forced to use cached or fallback data

## Market-data priorities
The system must maintain clean separation between:
- metadata bootstrap and refresh
- real-time market-data ingestion
- wallet activity reconstruction
- book state maintenance
- fee lookup and caching

## Real-time behavior
Use real-time streams for the hot path where possible.
Use REST only for:
- bootstrap
- reconciliation
- backfill
- metadata refresh
- fee lookup
- sanity checks

Do not depend on naive polling loops as the primary real-time mechanism.

## Data quality states
When local book or fee confidence drops, expose explicit state such as:
- `GOOD`
- `DEGRADED`
- `STALE`
- `REBUILDING`

Do not silently keep simulating best-case fills on degraded state.

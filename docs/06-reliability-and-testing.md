# 06 — Reliability and Testing

## Reliability is mandatory
The engine must be able to run for long sessions without silently corrupting state.

Required behavior:
- automatic reconnect
- exponential backoff
- liveness/health checks
- periodic snapshots
- startup recovery from latest valid snapshot
- duplicate-event protection
- bounded queues
- backpressure handling
- graceful shutdown with checkpoint flush
- bounded log strategy

## Safety checks
Must detect or reject:
- stale book states
- invalid prices/sizes
- missing market metadata
- missing fee metadata
- impossible accounting identities
- duplicate fills
- out-of-order event problems
- sells/redeems without session inventory

When confidence drops, prefer:
- degraded mode
- skipped fills
- explicit warnings

## Testing philosophy
No coverage theater.
Do enough meaningful testing to trust the findings.

Prefer:
- high-value integration tests
- deterministic replay tests
- accounting invariants
- scenario fixtures
- recovery/reconnect tests

## Minimum test set
- config parsing tests
- wallet dedupe tests
- orderbook update tests
- stale-book detection tests
- impossible fill tests
- partial fill tests
- fee lookup tests
- fee fallback/degraded-mode tests
- latency model tests
- accounting identity tests
- sell/redeem-without-position tests
- replay determinism tests
- reconnect/restart tests
- duplicate event tests
- HTML export smoke test

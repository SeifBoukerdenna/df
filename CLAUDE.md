# Polymarket Quantitative Trading Platform

## What This Is
A profit-maximizing quant research and execution platform for Polymarket prediction markets.
Terminal-first. No UI. Every decision traceable to an EV calculation.

## Tech Stack
- TypeScript (Node.js 20+)
- Single process, event-driven
- File-based storage (JSONL for ledger, JSON for state)
- Pino for structured JSON logging
- ws for WebSockets
- ethers.js v6 or viem for blockchain
- Commander.js for CLI
- Vitest for testing
- simple-statistics for stats

## Architecture
Five strict layers: Ingestion → State → Strategy → Execution → Ledger
No module reaches into another's internals.
Above the trading loop: Alpha Research Factory, Portfolio Construction.

## Code Style
- ES modules (import/export), not CommonJS
- Strict TypeScript (strict: true)
- All functions return typed results
- No any types
- Every trade signal includes EV estimate with confidence interval

## Key Commands
- `npm run build` — compile TypeScript
- `npm run test` — run Vitest
- `npm run lint` — ESLint

## Critical Rules
- Ledger is append-only JSONL. Never modify or delete entries.
- Every strategy must run in shadow/paper mode before live.
- No strategy is promoted without: p < 0.05, n >= 30, OOS Sharpe > 0.5
- Private keys NEVER in source code or config

## Full Spec
See @SPEC.md for the complete system specification with all data models and modules.
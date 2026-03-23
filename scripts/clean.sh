#!/bin/bash
# Clean all previous data files for a fresh session
set -e
cd "$(dirname "$0")/.."

echo "Cleaning data files..."

# Ledger
find data/ledger -name '*.jsonl' -delete 2>/dev/null
# Raw events
find data/raw_events -name '*.jsonl' -delete 2>/dev/null
# Snapshots
find data/snapshots -name '*.json' ! -name '.gitkeep' -delete 2>/dev/null
# Features
find data/features -name '*.jsonl' -delete 2>/dev/null
# Analysis (HTML reports, propagation)
find data/analysis -name '*.html' -delete 2>/dev/null
find data/analysis/propagation -name '*.json' -delete 2>/dev/null
# Session logs
find data -maxdepth 1 -name '*.log' -delete 2>/dev/null
# Research
find data/research -name '*.json' -name '*.jsonl' -delete 2>/dev/null

echo "Done. Cleaned:"
du -sh data/

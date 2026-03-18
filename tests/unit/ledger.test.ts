import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Ledger } from '../../src/ledger/ledger.js';
import { replay, verifyChecksum, replayAll, reconstructState } from '../../src/ledger/replay.js';
import type { LedgerEntry, LedgerRecord } from '../../src/ledger/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = join(import.meta.dirname, '..', '..', 'tmp_test_ledger');

function makeSystemEvent(event: string): LedgerEntry {
  return { type: 'system_event', data: { event, details: {} } };
}

function readLines(filePath: string): string[] {
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
}

async function collectReplay(filePath: string): Promise<LedgerRecord[]> {
  const records: LedgerRecord[] = [];
  for await (const r of replay(filePath)) {
    records.push(r);
  }
  return records;
}

async function collectReplayAll(dir: string): Promise<LedgerRecord[]> {
  const records: LedgerRecord[] = [];
  for await (const r of replayAll(dir)) {
    records.push(r);
  }
  return records;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Ledger.append', () => {
  it('writes valid JSONL — each line parses as JSON', () => {
    const ledger = new Ledger(TEST_DIR);
    ledger.append(makeSystemEvent('boot'));
    ledger.append(makeSystemEvent('heartbeat'));
    ledger.append(makeSystemEvent('shutdown'));

    const lines = readLines(ledger.currentFile());
    expect(lines).toHaveLength(3);

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('writes correct entry data', () => {
    const ledger = new Ledger(TEST_DIR);
    ledger.append(makeSystemEvent('test_event'));

    const lines = readLines(ledger.currentFile());
    const record = JSON.parse(lines[0]!) as LedgerRecord;
    expect(record.entry.type).toBe('system_event');
    if (record.entry.type === 'system_event') {
      expect(record.entry.data.event).toBe('test_event');
    }
  });

  it('assigns monotonically increasing seq_num', () => {
    const ledger = new Ledger(TEST_DIR);
    const r1 = ledger.append(makeSystemEvent('a'));
    const r2 = ledger.append(makeSystemEvent('b'));
    const r3 = ledger.append(makeSystemEvent('c'));

    expect(r1.seq_num).toBe(0);
    expect(r2.seq_num).toBe(1);
    expect(r3.seq_num).toBe(2);
  });

  it('seq_num is monotonic across returned records', () => {
    const ledger = new Ledger(TEST_DIR);
    const records: LedgerRecord[] = [];
    for (let i = 0; i < 20; i++) {
      records.push(ledger.append(makeSystemEvent(`event_${i}`)));
    }

    for (let i = 1; i < records.length; i++) {
      expect(records[i]!.seq_num).toBe(records[i - 1]!.seq_num + 1);
    }
  });

  it('includes wall_clock timestamp in each record', () => {
    const before = Date.now();
    const ledger = new Ledger(TEST_DIR);
    const record = ledger.append(makeSystemEvent('ts_test'));
    const after = Date.now();

    expect(record.wall_clock).toBeGreaterThanOrEqual(before);
    expect(record.wall_clock).toBeLessThanOrEqual(after);
  });

  it('resumes seq_num from existing file on construction', () => {
    // Write some entries
    const ledger1 = new Ledger(TEST_DIR);
    ledger1.append(makeSystemEvent('a'));
    ledger1.append(makeSystemEvent('b'));
    ledger1.append(makeSystemEvent('c'));
    expect(ledger1.currentSeqNum()).toBe(3);

    // Create a new Ledger instance pointing at the same dir — should resume
    const ledger2 = new Ledger(TEST_DIR);
    expect(ledger2.currentSeqNum()).toBe(3);

    const r = ledger2.append(makeSystemEvent('d'));
    expect(r.seq_num).toBe(3);
  });

  it('creates directory if it does not exist', () => {
    const nestedDir = join(TEST_DIR, 'deeply', 'nested');
    const ledger = new Ledger(nestedDir);
    ledger.append(makeSystemEvent('deep'));
    expect(existsSync(ledger.currentFile())).toBe(true);
  });
});

describe('Ledger.rotate', () => {
  it('creates a .sha256 sidecar file', () => {
    const ledger = new Ledger(TEST_DIR);
    ledger.append(makeSystemEvent('before_rotate'));

    const checksumPath = ledger.rotate();
    expect(checksumPath).not.toBeNull();
    expect(existsSync(checksumPath!)).toBe(true);
  });

  it('checksum matches SHA-256 of the file contents', () => {
    const ledger = new Ledger(TEST_DIR);
    ledger.append(makeSystemEvent('data_1'));
    ledger.append(makeSystemEvent('data_2'));

    ledger.rotate();

    const content = readFileSync(ledger.currentFile(), 'utf-8');
    const expected = createHash('sha256').update(content).digest('hex');
    const checksumFile = ledger.currentFile().replace(/\.jsonl$/, '.sha256');
    const actual = readFileSync(checksumFile, 'utf-8').trim();

    expect(actual).toBe(expected);
  });

  it('returns null for empty/missing file', () => {
    const ledger = new Ledger(TEST_DIR);
    // No appends — file doesn't exist yet or is empty
    const result = ledger.rotate();
    expect(result).toBeNull();
  });
});

describe('replay', () => {
  it('recovers all records in order', async () => {
    const ledger = new Ledger(TEST_DIR);
    for (let i = 0; i < 10; i++) {
      ledger.append(makeSystemEvent(`event_${i}`));
    }

    const records = await collectReplay(ledger.currentFile());
    expect(records).toHaveLength(10);

    for (let i = 0; i < 10; i++) {
      expect(records[i]!.seq_num).toBe(i);
      expect(records[i]!.entry.type).toBe('system_event');
    }
  });

  it('yields nothing for non-existent file', async () => {
    const records = await collectReplay(join(TEST_DIR, 'nope.jsonl'));
    expect(records).toHaveLength(0);
  });

  it('skips corrupt lines gracefully', async () => {
    const ledger = new Ledger(TEST_DIR);
    ledger.append(makeSystemEvent('good_1'));
    ledger.append(makeSystemEvent('good_2'));

    // Inject a corrupt line between valid entries
    const filePath = ledger.currentFile();
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    const corrupted = [lines[0], '{{{CORRUPT', lines[1]].join('\n') + '\n';
    writeFileSync(filePath, corrupted, 'utf-8');

    const records = await collectReplay(filePath);
    // Should recover the 2 good lines, skipping the corrupt one
    expect(records).toHaveLength(2);
  });
});

describe('verifyChecksum', () => {
  it('returns true for valid checksum', () => {
    const ledger = new Ledger(TEST_DIR);
    ledger.append(makeSystemEvent('verify_me'));
    ledger.rotate();

    expect(verifyChecksum(ledger.currentFile())).toBe(true);
  });

  it('returns false for tampered file', () => {
    const ledger = new Ledger(TEST_DIR);
    ledger.append(makeSystemEvent('original'));
    ledger.rotate();

    // Tamper with the file content
    const filePath = ledger.currentFile();
    const content = readFileSync(filePath, 'utf-8');
    writeFileSync(filePath, content + '{"injected":true}\n', 'utf-8');

    expect(verifyChecksum(filePath)).toBe(false);
  });

  it('returns false when checksum file is missing', () => {
    const ledger = new Ledger(TEST_DIR);
    ledger.append(makeSystemEvent('no_checksum'));
    // Don't rotate — so no .sha256 file exists
    expect(verifyChecksum(ledger.currentFile())).toBe(false);
  });

  it('returns false when data file is missing', () => {
    expect(verifyChecksum(join(TEST_DIR, 'nonexistent.jsonl'))).toBe(false);
  });
});

describe('replayAll', () => {
  it('replays multiple files in date order', async () => {
    // Manually create two day-files
    const file1 = join(TEST_DIR, '2025-01-01.jsonl');
    const file2 = join(TEST_DIR, '2025-01-02.jsonl');

    const rec1: LedgerRecord = {
      seq_num: 0,
      wall_clock: 1000,
      entry: makeSystemEvent('day1_a'),
    };
    const rec2: LedgerRecord = {
      seq_num: 1,
      wall_clock: 2000,
      entry: makeSystemEvent('day1_b'),
    };
    const rec3: LedgerRecord = {
      seq_num: 2,
      wall_clock: 90000,
      entry: makeSystemEvent('day2_a'),
    };

    writeFileSync(file1, JSON.stringify(rec1) + '\n' + JSON.stringify(rec2) + '\n', 'utf-8');
    writeFileSync(file2, JSON.stringify(rec3) + '\n', 'utf-8');

    const records = await collectReplayAll(TEST_DIR);
    expect(records).toHaveLength(3);
    expect(records[0]!.seq_num).toBe(0);
    expect(records[1]!.seq_num).toBe(1);
    expect(records[2]!.seq_num).toBe(2);
  });

  it('ignores non-JSONL files', async () => {
    writeFileSync(join(TEST_DIR, 'notes.txt'), 'not a ledger', 'utf-8');
    writeFileSync(join(TEST_DIR, '2025-01-01.sha256'), 'abc123', 'utf-8');

    const rec: LedgerRecord = {
      seq_num: 0,
      wall_clock: 1000,
      entry: makeSystemEvent('only_this'),
    };
    writeFileSync(join(TEST_DIR, '2025-01-01.jsonl'), JSON.stringify(rec) + '\n', 'utf-8');

    const records = await collectReplayAll(TEST_DIR);
    expect(records).toHaveLength(1);
  });

  it('yields nothing for empty directory', async () => {
    const records = await collectReplayAll(TEST_DIR);
    expect(records).toHaveLength(0);
  });

  it('yields nothing for non-existent directory', async () => {
    const records = await collectReplayAll(join(TEST_DIR, 'nope'));
    expect(records).toHaveLength(0);
  });
});

describe('reconstructState', () => {
  it('rebuilds open positions from position_opened / position_closed', async () => {
    const file = join(TEST_DIR, '2025-01-01.jsonl');

    const posA = {
      market_id: 'market_a',
      token_id: 'token_a_yes',
      side: 'YES' as const,
      size: 100,
      avg_entry_price: 0.55,
      current_mark: 0.60,
      unrealized_pnl: 5,
      opened_at: 1000,
      strategy_id: 'strat_1',
      signal_ev_at_entry: 0.05,
      current_ev_estimate: 0.04,
      time_in_position_ms: 60000,
      max_favorable_excursion: 6,
      max_adverse_excursion: -2,
    };

    const posB = {
      market_id: 'market_b',
      token_id: 'token_b_yes',
      side: 'YES' as const,
      size: 50,
      avg_entry_price: 0.30,
      current_mark: 0.35,
      unrealized_pnl: 2.5,
      opened_at: 2000,
      strategy_id: 'strat_2',
      signal_ev_at_entry: 0.03,
      current_ev_estimate: 0.02,
      time_in_position_ms: 30000,
      max_favorable_excursion: 3,
      max_adverse_excursion: -1,
    };

    const records: LedgerRecord[] = [
      { seq_num: 0, wall_clock: 1000, entry: { type: 'position_opened', data: posA } },
      { seq_num: 1, wall_clock: 2000, entry: { type: 'position_opened', data: posB } },
      {
        seq_num: 2,
        wall_clock: 3000,
        entry: {
          type: 'position_closed',
          data: {
            market_id: 'market_a',
            token_id: 'token_a_yes',
            entry_price: 0.55,
            exit_price: 0.60,
            size: 100,
            pnl_gross: 5,
            pnl_net: 4.8,
            holding_period_ms: 60000,
            strategy_id: 'strat_1',
            signal_ev_at_entry: 0.05,
            realized_ev: 0.048,
            ev_estimation_error: 0.002,
            execution_cost_realized: 0.2,
            execution_cost_estimated: 0.15,
          },
        },
      },
    ];

    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

    const { positions, lastSeqNum } = await reconstructState(TEST_DIR);

    expect(lastSeqNum).toBe(2);
    expect(positions.size).toBe(1);
    expect(positions.has('market_a')).toBe(false); // closed
    expect(positions.has('market_b')).toBe(true); // still open
    expect(positions.get('market_b')!.size).toBe(50);
  });

  it('returns empty state for empty ledger', async () => {
    const { positions, lastSeqNum } = await reconstructState(TEST_DIR);
    expect(positions.size).toBe(0);
    expect(lastSeqNum).toBe(-1);
  });
});

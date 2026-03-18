import { createReadStream, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { getLogger } from '../utils/logger.js';
import type { LedgerRecord } from './types.js';
import type { PositionState } from '../state/types.js';

const log = getLogger('ledger.replay');

/**
 * Streams ledger records from a single JSONL file as an async iterable.
 * Skips blank lines and logs parse errors without throwing.
 */
export async function* replay(filePath: string): AsyncIterable<LedgerRecord> {
  if (!existsSync(filePath)) {
    log.warn({ filePath }, 'Ledger file not found for replay');
    return;
  }

  const rl = createInterface({
    input: createReadStream(filePath, 'utf-8'),
    crlfDelay: Infinity,
  });

  let lineNum = 0;
  for await (const line of rl) {
    lineNum++;
    if (line.trim().length === 0) continue;
    try {
      yield JSON.parse(line) as LedgerRecord;
    } catch (err) {
      log.error({ filePath, lineNum, err }, 'Failed to parse ledger line');
    }
  }
}

/**
 * Verifies the SHA-256 checksum of a ledger file against its sidecar .sha256 file.
 *
 * @returns `true` if the checksum matches, `false` if it doesn't or if
 *          either the data file or checksum file is missing.
 */
export function verifyChecksum(filePath: string): boolean {
  const checksumPath = filePath.replace(/\.jsonl$/, '.sha256');

  if (!existsSync(filePath) || !existsSync(checksumPath)) {
    return false;
  }

  const content = readFileSync(filePath, 'utf-8');
  const actual = createHash('sha256').update(content).digest('hex');
  const expected = readFileSync(checksumPath, 'utf-8').trim();

  return actual === expected;
}

/**
 * Replays all ledger files in a directory in chronological (filename-sorted) order.
 * Only reads *.jsonl files.
 */
export async function* replayAll(ledgerDir: string): AsyncIterable<LedgerRecord> {
  if (!existsSync(ledgerDir)) {
    log.warn({ ledgerDir }, 'Ledger directory not found');
    return;
  }

  const files = readdirSync(ledgerDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort(); // YYYY-MM-DD.jsonl sorts chronologically

  for (const file of files) {
    const filePath = join(ledgerDir, file);
    log.info({ file }, 'Replaying ledger file');
    yield* replay(filePath);
  }
}

/**
 * Reconstructs position state by replaying the full ledger directory.
 *
 * Processes `position_opened` and `position_closed` entries to build
 * the set of currently open positions. Additional entry types can be
 * handled in future phases.
 *
 * @returns A map of market_id → PositionState for all currently open positions,
 *          and the highest seq_num seen.
 */
export async function reconstructState(
  ledgerDir: string,
): Promise<{ positions: Map<string, PositionState>; lastSeqNum: number }> {
  const positions = new Map<string, PositionState>();
  let lastSeqNum = -1;

  for await (const record of replayAll(ledgerDir)) {
    if (record.seq_num > lastSeqNum) {
      lastSeqNum = record.seq_num;
    }

    const { entry } = record;

    if (entry.type === 'position_opened') {
      const pos = entry.data;
      positions.set(pos.market_id, pos);
    } else if (entry.type === 'position_closed') {
      positions.delete(entry.data.market_id);
    }
  }

  log.info(
    { positions_open: positions.size, last_seq_num: lastSeqNum },
    'State reconstructed from ledger',
  );

  return { positions, lastSeqNum };
}

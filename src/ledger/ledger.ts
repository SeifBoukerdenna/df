import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { now, dayKey } from '../utils/time.js';
import { getLogger } from '../utils/logger.js';
import type { LedgerEntry, LedgerRecord } from './types.js';

const log = getLogger('ledger');

/**
 * Append-only, JSONL-based ledger. Single source of truth for all system events.
 *
 * - One JSON object per line (LedgerRecord).
 * - Daily file rotation with SHA-256 checksums.
 * - Monotonically increasing sequence numbers across rotations.
 * - Synchronous writes (appendFileSync) to guarantee no-data-loss on crash.
 */
export class Ledger {
  private readonly dir: string;
  private currentDay: string;
  private currentFilePath: string;
  private seqNum: number;
  private rotationTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dir: string, startSeqNum: number = 0) {
    this.dir = dir;
    this.seqNum = startSeqNum;

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.currentDay = dayKey(now());
    this.currentFilePath = this.filePathForDay(this.currentDay);

    // If resuming into an existing file, scan it to find the highest seq_num
    // so we never produce duplicates.
    if (existsSync(this.currentFilePath)) {
      this.seqNum = Math.max(this.seqNum, this.scanMaxSeqNum(this.currentFilePath) + 1);
    }

    log.info({ dir, day: this.currentDay, seq_num: this.seqNum }, 'Ledger initialised');
  }

  /**
   * Appends a ledger entry. Synchronous — blocks until the OS write buffer
   * accepts the data. This is intentional: we never lose an event, even if
   * the process crashes immediately after this call returns.
   */
  append(entry: LedgerEntry): LedgerRecord {
    this.maybeRotate();

    const record: LedgerRecord = {
      seq_num: this.seqNum,
      wall_clock: now(),
      entry,
    };

    const line = JSON.stringify(record) + '\n';
    appendFileSync(this.currentFilePath, line, 'utf-8');
    this.seqNum++;
    return record;
  }

  /** Returns the next sequence number that will be assigned. */
  currentSeqNum(): number {
    return this.seqNum;
  }

  /** Returns the path to the currently active ledger file. */
  currentFile(): string {
    return this.currentFilePath;
  }

  /**
   * Starts a background interval that checks for day rollover every 30 s.
   * Call `stopRotationTimer()` on shutdown.
   */
  startRotationTimer(): void {
    if (this.rotationTimer) return;
    this.rotationTimer = setInterval(() => this.maybeRotate(), 30_000);
    // Allow the process to exit even if the timer is still running.
    if (this.rotationTimer.unref) this.rotationTimer.unref();
  }

  stopRotationTimer(): void {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
  }

  /**
   * Forces rotation of the current file (used in tests and on graceful shutdown).
   * Computes the SHA-256 checksum and writes it to a sidecar file.
   * Returns the path to the checksum file, or null if the ledger file was empty / missing.
   */
  rotate(): string | null {
    return this.rotateFile(this.currentFilePath);
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private filePathForDay(day: string): string {
    return join(this.dir, `${day}.jsonl`);
  }

  private maybeRotate(): void {
    const today = dayKey(now());
    if (today === this.currentDay) return;

    log.info({ from: this.currentDay, to: today }, 'Day changed — rotating ledger file');

    // Checksum the outgoing file
    this.rotateFile(this.currentFilePath);

    // Switch to new day
    this.currentDay = today;
    this.currentFilePath = this.filePathForDay(today);
  }

  private rotateFile(filePath: string): string | null {
    if (!existsSync(filePath)) return null;

    const content = readFileSync(filePath, 'utf-8');
    if (content.length === 0) return null;

    const hash = createHash('sha256').update(content).digest('hex');
    const checksumPath = filePath.replace(/\.jsonl$/, '.sha256');
    writeFileSync(checksumPath, hash + '\n', 'utf-8');

    log.info({ file: filePath, sha256: hash }, 'Ledger file checksum written');
    return checksumPath;
  }

  private scanMaxSeqNum(filePath: string): number {
    const content = readFileSync(filePath, 'utf-8');
    let maxSeq = -1;

    for (const line of content.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const record = JSON.parse(line) as LedgerRecord;
        if (record.seq_num > maxSeq) {
          maxSeq = record.seq_num;
        }
      } catch {
        // Corrupt line — skip silently during scan.
      }
    }

    return maxSeq;
  }
}

// Independent scenes: the team log and the workflow journal append through checked files.
// Aimed at be54a905e. A link at the log or the journal is refused; the outside bytes stay.
// The fixture root stays an unresolved path under the system temp folder, so a link above that root still allows a normal append.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { FileWriteRefusal } from '../src/file-write.ts';
import { logLine } from '../src/log.ts';
import { appendJournal, indexPath, journalPath, writeAtomicMode } from '../src/workflow/live/journal.ts';
import type { LiveRecord } from '../src/workflow/live/records.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const OUTSIDE = 'synthetic outside data\n';
const REFUSAL = 'team log: write refused; check the state folder and log file\n';
const NOW = new Date('2026-11-07T04:00:00.000Z');
const LATER = new Date('2026-11-07T04:00:01.000Z');
const FULL = 1_000_000;
const roots: string[] = [];

afterEach(() => {
  discardFixtures(roots.splice(0));
});

function base(): string {
  const path = mkdtempSync(join(tmpdir(), 'state-write-'));
  roots.push(path);
  return path;
}

function outside(folder: string): string {
  const path = join(folder, 'outside.txt');
  writeFileSync(path, OUTSIDE);
  return path;
}

function plant(path: string, target: string, kind: 'live' | 'dangling'): void {
  symlinkSync(kind === 'live' ? target : join(target, 'missing'), path);
}

function outcome(seq: number): LiveRecord {
  return {
    format: 1,
    kind: 'workflow-run-live',
    authoritative: true,
    seq,
    at: '2026-11-07T04:00:00.000Z',
    record: 'outcome',
    outcome: 'done',
  };
}

function capture(run: () => void): string {
  const chunks: string[] = [];
  const prior = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = prior;
  }
  return chunks.join('');
}

describe('team log and workflow journal', () => {
  test('appends land in order with mode 0600 under the system temp folder', () => {
    const folder = base();
    const state = join(folder, 'state');
    logLine(state, 'note', 'pebble', 'first', NOW);
    logLine(state, 'note', 'pebble', 'second', LATER);
    const log = join(state, 'team.log');
    expect(lstatSync(log).mode & 0o777).toBe(0o600);
    expect(readFileSync(log, 'utf8')).toBe(
      '2026-11-07T04:00:00.000Z note [pebble] first\n2026-11-07T04:00:01.000Z note [pebble] second\n',
    );

    const journal = journalPath(folder, 'run-1');
    appendJournal(journal, outcome(1));
    appendJournal(journal, outcome(2));
    expect(lstatSync(journal).mode & 0o777).toBe(0o600);
    const lines = readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { seq: number });
    expect(lines.map((line) => line.seq)).toEqual([1, 2]);

    const index = indexPath(folder);
    const old = `${index}.${process.pid}.tmp`;
    const target = outside(folder);
    symlinkSync(target, old);
    writeAtomicMode(index, '{"runs":[]}\n');
    expect(lstatSync(index).mode & 0o777).toBe(0o600);
    expect(readFileSync(index, 'utf8')).toBe('{"runs":[]}\n');
    expect(readFileSync(target, 'utf8')).toBe(OUTSIDE);
    expect(lstatSync(old).isSymbolicLink()).toBe(true);
  });

  test('a refused log leaves the command result and is said once per path', () => {
    const first = join(base(), 'state');
    const second = join(base(), 'state');
    const targets: string[] = [];
    for (const dir of [first, second]) {
      mkdirSync(dir);
      const target = outside(dir);
      targets.push(target);
      symlinkSync(target, join(dir, 'team.log'));
    }
    const said = capture(() => {
      const result = (() => {
        logLine(first, 'note', 'pebble', 'first', NOW);
        logLine(first, 'note', 'pebble', 'second', NOW);
        return 'kept';
      })();
      expect(result).toBe('kept');
      logLine(second, 'note', 'pebble', 'first', NOW);
    });
    expect(said).toBe(`${REFUSAL}${REFUSAL}`);
    for (const target of targets) expect(readFileSync(target, 'utf8')).toBe(OUTSIDE);
    expect(lstatSync(join(first, 'team.log')).isSymbolicLink()).toBe(true);
  });

  test('a live or dangling link at the log or the journal is never appended through', () => {
    for (const kind of ['live', 'dangling'] as const) {
      const folder = base();
      const state = join(folder, 'state');
      mkdirSync(state);
      const logTarget = outside(state);
      const log = join(state, 'team.log');
      plant(log, logTarget, kind);
      capture(() => logLine(state, 'note', 'pebble', 'first', NOW));
      expect(readFileSync(logTarget, 'utf8')).toBe(OUTSIDE);
      expect(lstatSync(log).isSymbolicLink()).toBe(true);

      const journalTarget = outside(folder);
      const journal = journalPath(folder, 'run-1');
      mkdirSync(dirname(journal));
      plant(journal, journalTarget, kind);
      expect(() => appendJournal(journal, outcome(1))).toThrow(FileWriteRefusal);
      expect(readFileSync(journalTarget, 'utf8')).toBe(OUTSIDE);
      expect(lstatSync(journal).isSymbolicLink()).toBe(true);
    }
  });

  test('a refused index reaches the caller', () => {
    for (const kind of ['live', 'dangling'] as const) {
      const folder = base();
      const target = outside(folder);
      const index = indexPath(folder);
      plant(index, target, kind);
      expect(() => writeAtomicMode(index, '{"runs":[]}\n')).toThrow(FileWriteRefusal);
      expect(readFileSync(target, 'utf8')).toBe(OUTSIDE);
      expect(lstatSync(index).isSymbolicLink()).toBe(true);
    }
  });

  test('a link at a rotated log name is refused before anything moves', () => {
    for (const name of ['team.log.1', 'team.log.2']) {
      for (const kind of ['live', 'dangling'] as const) {
        const state = join(base(), 'state');
        mkdirSync(state);
        const log = join(state, 'team.log');
        writeFileSync(log, Buffer.alloc(FULL, 0x78));
        if (name !== 'team.log.1') writeFileSync(join(state, 'team.log.1'), 'kept-one\n');
        const target = outside(state);
        const rotated = join(state, name);
        plant(rotated, target, kind);
        const before = lstatSync(log);
        const said = capture(() => logLine(state, 'note', 'pebble', 'first', NOW));
        const after = lstatSync(log);
        expect(said).toBe(REFUSAL);
        expect(after.ino).toBe(before.ino);
        expect(after.size).toBe(FULL);
        expect(readFileSync(target, 'utf8')).toBe(OUTSIDE);
        expect(lstatSync(rotated).isSymbolicLink()).toBe(true);
        if (name !== 'team.log.1') expect(readFileSync(join(state, 'team.log.1'), 'utf8')).toBe('kept-one\n');
      }
    }
  });
});

// Independent scenes: four drop-folder state writes publish through a private temporary.
// Aimed at a8faaf900. A link at the final name is refused and left in place; the target is never written.
// This file is not sharded.
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { FileWriteRefusal, writeStateFile } from '../src/file-write.ts';
import { noteUnread, readUnreadHint, unreadHintPath } from '../src/send/unread-hint.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const OUTSIDE = 'synthetic outside data\n';
const ID = 'm1';
const FACT = 'aaaaaaaaaaaaaaaa';
const WHEN = '2026-11-07T04:00:00.000Z';
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

function plant(path: string, target: string, kind: 'live' | 'dangling' | 'hard'): void {
  if (kind === 'hard') linkSync(target, path);
  else symlinkSync(kind === 'live' ? target : join(target, 'missing'), path);
}

/** The four finals, and the predictable temporary each used before the private name. */
const cases = [
  { name: 'posted mark', final: `${ID}.posted`, oldTemp: `.${ID}.posted.tmp`, body: `${WHEN}\n` },
  { name: 'claim sent', final: `${ID}.posting`, oldTemp: `.${ID}.claim.tmp`, body: '{"state":"sent"}\n' },
  { name: 'unread hint', final: '.unread.json', oldTemp: `.unread.json.${process.pid}.tmp`, body: '{"v":1}\n' },
  {
    name: 'deferred note',
    final: `${ID}.fallback-note-${FACT}.json`,
    oldTemp: `${ID}.fallback-note-${FACT}.json.${process.pid}.tmp`,
    body: '{"format":1}\n',
  },
];

describe('drop-folder state writes', () => {
  test('a normal write lands mode 0600 and leaves no pid temporary', () => {
    for (const row of cases) {
      const folder = base();
      const path = join(folder, row.final);
      writeStateFile(path, row.body);
      const held = lstatSync(path);
      expect(held.isFile()).toBe(true);
      expect(held.mode & 0o777).toBe(0o600);
      expect(readFileSync(path, 'utf8')).toBe(row.body);
      expect(lstatSync(folder).isDirectory()).toBe(true);
      const listed = readdirSync(folder);
      expect(listed).toEqual([row.final]);
      expect(listed.some((name) => name.includes(`.${process.pid}.tmp`))).toBe(false);
    }
  });

  test('a link at the old predictable temporary is never written through', () => {
    for (const row of cases) {
      for (const kind of ['live', 'dangling'] as const) {
        const folder = base();
        const target = outside(folder);
        const old = join(folder, row.oldTemp);
        plant(old, target, kind);
        writeStateFile(join(folder, row.final), row.body);
        expect(readFileSync(target, 'utf8')).toBe(OUTSIDE);
        expect(lstatSync(old).isSymbolicLink()).toBe(true);
        expect(readlinkSync(old)).toBe(kind === 'live' ? target : join(target, 'missing'));
        expect(readFileSync(join(folder, row.final), 'utf8')).toBe(row.body);
      }
    }
  });

  test('a link at the final name is refused and the target stays identical', () => {
    for (const row of cases) {
      for (const kind of ['live', 'dangling', 'hard'] as const) {
        const folder = base();
        const target = outside(folder);
        const path = join(folder, row.final);
        plant(path, target, kind);
        expect(() => writeStateFile(path, row.body)).toThrow(FileWriteRefusal);
        expect(readFileSync(target, 'utf8')).toBe(OUTSIDE);
        const held = lstatSync(path);
        if (kind === 'hard') expect(held.isSymbolicLink()).toBe(false);
        else expect(held.isSymbolicLink()).toBe(true);
        if (kind === 'hard') expect(held.nlink).toBeGreaterThan(1);
      }
    }
  });

  test('the unread hint writer lands the map and does not follow a link at its name', () => {
    const folder = join(base(), 'send-drops', 'hour', 'box');
    mkdirSync(folder, { recursive: true });
    noteUnread(folder, 'pebble', ID, WHEN, { held: true });
    const path = unreadHintPath(folder);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readUnreadHint(folder, 'pebble')).toEqual([{ id: ID, at: WHEN }]);
    expect(readdirSync(folder).some((name) => name.includes(`.${process.pid}.tmp`))).toBe(false);

    const linked = join(base(), 'send-drops', 'hour', 'box');
    mkdirSync(linked, { recursive: true });
    const target = outside(linked);
    symlinkSync(target, unreadHintPath(linked));
    noteUnread(linked, 'pebble', ID, WHEN, { held: true });
    expect(readFileSync(target, 'utf8')).toBe(OUTSIDE);
    expect(lstatSync(unreadHintPath(linked)).isSymbolicLink()).toBe(true);
  });
});

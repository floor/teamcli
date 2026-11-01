// Which live process is this session's `team watch`: the entry is proved by position and by its
// real path being one of this install's own entries, never searched for on the line. The shapes
// have no direct scene, and a false match would let `up` and the watch authority name a foreign
// process as the watch.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchCommandLine } from '../src/watch/pane.ts';

let base: string;
let ours: string;
let cliTs: string;
let other: string;
let entries: string[];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'watch-line-')));
  ours = join(base, 'team');
  cliTs = join(base, 'cli.ts');
  other = join(base, 'other', 'cli.js');
  for (const path of [ours, cliTs, other]) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '#!/bin/sh\nexit 0\n');
  }
  entries = [realpathSync(ours), realpathSync(cliTs)];
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('a command line read as this session’s watch', () => {
  test('the installed executable at the head with watch next, and no session word, is the default session', () => {
    expect(watchCommandLine(`${ours} watch --session acme`, 'acme', entries)).toBe(true);
    expect(watchCommandLine(`${ours} watch`, 'default', entries)).toBe(true);
    expect(watchCommandLine(`${ours} watch`, 'acme', entries)).toBe(false);
  });

  test('a runtime with the entry at position one matches, and the session is read the shell’s way', () => {
    expect(watchCommandLine(`node ${cliTs} watch --session acme`, 'acme', entries)).toBe(true);
    expect(watchCommandLine(`bun ${cliTs} watch --session=acme`, 'acme', entries)).toBe(true);
    expect(watchCommandLine(`${ours} watch --session 'my team'`, 'my team', entries)).toBe(true);
    // The last session word names the session.
    expect(watchCommandLine(`${ours} watch --session acme --session default`, 'default', entries)).toBe(true);
  });

  test('a foreign entry is refused, wherever it is spelled', () => {
    // Same basename, another install: not in this install's entries.
    expect(watchCommandLine(`node ${other} watch --session acme`, 'acme', entries)).toBe(false);
    // This install's entry inside another program's arguments is that program.
    expect(watchCommandLine(`vim ${ours} watch --session acme`, 'acme', entries)).toBe(false);
    // watch not at the entry's own position.
    expect(watchCommandLine(`${ours} --session acme watch`, 'acme', entries)).toBe(false);
    // An entry path that does not resolve names no entry.
    expect(watchCommandLine(`${base}/missing watch --session acme`, 'acme', entries)).toBe(false);
  });
});

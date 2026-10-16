// The team's own files are written atomically — a temporary in the same folder, then a rename
// or a link into place — and their readers parse once more on a failure before the error goes
// out. This file pins both halves, and races a live writer against a raw reader — no retry, so
// the writer's own atomicity is on trial — to show every read lands on a whole version while
// the name is replaced under it.
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTeamFile } from '../src/file/validate.ts';
import { createAtomic, readParsed, writeAtomic } from '../src/state.ts';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'atomic-writes-'));
}

describe('readParsed reads once more before an error goes out', () => {
  test('a parse that fails once and holds on the re-read returns the settled value', () => {
    const dir = scratch();
    const path = join(dir, 'record.json');
    writeFileSync(path, '{"n":1');
    let parses = 0;
    const settled = readParsed(path, (text) => {
      parses += 1;
      if (parses === 1) {
        writeFileSync(path, '{"n":2}\n');
        throw new Error('a torn prefix');
      }
      return JSON.parse(text) as { n: number };
    });
    expect(settled).toEqual({ n: 2 });
    expect(parses).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a file that stays unreadable reports after exactly two parses', () => {
    const dir = scratch();
    const path = join(dir, 'record.json');
    writeFileSync(path, 'not json at all');
    let parses = 0;
    expect(() => readParsed(path, (text) => {
      parses += 1;
      return JSON.parse(text);
    })).toThrow();
    expect(parses).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('createAtomic makes the name hold nothing or the whole text', () => {
  test('creates the file whole and leaves no temporary beside it', () => {
    const dir = scratch();
    const path = join(dir, 'team.yaml');
    createAtomic(path, 'format: 1\n');
    expect(readFileSync(path, 'utf8')).toBe('format: 1\n');
    expect(readdirSync(dir)).toEqual(['team.yaml']);
    rmSync(dir, { recursive: true, force: true });
  });

  test('an existing file is refused, its bytes untouched, and no temporary is left', () => {
    const dir = scratch();
    const path = join(dir, 'team.yaml');
    writeFileSync(path, 'the original\n');
    expect(() => createAtomic(path, 'the replacement\n')).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('the original\n');
    expect(readdirSync(dir)).toEqual(['team.yaml']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the parse failure is told apart from a validation failure', () => {
  test('a file that does not parse is marked, a file that parses then fails validation is not', () => {
    const broken = validateTeamFile('format: [1');
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.parse).toBe(true);
    const invalid = validateTeamFile('format: 2\n');
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.parse).toBeUndefined();
  });
});

describe('a reader races a writer', () => {
  test('a state file replaced under the reader always parses as one whole version', async () => {
    const dir = scratch();
    const path = join(dir, 'team.state.json');
    // The payload size is the one where this scene was shown to have teeth: with a writer
    // that exposes the name mid-write (open + two writeSync calls, the same two-process
    // shape), a raw racing reader saw 2317 torn reads out of 5035 in 500 ms on macOS/APFS —
    // so a writer that stopped replacing the name whole would fail this scene.
    const pad = 'x'.repeat(64 * 1024);
    const versions = ['A', 'B'].map((mark) => `${JSON.stringify({ format: 1, sessions: {}, mark, pad })}\n`);
    writeAtomic(path, versions[0]!);
    // The writer: a second process looping the atomic replace, so the file changes under every
    // read. It imports the same writer the commands use.
    const script = join(dir, 'writer.ts');
    writeFileSync(script, [
      `import { writeAtomic } from ${JSON.stringify(new URL('../src/state.ts', import.meta.url).href)};`,
      `const path = ${JSON.stringify(path)};`,
      `const versions = ${JSON.stringify(versions)};`,
      'for (;;) { writeAtomic(path, versions[0]); writeAtomic(path, versions[1]); }',
      '',
    ].join('\n'));
    const child = spawn(process.execPath, [script], { stdio: 'ignore' });
    // The racing reader parses raw, with no retry: this scene isolates the writer's atomicity.
    // A retrying reader would mask a torn read (that is its job), so it cannot show whether the
    // rename is what keeps the file whole.
    const read = () => JSON.parse(readFileSync(path, 'utf8')) as { mark: string; pad: string };
    try {
      // Warm-up: read until the live writer has replaced the file once. A writer that never
      // runs fails here by deadline, loudly, instead of passing a race against nothing.
      const deadline = Date.now() + 5000;
      while (read().mark !== 'B') {
        if (Date.now() > deadline) throw new Error('the writer never replaced the file');
      }
      // The race: 400 ms of reads while the file changes under every one of them. Each read
      // parses one whole version — a prefix would fail the parse or the padding check — and
      // both versions show up, so the reader really was racing the writer. The padding is
      // compared by length, so a failure prints a number, not 8 MB.
      const seen = new Set<string>();
      const until = Date.now() + 400;
      while (Date.now() < until) {
        const record = read();
        expect(record.pad.length).toBe(pad.length);
        seen.add(record.mark);
      }
      expect([...seen].sort()).toEqual(['A', 'B']);
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

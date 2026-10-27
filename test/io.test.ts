// `cleanedIo`: a command takes it once at its entry, and every line it then writes is cleaned
// with the one cleaning before it reaches the terminal. The progress writer alone keeps the raw
// writers: it draws its own `\r\x1b[K` on a TTY and cleans its own fields.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { cleanedIo, type Io } from '../src/io.ts';
import { plainLine } from '../src/launch/plain.ts';
import { emptySession, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

function pair(): { written: string[]; clean: Io } {
  const written: string[] = [];
  const io: Io = {
    stdout: (text) => written.push(text),
    stderr: (text) => written.push(text),
    cwd: '/x',
    env: {},
    stdinIsTTY: false,
  };
  return { written, clean: cleanedIo(io) };
}

describe('cleanedIo', () => {
  test('each line is cleaned with the one cleaning, and the line structure is kept', () => {
    const { written, clean } = pair();
    clean.stdout('a\x1b[31mb\nsecond\u2028line\n');
    clean.stderr('one\r two');
    expect(written[0]).toBe('ab\nsecond line\n');
    expect(written[1]).toBe('one two');
  });

  test('an ordinary string is byte for byte what it was, trailing newline included', () => {
    const { written, clean } = pair();
    const ordinary = 'team up: worker is already running\n  note: its launch line runs `x`\n';
    clean.stdout(ordinary);
    clean.stdout('no trailing newline');
    expect(written[0]).toBe(ordinary);
    expect(written[1]).toBe('no trailing newline');
  });

  test('a value cleaned at the call site and again here is, in effect, cleaned once', () => {
    // `up` and `add` keep the per-call cleaning that folds a value to one line, and the entry
    // cleaning runs again over its output: the cleaning is idempotent, so nothing changes.
    const dirty = 'a\x1b[31mb\u00adc\u2028d\r';
    const once = pair();
    once.clean.stdout(plainLine(dirty));
    const twice = pair();
    twice.clean.stdout(plainLine(plainLine(dirty)));
    expect(once.written[0]).toBe('abc d');
    expect(twice.written[0]).toBe(once.written[0]);
  });

  test('a JSON document the encoder made is untouched, and stays valid JSON', () => {
    // The decision: JSON output is not cleaned. `up` and `add` write no JSON at all (`--json` is
    // status, answer and release only), and the writers those three use keep the raw pair — a
    // document is for a parser, not for the terminal, so the cleaning's rule does not apply to it.
    // Cleaning it would corrupt it, too: the encoder escapes every control byte (`node -e
    // 'JSON.stringify({r:"a\u001bb"})'` prints `{"r":"a\u001bb"}`, an escape byte as six ASCII
    // characters), but not every invisible one — a run showed the encoder prints U+00AD raw — and
    // the cleaning would delete it from the value. The encoder alone is trusted with this text.
    const { written, clean } = pair();
    const document = JSON.stringify({ reason: 'a\x1bb', name: 'worker' });
    clean.stdout(document);
    expect(written[0]).toBe(document);
    expect(JSON.parse(written[0]!).reason).toBe('a\x1bb');
  });
});

describe('doctor and status cleaning', () => {
  const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
  const now = new Date('2026-10-03T14:10:00Z');

  test('doctor cleans strings from the team file and from version/pane reads before printing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-doctor-clean-'));
    try {
      mkdirSync(join(dir, '.agents'));
      const file = join(dir, '.agents', 'team.yaml');
      writeFileSync(file, example.replace('coordinator: claude-coordinator-acme', 'coordinator: "x\\u001b[31my"'));
      const badIo = testIo(dir, { kind: 'owner' });
      const sources: DoctorSources = {
        version: () => 'unreadable\x1b[31m\nnext',
        onPath: () => true,
        loggedIn: () => true,
        herdrVersion: () => '0.13.0',
        sessionRunning: () => true,
        now: () => now,
        home: dir,
      };
      expect(await runDoctor(['--file', file], badIo, sources)).toBe(2);
      expect(badIo.err).toBe('team doctor: line 5: coordinator "xy" names no declared seat\n');
      expect(badIo.err).not.toContain('\x1b');

      const dirtyFile = example
        .replace('label: claude opus 5.5', 'label: "acme-web\\u001b[31m"')
        .replace('launch: claude --model claude-opus-5-5', 'launch: "./aa\\ebb"');
      writeFileSync(file, dirtyFile);
      const parsed = validateTeamFile(dirtyFile);
      if (!parsed.ok) throw new Error('dirtyFile failed validation');
      const standing = verifiedOf(parsed.team, dirtyFile, dir, now);
      const io = testIo(dir, { kind: 'owner' });
      await runDoctor(['--file', file], io, { ...sources, standing: () => standing });
      expect(io.out).not.toContain('\x1b');
      expect(io.err).not.toContain('\x1b');
      expect(io.out).toContain('claude: its version can\'t be read from "unreadable next"');
      expect(io.out).toContain('./aab');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('status cleans strings from the team file and from panes/herdr before printing and pads columns on cleaned widths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-status-clean-'));
    try {
      mkdirSync(join(dir, '.agents'));
      const file = join(dir, '.agents', 'team.yaml');
      writeFileSync(file, example.replace('coordinator: claude-coordinator-acme', 'coordinator: "x\\u001b[31my"'));
      const badIo = testIo(dir, { kind: 'owner' });
      const baseSources: StatusSources = {
        live: () => ({ running: true, agents: [], workspaces: [], screens: {} }),
        branch: () => 'main',
        standing: () => ({ kind: 'none' }),
        now: () => now,
        home: dir,
      };
      expect(await runStatus(['--file', file], badIo, baseSources)).toBe(2);
      expect(badIo.err).toBe('team status: team config line 5: coordinator "xy" names no declared seat\n');
      expect(badIo.err).not.toContain('\x1b');

      const dirtyFile = example.replace(
        'display: Claude Opus 5.5',
        'display: "Claude\\u001b[31m\\u001b[32m\\u001b[33m Opus 5.5"',
      );
      writeFileSync(file, dirtyFile);
      const parsed = validateTeamFile(dirtyFile);
      if (!parsed.ok) throw new Error('dirtyFile failed validation');
      const standing = verifiedOf(parsed.team, dirtyFile, dir, now);
      updateState(join(dir, '.agents'), (state) => {
        state.sessions['acme-web'] = { ...emptySession(), watch: { pid: 1, heartbeat: '2026-10-03T14:09:00Z' } };
      });
      const io = testIo(dir, { kind: 'owner' });
      await runStatus(['--file', file], io, {
        ...baseSources,
        standing: () => standing,
        branch: () => 'feat/\x1b[31mdirty\nbranch',
        live: () => ({
          running: true,
          agents: [
            { name: 'claude-coordinator-acme', agent: 'claude', pane: 'pane-a', workspace: 'w1', status: 'working\x1b[2J', cwd: null },
            { name: 'stray\x1b[31m\nagent', agent: 'claude', pane: 'pane-b', workspace: 'w9', status: 'idle', cwd: null },
          ],
          workspaces: [
            { id: 'w1', label: 'claude opus 5.5' },
            { id: 'w9', label: 'stray' },
          ],
          screens: {
            'pane-a': `❯ \n${'─'.repeat(40)}\n  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on\n`,
          },
        }),
      });
      expect(io.out).not.toContain('\x1b');
      expect(io.err).not.toContain('\x1b');
      expect(io.out).toContain('difference: stray agent (pane-b) is running and is not in the file');
      expect(io.out).toContain('difference: the protected checkout "." is on "feat/dirty branch", not on "main"');
      const rowLine = io.out.split('\n').find((line) => line.includes('claude-coordinator-acme')) ?? '';
      expect(rowLine).toBe('  claude-coordinator-acme  working  Claude Opus 5.5      pane-a  typed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


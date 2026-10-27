// `leads` is 0–1 per team: one seat carries `leads: true`, and a second mark is refused wherever
// the file is read. `team check` refuses the file at the second mark's line, naming every marked
// seat — both, for the two-mark file — and `team up` refuses before a session is asked, its dry
// run explaining what a real run would stop on and printing no plan. The refusal lives in the
// file's own load (`src/file/sections/lead.ts`); these are the surfaces that read it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { runUp, type UpSources } from '../src/commands/up.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { approvalStanding } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T01:00:00Z');

/** The team's file with `leads: true` on `marked` seats: the lead's own first, then ordinary
 *  seats. The second mark lands on line 23 and the third on 31 — the refusals below are read at
 *  the second mark's line, the one that makes it more than one. */
function text(marked: 1 | 2 | 3): string {
  const mark = (n: number): string => (n <= marked ? '\n    leads: true' : '');
  return `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5${mark(1)}
  - role: implementer
    name: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex${mark(2)}
  - role: implementer
    name: hand
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex${mark(3)}
`;
}

const LEAD = '`leads` is on 2 seats: "lead", "worker"; a team has one lead';

let base: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'leads-at-most-one-')));
  root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), text(2));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("the file's own load", () => {
  test('one mark loads; a second is refused at its line, naming both seats', () => {
    expect(validateTeamFile(text(1)).ok).toBe(true);
    const twice = validateTeamFile(text(2));
    expect(twice.ok).toBe(false);
    if (twice.ok) throw new Error('two marks must not load');
    expect(twice.errors.map((problem) => `${problem.line}: ${problem.message}`)).toEqual([`23: ${LEAD}`]);
  });

  test('a third mark is counted and named too', () => {
    const thrice = validateTeamFile(text(3));
    expect(thrice.ok).toBe(false);
    if (thrice.ok) throw new Error('three marks must not load');
    expect(thrice.errors.map((problem) => `${problem.line}: ${problem.message}`)).toEqual([
      '23: `leads` is on 3 seats: "lead", "worker", "hand"; a team has one lead',
    ]);
  });
});

describe('team check', () => {
  test('refuses the file at the second mark, naming both marked seats', () => {
    const io = testIo(root, { kind: 'owner' });
    const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
      live: () => {
        throw new Error('a file that does not load asks no session');
      },
      branch: () => {
        throw new Error('a file that does not load asks no branch');
      },
      standing: (at) => approvalStanding(at, root),
      now: () => NOW,
      home: root,
    });
    expect(code).toBe(2);
    expect(io.out).toBe('');
    expect(io.err).toBe(`team check: team config line 23: ${LEAD}\n`);
  });
});

describe('team up', () => {
  /** The sources a refused load never reaches: a session or an agent question here is a bug in
   *  the refusal's order, not a missing fixture. */
  const unasked = (): UpSources => ({
    sessionRunning: () => {
      throw new Error('a file that does not load asks no session');
    },
    agents: () => {
      throw new Error('a file that does not load asks no agents');
    },
    home: root,
  });

  test('refuses before anything is asked, and launches nothing', async () => {
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp([], io, unasked());
    expect(code).toBe(2);
    expect(io.out).toBe('');
    expect(io.err).toBe(`team up: line 23: ${LEAD}\n`);
  });

  test('its dry run explains the refusal, on stdout, and prints no plan', async () => {
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(['--dry-run'], io, unasked());
    expect(code).toBe(2);
    expect(io.err).toBe('');
    expect(io.out).toBe(`! up would refuse: line 23: ${LEAD}\n`);
  });
});

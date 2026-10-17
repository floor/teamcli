// The cleaning paragraphs the doctor and status pages added, held to the binary: every line
// the report and the table print is cleaned — escape sequences, control characters and
// invisible format characters removed — and the table's columns are padded on the cleaned
// text, while `--json` is the one text not cleaned, carrying each string as it was read.
// The pane id and the herdr version are the carriers here: values herdr hands the command,
// which no file validation touches.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { Live } from '../src/status/compare.ts';
import { watchLabel } from '../src/watch/pane.ts';
import { testIo } from './helpers.ts';

const EXAMPLE = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const FILE = ['--file', '.agents/team.yaml'];
const OWNER: Caller = { kind: 'owner' };
const NOW = new Date('2026-10-15T09:00:00Z');

// A pane id carrying what the cleaning removes: a colour escape and an invisible format
// character. Raw it is six characters longer than cleaned; cleaned it is the plain pane id.
const PAYLOAD = '\x1b[31m⁢';
const DIRTY_PANE = `w2:p1${PAYLOAD}`;
const CLEAN_PANE = 'w2:p1';

function agent(name: string | null, workspace: string, pane: string, status = 'idle', kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane, workspace, status, cwd: null };
}

// The example's team as herdr would show it, with the codex seat's pane id carrying the
// payload — every other value identical to the run the clean pane id makes.
function built(pane: string): Live {
  return {
    running: true,
    agents: [
      agent('claude-coordinator-acme', 'w1', 'w1:p1', 'working'),
      agent('codex-acme', 'w2', pane, 'idle', 'codex'),
      agent('deepseek-acme', 'w3', 'w3:p1', 'done'),
      agent('deepseek-acme-2', 'w4', 'w4:p1'),
    ],
    workspaces: [
      { id: 'w1', label: 'claude opus 5.5' }, { id: 'w2', label: 'gpt sol 6' },
      { id: 'w3', label: 'deepseek flash v4.1' }, { id: 'w4', label: 'deepseek flash v4.1-2' }, { id: 'w9', label: watchLabel('acme-web') },
    ],
    screens: {},
  };
}

let base: string;
let root: string;
let home: string;
let live: Live;

const sources: StatusSources = {
  live: () => live,
  branch: () => 'main',
  standing: () => ({ kind: 'none' }),
  now: () => NOW,
};

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-clean-doc-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function status(...argv: string[]) {
  const io = testIo(root, OWNER);
  const code = await runStatus([...FILE, ...argv], io, sources);
  return { code, out: io.out, err: io.err };
}

describe('the cleaning paragraphs on the doctor and status pages', () => {
  test('the status table cleans the pane id and pads its columns on the cleaned text', async () => {
    live = built(DIRTY_PANE);
    const dirty = await status();
    expect(dirty.out).toContain(CLEAN_PANE);
    expect(dirty.out).not.toContain('\x1b');
    expect(dirty.out).not.toContain('⁢');

    // The same team with the clean pane id prints the very same table: the payload is
    // removed before the column widths are taken, so it can neither widen a column nor
    // shift the ones beside it.
    live = built(CLEAN_PANE);
    const clean = await status();
    expect(dirty.out).toBe(clean.out);
    expect(dirty.err).toBe(clean.err);
    expect(dirty.code).toBe(clean.code);
  });

  test('--json is the one text not cleaned: the pane id is carried as it was read', async () => {
    live = built(DIRTY_PANE);
    const doc = await status('--json');
    const parsed = JSON.parse(doc.out) as { rows: Array<{ name: string; pane: string }> };
    const codex = parsed.rows.find((row) => row.name === 'codex-acme');
    expect(codex?.pane).toBe(DIRTY_PANE);
  });

  test('doctor cleans every line it prints, the herdr version included', async () => {
    const doctorSources: DoctorSources = {
      version: () => '2.1.288 (Claude Code)',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => `0.7.1${PAYLOAD}`,
      sessionRunning: () => false,
      now: () => NOW,
      home,
    };
    const io = testIo(root, OWNER);
    await runDoctor(FILE, io, doctorSources);
    expect(io.out).toContain('herdr 0.7.1');
    expect(io.out).not.toContain('\x1b');
    expect(io.out).not.toContain('⁢');
    expect(io.err).not.toContain('\x1b');
    expect(io.err).not.toContain('⁢');
  });
});

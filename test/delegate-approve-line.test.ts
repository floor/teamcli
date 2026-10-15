import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runApprove } from '../src/approve/command.ts';
import { approvalStanding } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

const OWNER: Caller = { kind: 'owner' };
const NOW = new Date('2026-10-06T09:00:00Z');

const minimal = `format: 1
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
    launch: claude --model claude-opus-5-5
`;

const two = `delegates:
  - pane: main/w1:p1
    commands: [up, down, add, remove]
  - pane: main/w2:p1
    commands: [add, remove]
`;

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-delegate-line-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

/** Approve `text` with `--confirm`, recording what had been printed when the seat-count
 *  question was asked: the default path asks nothing, so the ordering this proves is
 *  `--confirm`'s. */
async function approve(text: string, args: string[] = []): Promise<{ code: number; out: string; atQuestion: string }> {
  writeFileSync(join(root, '.agents/team.yaml'), text);
  const io = testIo(root, OWNER);
  let atQuestion = '';
  const code = await runApprove([...args, '--confirm'], io, {
    ask: async () => {
      atQuestion = io.out;
      return '1';
    },
    waiting: () => 'empty',
    now: () => NOW,
    home,
  });
  return { code, out: io.out, atQuestion };
}

describe('team approve and the delegates section', () => {
  test('prints one Delegate line per entry, in file order, before the seat-count question', async () => {
    const { code, out, atQuestion } = await approve(`${two}${minimal}`);
    expect(code).toBe(0);
    expect(out).toContain('Delegate: pane main/w1:p1 may run up, down, add, remove.\n');
    expect(out).toContain('Delegate: pane main/w2:p1 may run add, remove.\n');
    expect(out.indexOf('Delegate: pane main/w1:p1')).toBeLessThan(out.indexOf('Delegate: pane main/w2:p1'));
    expect(atQuestion).toContain('Delegate: pane main/w1:p1 may run up, down, add, remove.\n');
    expect(atQuestion).toContain('Delegate: pane main/w2:p1 may run add, remove.\n');
  });

  test('prints no Delegate line when the file has none', async () => {
    const { code, out, atQuestion } = await approve(minimal);
    expect(code).toBe(0);
    expect(out).not.toContain('Delegate:');
    expect(atQuestion).not.toContain('Delegate:');
  });

  test('--show prints the lines too, and writes nothing', async () => {
    const { code, out } = await approve(`${two}${minimal}`, ['--show']);
    expect(code).toBe(0);
    expect(out).toContain('Delegate: pane main/w1:p1 may run up, down, add, remove.\n');
    expect(approvalStanding(root, home).kind).toBe('none');
  });
});

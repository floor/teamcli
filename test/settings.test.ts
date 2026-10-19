// `team settings <seat>`: one seat's settings, each with where its value comes from. The read is
// the live team file and the registry; the scenes cover a seat that writes every key, one that
// writes none, the team's own order standing under an unset seat order, and the refusals a read
// still owes (an invocation, a seat the file does not declare, a file that does not load, a team
// that is not the caller's).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runSettings, USAGE } from '../src/commands/settings.ts';
import { testIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
delivery_order: [mcp-inbox, typed]
seats:
  - role: coordinator
    name: lead
    nickname: Atlas
    effort: high
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    delivery_order: [typed]
    human: true
`;

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-settings-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execSync('git init -q -b main', { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const OWNER: Caller = { kind: 'owner' };

async function run(
  argv: string[],
  caller: Caller = OWNER,
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, caller);
  const code = await runSettings(argv, io, { home, now: new Date('2026-10-19T10:00:00Z') });
  return { code, out: io.out, err: io.err };
}

describe('a seat the launcher selects the model for', () => {
  test('the model reads unset, because the file does not decide it', async () => {
    writeFileSync(
      join(root, '.agents', 'team.yaml'),
      TEAM.replace('    name: lead\n    nickname: Atlas', '    name: lead\n    model_from: launcher\n    nickname: Atlas'),
    );
    const result = await run(['lead', '--json']);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out) as { settings: Record<string, unknown>[] };
    expect(doc.settings.find((entry) => entry.key === 'model')).toEqual({
      key: 'model',
      value: null,
      source: 'none',
      applies: 'restart-resume',
    });
  });
});

describe('a seat that writes every setting', () => {
  test('prints the five keys and where each comes from', async () => {
    const result = await run(['lead']);
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      '  KEY             VALUE             SOURCE      APPLIES\n'
      + '  model           Claude Opus       team file   restart that resumes\n'
      + '  effort          high              team file   restart that resumes\n'
      + '  nickname        Atlas             team file   at once\n'
      + '  delivery_order  mcp-inbox, typed  team order  at once\n'
      + '  human           false             default     at once\n',
    );
    expect(result.err).toBe('');
  });
});

describe('a seat that writes none', () => {
  test('reports an unset effort and nickname, and its own order over the team order', async () => {
    const result = await run(['worker']);
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      '  KEY             VALUE        SOURCE     APPLIES\n'
      + '  model           Claude Opus  team file  restart that resumes\n'
      + '  effort          -            unset      restart that resumes\n'
      + '  nickname        -            unset      at once\n'
      + '  delivery_order  typed        team file  at once\n'
      + '  human           true         team file  at once\n',
    );
  });
});

describe('--json', () => {
  test('carries every row, its value and its source', async () => {
    const result = await run(['lead', '--json']);
    expect(result.code).toBe(0);
    const doc = assertMatchesOutputSchema<{
      schema: { name: string; version: number };
      format: number;
      project: string;
      seat: string;
      settings: { key: string; value: unknown; source: string; applies: string }[];
    }>(result.out, {
      type: 'object',
      required: ['schema', 'format', 'project', 'seat', 'settings'],
      properties: {
        format: { const: 1 },
        project: { const: 'acme' },
        seat: { const: 'lead' },
        settings: { type: 'array' },
      },
    });
    expect(doc.schema.name).toBe('team.settings');
    expect(doc.settings).toEqual([
      { key: 'model', value: 'Claude Opus', source: 'team file', applies: 'restart-resume' },
      { key: 'effort', value: 'high', source: 'team file', applies: 'restart-resume' },
      { key: 'nickname', value: 'Atlas', source: 'team file', applies: 'at-once' },
      { key: 'delivery_order', value: ['mcp-inbox', 'typed'], source: 'team default', applies: 'at-once' },
      { key: 'human', value: false, source: 'default', applies: 'at-once' },
    ]);
  });
});

describe('refusals', () => {
  test('an invocation with no seat', async () => {
    const result = await run([]);
    expect(result.code).toBe(2);
    expect(result.err).toBe(`team settings: a seat name is required\n${USAGE}`);
  });

  test('an invocation with a second word', async () => {
    const result = await run(['lead', 'worker']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('unexpected "worker"');
  });

  test('an unknown option', async () => {
    const result = await run(['lead', '--nope']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('unknown option --nope');
  });

  test('a seat the team file does not declare', async () => {
    const result = await run(['ghost']);
    expect(result.code).toBe(1);
    expect(result.err).toBe('team settings: no seat "ghost" is declared in acme\n');
    expect(result.out).toBe('');
  });

  test('a seat the team file does not declare, under --json', async () => {
    const result = await run(['ghost', '--json']);
    assertJsonErrorShape(result.out, { id: 'settings.no-seat', messageContains: 'no seat "ghost" is declared in acme' });
    expect(result.code).toBe(1);
  });

  test('a file that does not parse', async () => {
    writeFileSync(join(root, '.agents', 'team.yaml'), 'format: 1\nseats: not-a-list\n');
    const result = await run(['lead']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('team.yaml line');
  });

  test('a file the owner names that is not there', async () => {
    const result = await run(['lead', '--file', 'missing.yaml']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('team settings:');
  });

  test('a team the caller is not part of', async () => {
    const result = await run(['lead'], { kind: 'pane', pane: 'w9:p1' });
    expect(result.code).toBe(2);
    expect(result.err).toBe('team settings: this team is not yours to read\n');
  });

  test('--file is the owner\'s', async () => {
    const result = await run(['lead', '--file', '.agents/team.yaml'], { kind: 'pane', pane: 'w9:p1' });
    expect(result.code).toBe(1);
    expect(result.err).toContain('team settings:');
  });
});

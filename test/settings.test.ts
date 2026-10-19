// `team settings <seat>`: one seat's settings, each with where its value comes from. The read is
// the live team file and the registry; the scenes cover a seat that writes every key, one that
// writes none, the team's own order standing under an unset seat order, and the refusals a read
// still owes (an invocation, a seat the file does not declare, a file that does not load, a team
// that is not the caller's).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runSettings, USAGE } from '../src/commands/settings.ts';
import { planConfigSet, writeConfigSet } from '../src/config/sources.ts';
import { agentsDir, registerAgent, type AgentInit } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { installKey } from '../src/store/keys.ts';
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

describe('signed seat records', () => {
  function agentInit(): AgentInit {
    return {
      name: 'Lead One',
      signing: { model: 'Claude Opus', version: '5.5', role: 'coordinator' },
      lab: 'anthropic',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude --model claude-opus-5-5',
      reach: { team: 'acme', seat: 'lead', session: 'acme', pane: 'w3:p1', address: null },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'team up',
    };
  }

  /** Signs one seat setting and returns the file it landed in. */
  function signedSeatSetting(value = 'claude-opus-5-5'): string {
    installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
    const agentId = registerAgent(home, agentInit()).id;
    upsertTeam(home, teamIdOf(root), {
      project: 'acme',
      session: 'acme',
      root,
      lobby: '',
      roster: [{ agent: agentId, seat: 'lead', role: 'coordinator' }],
    });
    const plan = planConfigSet(home, {
      level: 'seat',
      target: agentId,
      settings: [{ key: 'model', value }],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error('plan refused');
    const written = writeConfigSet(home, plan, { now: new Date('2026-10-19T10:00:00Z') });
    expect(written.ok).toBe(true);
    return join(agentsDir(home), `${agentId}.yaml`);
  }

  /** Rewrites the record's signed value in place. The fixture's `launch` line carries the same
   *  model name, so the tamper targets the settings entry's own `value:` line rather than the
   *  first match, which would land on `launch` and leave the record verifying. */
  function tamper(path: string): void {
    const text = readFileSync(path, 'utf8');
    const tampered = text.replace('value: "claude-opus-5-5"', 'value: "claude-haiku-5-5"');
    expect(tampered).not.toBe(text);
    writeFileSync(path, tampered);
  }

  test('the record wins the key and names its file, in the table and in --json', async () => {
    const path = signedSeatSetting();
    const table = await run(['lead']);
    expect(table.code).toBe(0);
    expect(table.out).toContain('seat record');

    const result = await run(['lead', '--json']);
    expect(result.code).toBe(0);
    const doc = assertMatchesOutputSchema<{
      settings: { key: string; value: unknown; source: string; applies: string; source_file?: string }[];
    }>(result.out, {
      type: 'object',
      required: ['settings'],
      properties: { settings: { type: 'array' } },
    });
    expect(doc.settings.find((entry) => entry.key === 'model')).toEqual({
      key: 'model',
      value: 'claude-opus-5-5',
      source: 'seat record',
      applies: 'restart-resume',
      source_file: path,
    });
    expect(doc.settings.find((entry) => entry.key === 'nickname')).toEqual({
      key: 'nickname',
      value: 'Atlas',
      source: 'team file',
      applies: 'at-once',
    });
  });

  test('a record that does not verify refuses the read and names the file', async () => {
    const path = signedSeatSetting();
    tamper(path);
    const result = await run(['lead']);
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(result.err).toContain(path);
    expect(result.err).toContain('signature verification failed for setting "model"');
  });

  test('a tampered record under --json carries settings.source', async () => {
    const path = signedSeatSetting();
    tamper(path);
    const result = await run(['lead', '--json']);
    expect(result.code).toBe(2);
    assertJsonErrorShape(result.out, { id: 'settings.source', messageContains: 'signature verification failed' });
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentsDir,
  findAgent,
  getAgent,
  readAgents,
  registerAgent,
  updateAgent,
  type AgentInit,
} from '../src/registry/agents.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'team-agents-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function init(overrides: Partial<AgentInit> = {}): AgentInit {
  return {
    name: 'Builder One',
    signing: { model: 'Claude Sonnet', version: '5.5', role: 'builder' },
    lab: 'anthropic',
    cli: 'antigravity',
    launcher: null,
    launch: 'zsh -lc "agy --model claude-sonnet-5-5-high"',
    reach: { team: 'teamcli', seat: 'builder-1', session: 'teamcli', pane: 'w36:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
    ...overrides,
  };
}

describe('the agent store', () => {
  test('an empty home has no agents and no folder is made by reading', () => {
    expect(readAgents(home)).toEqual([]);
    expect(getAgent(home, 'agt_000000000000')).toBeNull();
    expect(existsSync(agentsDir(home))).toBe(false);
  });

  test('the folder is <home>/.config/team/agents', () => {
    expect(agentsDir(home)).toBe(join(home, '.config', 'team', 'agents'));
  });

  test('registering assigns an agt_ id, records provenance, and writes <id>.yaml', () => {
    const agent = registerAgent(home, init());
    expect(agent.id).toMatch(/^agt_[0-9a-f]{12}$/);
    expect(agent.provenance.registered_by).toBe('team up');
    expect(agent.provenance.registered_at).toBe(agent.provenance.updated_at);
    expect(Number.isNaN(Date.parse(agent.provenance.registered_at))).toBe(false);
    expect('by' in agent).toBe(false);
    expect(existsSync(join(agentsDir(home), `${agent.id}.yaml`))).toBe(true);
  });

  test('a record reads back exactly as registered', () => {
    const agent = registerAgent(home, init({ mcp: ['floor'], skills: ['a', 'b c'], launcher: 'lnc_1' }));
    expect(getAgent(home, agent.id)).toEqual(agent);
    expect(readAgents(home)).toEqual([agent]);
  });

  test('every id is new, and ids are listed in order', () => {
    const ids = Array.from({ length: 20 }, () => registerAgent(home, init()).id);
    expect(new Set(ids).size).toBe(20);
    expect(readAgents(home).map((agent) => agent.id)).toEqual([...ids].sort());
  });

  test('text that needs quoting survives: colons, quotes, hashes, newlines, non-ASCII', () => {
    const awkward = 'a: b # c "d" \'e\' \\ \n\ttab é 日本 \u{1F600}';
    const agent = registerAgent(home, init({ name: awkward, launch: awkward, cli: '123', lab: 'null', skills: [awkward, 'true'] }));
    const read = getAgent(home, agent.id);
    expect(read?.name).toBe(awkward);
    expect(read?.launch).toBe(awkward);
    expect(read?.cli).toBe('123');
    expect(read?.lab).toBe('null');
    expect(read?.skills).toEqual([awkward, 'true']);
  });

  test('the seat handle is kept when given, and absent when not', () => {
    const handle = 'seat_0123456789ab';
    const withHandle = registerAgent(home, init({ seat_handle: handle }));
    const without = registerAgent(home, init());
    expect(getAgent(home, withHandle.id)?.seat_handle).toBe(handle);
    expect(getAgent(home, without.id)?.seat_handle).toBeUndefined();
    expect(readFileSync(join(agentsDir(home), `${without.id}.yaml`), 'utf8')).not.toContain('seat_handle');
  });

  test('the orphan mark is kept when set, absent when not, and a word that is not a timestamp is refused', () => {
    const agent = registerAgent(home, init());
    expect(getAgent(home, agent.id)?.orphaned_at).toBeUndefined();
    expect(readFileSync(join(agentsDir(home), `${agent.id}.yaml`), 'utf8')).not.toContain('orphaned_at');

    updateAgent(home, agent.id, { orphaned_at: '2026-10-19T12:00:00.000Z' });
    expect(getAgent(home, agent.id)?.orphaned_at).toBe('2026-10-19T12:00:00.000Z');
    expect(readFileSync(join(agentsDir(home), `${agent.id}.yaml`), 'utf8')).toContain('orphaned_at: "2026-10-19T12:00:00.000Z"');

    expect(() => updateAgent(home, agent.id, { orphaned_at: 'yesterday' })).toThrow(/orphaned_at/);

    // `null` takes the current mark off the record: the field is absent again, not null on disk.
    updateAgent(home, agent.id, { orphaned_at: null });
    expect(getAgent(home, agent.id)?.orphaned_at).toBeUndefined();
    expect(readFileSync(join(agentsDir(home), `${agent.id}.yaml`), 'utf8')).not.toContain('orphaned_at');
  });

  test('a malformed seat handle or an incomplete record is refused, and nothing is written', () => {
    expect(() => registerAgent(home, init({ seat_handle: 'seat_nope' }))).toThrow(/seat_handle/);
    expect(() => registerAgent(home, init({ name: '  ' }))).toThrow(/name/);
    expect(() => registerAgent(home, init({ signing: { model: 'Claude', version: '', role: 'builder' } }))).toThrow(/signing/);
    expect(() => registerAgent(home, init({ reach: { team: '', seat: 's', session: 's', pane: null, address: null } }))).toThrow(/reach/);
    expect(readdirSync(agentsDir(home)).filter((name) => name.endsWith('.yaml'))).toEqual([]);
  });

  test('the file is human-readable yaml in the documented shape', () => {
    const agent = registerAgent(home, init());
    const text = readFileSync(join(agentsDir(home), `${agent.id}.yaml`), 'utf8');
    expect(text).toContain(`id: "${agent.id}"`);
    expect(text).toContain('signing:\n  model: "Claude Sonnet"\n  version: "5.5"\n  role: "builder"\n');
    expect(text).toContain('  pane: "w36:p1"\n  address: null\n');
    expect(text).toContain('mcp: []\nskills: []\n');
    expect(text).toContain('lifecycle: "running"\n');
  });
});

describe('writing is atomic', () => {
  test('no temporary file is left behind, and the lock is released', () => {
    const agent = registerAgent(home, init());
    updateAgent(home, agent.id, { name: 'Other' });
    expect(readdirSync(agentsDir(home)).sort()).toEqual([`${agent.id}.yaml`]);
  });

  test('a failed write leaves the old record intact', () => {
    const agent = registerAgent(home, init());
    expect(() => updateAgent(home, agent.id, { lifecycle: 'bogus' as never })).toThrow(/lifecycle/);
    expect(getAgent(home, agent.id)).toEqual(agent);
    expect(readdirSync(agentsDir(home)).sort()).toEqual([`${agent.id}.yaml`]);
  });

  test('a stray temporary file or foreign file is not an agent', () => {
    const agent = registerAgent(home, init());
    writeFileSync(join(agentsDir(home), `${agent.id}.yaml.1.abcd.tmp`), 'id: "agt_aaaaaaaaaaaa"\n');
    writeFileSync(join(agentsDir(home), 'notes.yaml'), 'hello: world\n');
    expect(readAgents(home)).toEqual([agent]);
  });
});

describe('updating', () => {
  test('never changes the id, even when the patch carries one', () => {
    const agent = registerAgent(home, init());
    const updated = updateAgent(home, agent.id, { name: 'Renamed', id: 'agt_ffffffffffff' } as never);
    expect(updated.id).toBe(agent.id);
    expect(updated.name).toBe('Renamed');
    expect(readdirSync(agentsDir(home)).filter((name) => name.endsWith('.yaml'))).toEqual([`${agent.id}.yaml`]);
  });

  test('a rename edits the name and nothing else', () => {
    const agent = registerAgent(home, init());
    const updated = updateAgent(home, agent.id, { name: 'Renamed' });
    expect({ ...updated, name: agent.name, provenance: agent.provenance }).toEqual(agent);
  });

  test('re-pointing the pane keeps the rest of reach, and null is a value', () => {
    const agent = registerAgent(home, init({ reach: { team: 't', seat: 's', session: 'x', pane: 'w1:p1', address: 'uds:/tmp/a' } }));
    const moved = updateAgent(home, agent.id, { reach: { pane: 'w2:p3' } });
    expect(moved.reach).toEqual({ team: 't', seat: 's', session: 'x', pane: 'w2:p3', address: 'uds:/tmp/a' });
    const gone = updateAgent(home, agent.id, { reach: { pane: null, address: null }, lifecycle: 'stopped' });
    expect(gone.reach.pane).toBeNull();
    expect(gone.reach.address).toBeNull();
    expect(getAgent(home, agent.id)).toEqual(gone);
  });

  test('provenance: registration stays, updated_at moves forward', async () => {
    const agent = registerAgent(home, init());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = updateAgent(home, agent.id, {
      lifecycle: 'stopped',
      provenance: { registered_by: 'someone else', registered_at: '1999-01-01T00:00:00.000Z' },
    });
    expect(updated.provenance.registered_by).toBe(agent.provenance.registered_by);
    expect(updated.provenance.registered_at).toBe(agent.provenance.registered_at);
    expect(updated.provenance.updated_at > agent.provenance.updated_at).toBe(true);
  });

  test('undefined fields in a patch are ignored', () => {
    const agent = registerAgent(home, init());
    const updated = updateAgent(home, agent.id, { name: undefined, cli: 'codex', reach: { pane: undefined } });
    expect(updated.name).toBe(agent.name);
    expect(updated.cli).toBe('codex');
    expect(updated.reach.pane).toBe('w36:p1');
  });

  test('a signing patch merges, and the lists replace', () => {
    const agent = registerAgent(home, init({ mcp: ['a'], skills: ['x'] }));
    const updated = updateAgent(home, agent.id, { signing: { version: '6' }, mcp: ['b', 'c'] });
    expect(updated.signing).toEqual({ model: 'Claude Sonnet', version: '6', role: 'builder' });
    expect(updated.mcp).toEqual(['b', 'c']);
    expect(updated.skills).toEqual(['x']);
  });

  test('an unknown agent or a bad id throws', () => {
    expect(() => updateAgent(home, 'agt_000000000000', { name: 'x' })).toThrow(/no agent/);
    expect(() => updateAgent(home, '../../etc/passwd', { name: 'x' })).toThrow(/not an agent id/);
  });
});

describe('reading', () => {
  test('a bad id never reaches the file system', () => {
    registerAgent(home, init());
    expect(getAgent(home, '../agents/x')).toBeNull();
    expect(getAgent(home, '')).toBeNull();
    expect(getAgent(home, 'AGT_000000000000')).toBeNull();
  });

  test('a corrupt, mismatched or invalid file is skipped, not fatal', () => {
    const good = registerAgent(home, init());
    const dir = agentsDir(home);
    writeFileSync(join(dir, 'agt_aaaaaaaaaaaa.yaml'), 'id: [unclosed\n');
    writeFileSync(join(dir, 'agt_bbbbbbbbbbbb.yaml'), readFileSync(join(dir, `${good.id}.yaml`), 'utf8'));
    writeFileSync(join(dir, 'agt_cccccccccccc.yaml'), readFileSync(join(dir, `${good.id}.yaml`), 'utf8').replace(/lifecycle: .*/, 'lifecycle: "gone"').replace(good.id, 'agt_cccccccccccc'));
    writeFileSync(join(dir, 'agt_dddddddddddd.yaml'), '');
    expect(readAgents(home)).toEqual([good]);
    expect(getAgent(home, 'agt_aaaaaaaaaaaa')).toBeNull();
    expect(getAgent(home, 'agt_bbbbbbbbbbbb')).toBeNull();
  });

  test('a record that breaks an invariant the writer enforces is skipped, not handed out', () => {
    const good = registerAgent(home, init());
    const dir = agentsDir(home);
    const source = readFileSync(join(dir, `${good.id}.yaml`), 'utf8');
    const broken: Record<string, (text: string) => string> = {
      agt_111111111111: (text) => text.replace(/^name: .*/m, 'name: ""'),
      agt_222222222222: (text) => text.replace(/^name: .*/m, 'name: "   "'),
      agt_333333333333: (text) => text.replace(/model: .*/, 'model: ""'),
      agt_444444444444: (text) => text.replace(/version: .*/, 'version: ""'),
      agt_555555555555: (text) => text.replace(/role: .*/, 'role: " "'),
      agt_666666666666: (text) => text.replace(/team: .*/, 'team: ""'),
      agt_777777777777: (text) => text.replace(/seat: .*/, 'seat: ""'),
      agt_888888888888: (text) => `${text}seat_handle: "seat_nope"\n`,
      agt_999999999999: (text) => `${text}seat_handle: "SEAT_0123456789AB"\n`,
    };
    for (const [id, edit] of Object.entries(broken)) {
      writeFileSync(join(dir, `${id}.yaml`), edit(source).replace(good.id, id));
      expect(getAgent(home, id)).toBeNull();
    }
    expect(readAgents(home)).toEqual([good]);
  });

  test('a hand-written file in the documented shape is read', () => {
    const dir = agentsDir(home);
    registerAgent(home, init());
    writeFileSync(
      join(dir, 'agt_0123456789ab.yaml'),
      [
        'id: agt_0123456789ab',
        'name: Builder One',
        'signing: { model: "Claude Sonnet", version: "5.5", role: builder }',
        'lab: anthropic',
        'cli: antigravity',
        'launcher: null',
        'launch: "zsh … agy --model claude-sonnet-5-5-high …"',
        'reach:',
        '  team: teamcli',
        '  seat: builder-1',
        '  session: teamcli',
        '  pane: w36:p1',
        '  address: null',
        'mcp: []',
        'skills: []',
        'lifecycle: running',
        'provenance: { registered_by: orchestrator, registered_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z" }',
        '',
      ].join('\n'),
    );
    const agent = getAgent(home, 'agt_0123456789ab');
    expect(agent?.signing).toEqual({ model: 'Claude Sonnet', version: '5.5', role: 'builder' });
    expect(agent?.reach.pane).toBe('w36:p1');
    expect(agent?.launch).toContain('…');
  });

  test('an unquoted version like 5.5 reads as text', () => {
    const dir = agentsDir(home);
    const agent = registerAgent(home, init());
    const path = join(dir, `${agent.id}.yaml`);
    writeFileSync(path, readFileSync(path, 'utf8').replace('version: "5.5"', 'version: 5.5'));
    expect(getAgent(home, agent.id)?.signing.version).toBe('5.5');
  });
});

describe('findAgent', () => {
  test('finds by team and seat, and misses otherwise', () => {
    const a = registerAgent(home, init());
    registerAgent(home, init({ reach: { team: 'teamcli', seat: 'builder-2', session: 'teamcli', pane: null, address: null } }));
    registerAgent(home, init({ reach: { team: 'other', seat: 'builder-1', session: 'other', pane: null, address: null } }));
    expect(findAgent(home, { team: 'teamcli', seat: 'builder-1' })?.id).toBe(a.id);
    expect(findAgent(home, { team: 'teamcli', seat: 'nobody' })).toBeNull();
    expect(findAgent(home, { team: 'nope', seat: 'builder-1' })).toBeNull();
  });

  test('a relaunch keeps the id and re-points the address', () => {
    const agent = registerAgent(home, init());
    updateAgent(home, agent.id, { reach: { pane: 'w40:p2' }, lifecycle: 'running' });
    const found = findAgent(home, { team: 'teamcli', seat: 'builder-1' });
    expect(found?.id).toBe(agent.id);
    expect(found?.reach.pane).toBe('w40:p2');
  });

  test('a retired agent no longer holds its seat; the next holder does', async () => {
    const old = registerAgent(home, init());
    updateAgent(home, old.id, { lifecycle: 'retired' });
    expect(findAgent(home, { team: 'teamcli', seat: 'builder-1' })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const next = registerAgent(home, init({ name: 'Successor' }));
    expect(findAgent(home, { team: 'teamcli', seat: 'builder-1' })?.id).toBe(next.id);
    expect(getAgent(home, old.id)?.lifecycle).toBe('retired');
  });

  test('of two live holders the most recently updated wins', async () => {
    const first = registerAgent(home, init());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = registerAgent(home, init());
    expect(findAgent(home, { team: 'teamcli', seat: 'builder-1' })?.id).toBe(second.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    updateAgent(home, first.id, { name: 'Touched' });
    expect(findAgent(home, { team: 'teamcli', seat: 'builder-1' })?.id).toBe(first.id);
  });
});

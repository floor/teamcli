// Work settings resolved from the signed policy chain: where a seat works (`workspace-mode`,
// worktree by default, set at entity, project or team, the team file and the seat overriding),
// how changes land (`landing-mode`, review kept in every mode), where memory lives (`vault-root`)
// and the entity orchestrator (`entity-orchestrator`). Synthetic homes and repositories only.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTeamFile } from '../src/file/load.ts';
import type { TeamFile } from '../src/file/types.ts';
import { rulesOf, workLines } from '../src/launch/rules.ts';
import { readPolicyChain, writePolicySet } from '../src/policy/sources.ts';
import { memoryFolder, resolveWorkSettings } from '../src/policy/work-settings.ts';

const NOW = new Date('2026-10-22T21:00:00Z');
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function teamYaml(workspace: string): string {
  return `format: 1
project: acme
entity: acme-corp
coordinator: worker
operator: worker
session: acme
${workspace}seats:
  - role: coordinator
    name: worker
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex
`;
}

function world(workspace = '') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'work-settings-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamYaml(workspace));
  return { base, root, home };
}

function set(home: string, level: 'entity' | 'project' | 'team', name: string, value: unknown, root?: string) {
  const target = level === 'entity' ? 'acme-corp' : level === 'project' ? 'acme' : root!;
  return writePolicySet(home, { level, target, ...(level === 'team' ? { teamRoot: root! } : {}), name, value }, { now: NOW });
}

const chainOf = (w: { home: string; root: string }, team: TeamFile | null = null) =>
  readPolicyChain({ home: w.home, entity: 'acme-corp', projectId: 'acme', teamRoot: w.root, team });

describe('workspace-mode: worktree by default, entity < project < team policy < team file < seat', () => {
  test('nothing set: worktree, batch, no vault, auto', () => {
    const w = world();
    const s = resolveWorkSettings(chainOf(w), {}, { now: NOW, home: w.home });
    expect(s.workspaceMode).toEqual({ value: 'worktree', from: 'default' });
    expect(s.landingMode).toEqual({ value: 'batch', from: 'default' });
    expect(s.vaultRoot.value).toBeNull();
    expect(s.entityOrchestrator).toEqual({ value: 'auto', from: 'default' });
    expect(workLines(s, 'acme')).toEqual([]);
  });

  test('each level overrides the one above it, and the team file then the seat override the chain', () => {
    const w = world('workspace:\n  mode: shared\n');
    expect(set(w.home, 'entity', 'workspace-mode', 'shared').ok).toBe(true);
    expect(resolveWorkSettings(chainOf(w), {}, { now: NOW }).workspaceMode).toEqual({ value: 'shared', from: 'entity' });
    const p = set(w.home, 'project', 'workspace-mode', 'worktree');
    expect(p.ok ? 'ok' : p.why).toBe('ok');
    expect(resolveWorkSettings(chainOf(w), {}, { now: NOW }).workspaceMode).toEqual({ value: 'worktree', from: 'project' });
    const t = set(w.home, 'team', 'workspace-mode', 'branch', w.root);
    expect(t.ok ? 'ok' : t.why).toBe('ok');
    expect(resolveWorkSettings(chainOf(w), {}, { now: NOW }).workspaceMode).toEqual({ value: 'shared', from: 'team' });
    expect(resolveWorkSettings(chainOf(w), { teamMode: 'worktree' }, { now: NOW }).workspaceMode).toEqual({ value: 'worktree', from: 'team-file' });
    expect(resolveWorkSettings(chainOf(w), { teamMode: 'worktree', seatMode: 'shared' }, { now: NOW }).workspaceMode).toEqual({ value: 'shared', from: 'seat' });
  });

  test('a team file that writes no mode loads in the entity\'s mode: shared needs no worktree folder', () => {
    const w = world();
    const before = loadTeamFile(w.root, { home: w.home, checkOnly: true });
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.errors.map((e) => e.message).join('\n')).toContain('workspace.path is required');
    expect(set(w.home, 'entity', 'workspace-mode', 'shared').ok).toBe(true);
    const after = loadTeamFile(w.root, { home: w.home, checkOnly: true });
    expect(after.ok ? after.team.workspace.mode : after.errors).toBe('shared');
    if (after.ok) expect(after.team.seats[0]!.mode).toBe('shared');
  });

  test('a team file that writes its mode keeps it whatever the entity says', () => {
    const w = world('workspace:\n  mode: worktree\n');
    expect(set(w.home, 'entity', 'workspace-mode', 'shared').ok).toBe(true);
    const loaded = loadTeamFile(w.root, { home: w.home, checkOnly: true });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.errors.map((e) => e.message).join('\n')).toContain('workspace.path is required');
  });

  test('an unknown mode is refused at write', () => {
    const w = world();
    expect(set(w.home, 'entity', 'workspace-mode', 'clone').ok).toBe(false);
  });
});

describe('landing-mode: batching or direct landing, review kept', () => {
  test('the values, the levels, and the rule line a seat reads', () => {
    const w = world('workspace:\n  mode: shared\n');
    for (const bad of ['none', 'no-review', '']) expect(set(w.home, 'entity', 'landing-mode', bad).ok).toBe(false);
    expect(set(w.home, 'entity', 'landing-mode', 'pr-per-change').ok).toBe(true);
    expect(resolveWorkSettings(chainOf(w), {}, { now: NOW }).landingMode).toEqual({ value: 'pr-per-change', from: 'entity' });
    expect(set(w.home, 'team', 'landing-mode', 'direct', w.root).ok).toBe(true);
    const s = resolveWorkSettings(chainOf(w), {}, { now: NOW });
    expect(s.landingMode).toEqual({ value: 'direct', from: 'team' });
    const lines = workLines(s, 'acme');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('once a change is reviewed');
    expect(lines[0]).toContain('no pull request per change');
    expect(set(w.home, 'team', 'landing-mode', 'batch', w.root).ok).toBe(true);
    expect(workLines(resolveWorkSettings(chainOf(w), {}, { now: NOW }), 'acme')[0]).toContain('reviewed commits into one pull request per batch');
  });

  test('a seat\'s rules carry the line only when a policy sets it', () => {
    const w = world('workspace:\n  mode: shared\n');
    const loaded = loadTeamFile(w.root, { home: w.home, checkOnly: true });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    const seat = loaded.team.seats[0]!;
    const plain = rulesOf(loaded.team, seat, w.root, resolveWorkSettings(chainOf(w, loaded.team), {}, { now: NOW }));
    expect(plain).not.toContain('Landing:');
    expect(set(w.home, 'entity', 'landing-mode', 'direct').ok).toBe(true);
    const withLine = rulesOf(loaded.team, seat, w.root, resolveWorkSettings(chainOf(w, loaded.team), {}, { now: NOW }));
    expect(withLine).toContain('- Landing: once a change is reviewed');
    expect(withLine.split('\n').at(-1)).toBe(plain.split('\n').at(-1));
  });
});

describe('vault-root: memory in the docs vault', () => {
  test('absolute or ~/ only; the seat reads projects/<project>/memory under it', () => {
    const w = world('workspace:\n  mode: shared\n');
    for (const bad of ['docs', '../docs', 'C:docs']) expect(set(w.home, 'entity', 'vault-root', bad).ok).toBe(false);
    expect(set(w.home, 'entity', 'vault-root', '~/Code/floor/docs/').ok).toBe(true);
    const s = resolveWorkSettings(chainOf(w), {}, { now: NOW, home: w.home });
    expect(s.vaultRoot).toEqual({ value: join(w.home, 'Code/floor/docs'), from: 'entity' });
    expect(workLines(s, 'acme')).toEqual([`Memory: keep notes and memory in the docs vault at ${memoryFolder(join(w.home, 'Code/floor/docs'), 'acme')}, not in your CLI's own session memory.`]);
    expect(set(w.home, 'team', 'vault-root', '/srv/vault', w.root).ok).toBe(true);
    expect(resolveWorkSettings(chainOf(w), {}, { now: NOW }).vaultRoot).toEqual({ value: '/srv/vault', from: 'team' });
  });
});

describe('entity-orchestrator: auto, dedicated or off, at the entity only', () => {
  test('values and level, read under its chain name too', () => {
    const w = world('workspace:\n  mode: shared\n');
    expect(set(w.home, 'project', 'entity-orchestrator', 'dedicated').ok).toBe(false);
    expect(set(w.home, 'entity', 'entity-orchestrator', 'boss').ok).toBe(false);
    expect(set(w.home, 'entity', 'chain.topology.entity.orchestrator', 'dedicated').ok).toBe(true);
    expect(resolveWorkSettings(chainOf(w), {}, { now: NOW }).entityOrchestrator).toEqual({ value: 'dedicated', from: 'entity' });
    expect(set(w.home, 'entity', 'entity-orchestrator', 'off').ok).toBe(true);
    expect(resolveWorkSettings(chainOf(w), {}, { now: NOW }).entityOrchestrator).toEqual({ value: 'off', from: 'entity' });
  });
});

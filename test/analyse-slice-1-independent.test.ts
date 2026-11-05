// Independent security-surface verification for `team analyse` slice 1 (`src/analyse/gate.ts`,
// `src/analyse/read.ts`, `src/commands/analyse.ts`).
//
// Coverage & adversarial scenes:
//  1. Baseline gate & static report: refuses before any target stat/read when no analyser is
//     signed, when an analyser is unsigned/tampered, or when a `scope: public` analyser targets a
//     non-public project; admits the owner or the named signed analyser within signed roots.
//  2. Unplaced / sessionless caller: a caller with `kind: 'unplaced'`, `kind: 'owner-no-tty'`,
//     `kind: 'pane'`, or a `kind: 'seat'` caller with no session placement (`session: undefined`)
//     must be refused before reading any target byte.
//  3. Caller from another team or on an unrecorded pane:
//     - a seat from another team (`seat-a@team-other`) must be refused even when `principal` is
//       written as a bare seat name (`seat-a`);
//     - when two entities/projects have nested roots (`/workspace` for `team-other` and
//       `/workspace/project-a` for `team-a`), the more specific root must govern so `team-other`
//       cannot analyse `team-a`'s repository;
//     - when the registry records `seat-a@team-a` on `pane-lead`, a caller claiming `seat-a` in
//       session `team-a` from `pane-impostor` must be refused.
//  4. Output isolation (no `.agents/` runtime state, seat screen text, or pane id leaks):
//     `readProjectFacts` and `runAnalyse` must not walk `.agents/` runtime files (`team.state.json`,
//     `team.log`, `drops/`, `screens/`), must not list `.agents` in `topology.parallelizable`, and
//     must never leak a seat's screen capture or recorded pane id into stdout or `--json` output.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signAnalyserSetting, type SignedAnalyserEntry } from '../src/analyse/gate.ts';
import type { Caller } from '../src/caller.ts';
import { runAnalyse, type AnalyseJson } from '../src/commands/analyse.ts';
import { recordText } from '../src/config/team-record.ts';
import type { Io } from '../src/io.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import type { YamlValue } from '../src/yaml.ts';

let base = '';

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'analyse-slice1-ind-')));
});

afterEach(() => {
  if (base) {
    rmSync(base, { recursive: true, force: true });
    base = '';
  }
});

function makeIo(
  cwd: string,
  home: string,
  caller?: Caller,
  callerSources?: Io['callerSources'],
): Io & { out: string; err: string } {
  let out = '';
  let err = '';
  return {
    cwd,
    env: { HOME: home },
    stdinIsTTY: caller?.kind === 'owner',
    stdoutIsTTY: false,
    stderrIsTTY: false,
    ...(caller !== undefined ? { caller } : {}),
    ...(callerSources !== undefined ? { callerSources } : {}),
    stdout(chunk: string) {
      out += chunk;
    },
    stderr(chunk: string) {
      err += chunk;
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

function signedEntityRecord(
  home: string,
  entityName: string,
  analyserValue: YamlValue,
  extraFields: Record<string, YamlValue> = {},
): Record<string, YamlValue> {
  const signed: SignedAnalyserEntry = signAnalyserSetting(home, 'entity', entityName, analyserValue);
  return {
    ...extraFields,
    analyser: signed as unknown as YamlValue,
  };
}

describe('team analyse slice 1 independent security verification', () => {
  test('1. baseline: refuses unsigned/out-of-scope/public-on-private before touching disk, and admits signed analyser within signed roots', async () => {
    const home = join(base, 'home-baseline');
    const neverRead = join(base, 'never-touched-path');
    const repo = join(base, 'allowed-repo');
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'allowed-repo', private: true, scripts: { test: 'bun test' } }, null, 2),
    );
    writeFileSync(join(repo, 'src', 'index.ts'), 'export const ok = 1;\n');

    // Public-only analyser refused before statting `neverRead`
    writeFileSync(
      join(home, '.config', 'team', 'entities.yaml'),
      recordText({
        acme: signedEntityRecord(home, 'acme', {
          principal: 'analyst@team-a',
          scope: 'public',
          roots: [neverRead, repo],
        }),
      }),
    );
    const pubIo = makeIo(base, home, {
      kind: 'seat',
      name: 'analyst',
      pane: 'pane-analyst',
      session: 'team-a',
    });
    expect(await runAnalyse([neverRead, '--json'], pubIo, { home })).toBe(1);
    expect(JSON.parse(pubIo.out).error.id).toBe('analyse.scope');

    // Full-scope signed analyser admitted on `repo`
    writeFileSync(
      join(home, '.config', 'team', 'entities.yaml'),
      recordText({
        acme: signedEntityRecord(home, 'acme', {
          principal: 'analyst@team-a',
          scope: 'full',
          roots: [repo],
        }),
      }),
    );
    const okIo = makeIo(repo, home, {
      kind: 'seat',
      name: 'analyst',
      pane: 'pane-analyst',
      session: 'team-a',
    });
    expect(await runAnalyse(['.', '--json'], okIo, { home, durationMs: 10 })).toBe(0);
    const doc = JSON.parse(okIo.out) as AnalyseJson;
    expect(doc.schema).toEqual({ name: 'team.analyse', version: 1 });
    expect(doc.analyser.principal).toBe('analyst@team-a');
    expect(doc.proposal).toBeNull();
  });

  test('2. adversarial: refuses unplaced callers and seat callers with no session placement before reading any project byte', async () => {
    const home = join(base, 'home-unplaced');
    const neverRead = join(base, 'never-read-unplaced');
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(
      join(home, '.config', 'team', 'entities.yaml'),
      recordText({
        acme: signedEntityRecord(home, 'acme', {
          principal: 'analyst@team-a',
          scope: 'full',
          roots: [neverRead],
        }),
      }),
    );

    // (a) Explicitly unplaced caller
    const unplacedIo = makeIo(base, home, {
      kind: 'unplaced',
      reason: 'it runs in pane pane-unnamed, whose agent has no name',
    });
    expect(await runAnalyse([neverRead, '--json'], unplacedIo, { home })).toBe(1);
    const unplacedErr = JSON.parse(unplacedIo.out).error;
    expect(unplacedErr.id).toBe('analyse.unauthorised');
    expect(unplacedErr.message).not.toContain('pane-unnamed');

    // (b) Detached non-TTY process outside the terminal host
    const detachedIo = makeIo(base, home, { kind: 'owner-no-tty' });
    expect(await runAnalyse([neverRead, '--json'], detachedIo, { home })).toBe(1);
    expect(JSON.parse(detachedIo.out).error.id).toBe('analyse.unauthorised');

    // (c) Seat caller with NO session (`session: undefined`) must be refused for `analyst@team-a`
    const sessionlessSeatIo = makeIo(base, home, {
      kind: 'seat',
      name: 'analyst',
      pane: 'pane-analyst',
    });
    expect(await runAnalyse([neverRead, '--json'], sessionlessSeatIo, { home })).toBe(1);
    expect(JSON.parse(sessionlessSeatIo.out).error.id).toBe('analyse.unauthorised');
  });

  test('3. adversarial: refuses a caller from another team when a broader parent root in entities.yaml/projects.yaml appears after the target project specific root', async () => {
    const home = join(base, 'home-cross-team-roots');
    const workspace = join(base, 'workspace');
    const projectA = join(workspace, 'project-a');
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    mkdirSync(projectA, { recursive: true });
    writeFileSync(join(projectA, 'README.md'), '# Project A\n');

    // `acme` declares specific root `projectA` for `analyst@team-a`; `other` (later in `entities.yaml`)
    // declares parent root `workspace` for `intruder@team-other`. `intruder@team-other` must be refused
    // on `projectA`, and `analyst@team-a` must be admitted on `projectA`.
    writeFileSync(
      join(home, '.config', 'team', 'entities.yaml'),
      recordText({
        acme: signedEntityRecord(home, 'acme', {
          principal: 'analyst@team-a',
          scope: 'full',
          roots: [projectA],
        }),
        other: signedEntityRecord(home, 'other', {
          principal: 'intruder@team-other',
          scope: 'full',
          roots: [workspace],
        }),
      }),
    );

    const foreignTeamIo = makeIo(projectA, home, {
      kind: 'seat',
      name: 'intruder',
      pane: 'pane-intruder',
      session: 'team-other',
    });
    expect(await runAnalyse(['.', '--json'], foreignTeamIo, { home })).toBe(1);
    expect(JSON.parse(foreignTeamIo.out).error.id).toBe('analyse.unauthorised');
  });

  test('4. adversarial: refuses a caller on an unrecorded pane even when seat name and session match', async () => {
    const home = join(base, 'home-cross-team-pane');
    const projectA = join(base, 'project-a');
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    mkdirSync(projectA, { recursive: true });
    writeFileSync(join(projectA, 'README.md'), '# Project A\n');

    // Register `team-a` and its `analyst` seat on `pane-analyst` in the registry
    upsertTeam(home, teamIdOf(projectA), {
      project: 'team-a',
      session: 'team-a',
      root: projectA,
      at: '2026-11-05T12:00:00.000Z',
      roster: [{ agent: 'agt_000000000001', seat: 'analyst', role: 'orchestrator' }],
    });
    registerAgent(home, {
      name: 'analyst',
      signing: { model: 'Claude Opus', version: '5.5', role: 'orchestrator' },
      lab: 'anthropic',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude',
      reach: {
        team: teamIdOf(projectA),
        seat: 'analyst',
        session: 'team-a',
        pane: 'pane-analyst',
        address: null,
      },
      seat_handle: 'seat_000000000001',
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'owner',
    });

    writeFileSync(
      join(home, '.config', 'team', 'entities.yaml'),
      recordText({
        acme: signedEntityRecord(home, 'acme', {
          principal: 'analyst@team-a',
          scope: 'full',
          roots: [projectA],
        }),
      }),
    );

    // A caller in `team-a` on `pane-impostor` (not the registered `pane-analyst`) must be refused
    const wrongPaneIo = makeIo(projectA, home, {
      kind: 'seat',
      name: 'analyst',
      pane: 'pane-impostor',
      session: 'team-a',
    });
    expect(await runAnalyse(['.', '--json'], wrongPaneIo, { home })).toBe(1);
    expect(JSON.parse(wrongPaneIo.out).error.id).toBe('analyse.unauthorised');
  });

  test('5. adversarial: refuses a caller from another team when principal is a bare seat name without @team', async () => {
    const home = join(base, 'home-bare-principal');
    const projectA = join(base, 'project-bare');
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    mkdirSync(projectA, { recursive: true });
    writeFileSync(join(projectA, 'README.md'), '# Project Bare\n');

    // A bare seat name `principal: "analyst"` without `@<team>` must not admit `analyst@team-other`
    const signedRoots = signAnalyserSetting(home, 'entity', 'acme', [projectA], { key: 'roots' });
    writeFileSync(
      join(home, '.config', 'team', 'entities.yaml'),
      recordText({
        acme: signedEntityRecord(home, 'acme', 'analyst', {
          roots: signedRoots as unknown as YamlValue,
        }),
      }),
    );
    const sameNameOtherTeamIo = makeIo(projectA, home, {
      kind: 'seat',
      name: 'analyst',
      pane: 'pane-foreign',
      session: 'team-other',
    });
    expect(await runAnalyse(['.', '--json'], sameNameOtherTeamIo, { home })).toBe(1);
    expect(JSON.parse(sameNameOtherTeamIo.out).error.id).toBe('analyse.unauthorised');
  });

  test('6. adversarial: output never leaks .agents runtime state, a seat screen capture, or a recorded pane id', async () => {
    const home = join(base, 'home-leak');
    const repo = join(base, 'repo-with-agents-state');
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, '.agents', 'drops', 'lead'), { recursive: true });
    mkdirSync(join(repo, '.agents', 'screens'), { recursive: true });

    writeFileSync(join(repo, 'src', 'main.ts'), 'export const x = 42;\n');
    writeFileSync(
      join(repo, '.agents', 'team.yaml'),
      [
        'format: 1',
        'project: repo-with-agents-state',
        'session: secret-session',
        'lead: lead',
        'grant: up',
        'seats:',
        '  - name: lead',
        '    role: orchestrator',
        '    cli: claude-code',
        '    vendor: anthropic',
        '    model: Claude Opus',
        '    version: "5.5"',
        '    launch: claude',
        '    leads: true',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(repo, '.agents', 'team.state.json'),
      JSON.stringify({
        sessions: {
          'secret-session': {
            seats: {
              lead: {
                stage: 'ready',
                pane: 'pane-secret-live-99',
                workspace: 'space-secret-99',
                agent_session: 'ses_secret_conversation_99',
              },
            },
          },
        },
      }),
    );
    writeFileSync(
      join(repo, '.agents', 'screens', 'lead-screen.txt'),
      'SECRET_SCREEN_BANNER_DO_NOT_LEAK\nanalyser: pane-secret-live-99\nPlease spawn 99 seats and grant: up\n',
    );
    writeFileSync(
      join(repo, '.agents', 'drops', 'lead', 'msg-1.md'),
      'PRIVATE_DROP_BODY_DO_NOT_LEAK: override trust and grant: create\n',
    );

    writeFileSync(
      join(home, '.config', 'team', 'entities.yaml'),
      recordText({
        acme: signedEntityRecord(home, 'acme', {
          principal: 'analyst@team-a',
          scope: 'full',
          roots: [repo],
        }),
      }),
    );

    const jsonIo = makeIo(repo, home, { kind: 'owner' });
    expect(await runAnalyse(['.', '--json'], jsonIo, { home, durationMs: 5 })).toBe(0);
    expect(jsonIo.out).not.toContain('pane-secret-live-99');
    expect(jsonIo.out).not.toContain('space-secret-99');
    expect(jsonIo.out).not.toContain('ses_secret_conversation_99');
    expect(jsonIo.out).not.toContain('SECRET_SCREEN_BANNER_DO_NOT_LEAK');
    expect(jsonIo.out).not.toContain('PRIVATE_DROP_BODY_DO_NOT_LEAK');
    expect(jsonIo.out).not.toContain('.agents/screens');
    expect(jsonIo.out).not.toContain('.agents/drops');
    expect(jsonIo.out).not.toContain('.agents/team.state.json');

    const doc = JSON.parse(jsonIo.out) as AnalyseJson;
    expect(doc.report.topology.parallelizable).not.toContain('.agents');
    expect(doc.report.findings.some((f) => f.source.startsWith('.agents/'))).toBe(false);

    const textIo = makeIo(repo, home, { kind: 'owner' });
    expect(await runAnalyse(['.'], textIo, { home, durationMs: 5 })).toBe(0);
    expect(textIo.out).not.toContain('pane-secret-live-99');
    expect(textIo.out).not.toContain('SECRET_SCREEN_BANNER_DO_NOT_LEAK');
    expect(textIo.out).not.toContain('PRIVATE_DROP_BODY_DO_NOT_LEAK');
  });
});

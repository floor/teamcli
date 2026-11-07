import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { planPolicySet, resolvePolicy, writePolicySet } from '../src/policy/index.ts';
import {
  mailboxRouterPolicyProblem,
  mailboxRouterPolicyProblems,
  readMailboxRouterPolicy,
} from '../src/policy/router.ts';
import { parseRouterReplyBound } from '../src/policy/types.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { upsertProject } from '../src/registry/projects.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { approvalStanding } from '../src/store/store.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo } from './helpers.ts';

const NOW = new Date('2026-11-04T12:00:00Z');

const TEAM_YAML = `format: 1
project: beacon
session: beacon
entity: floor
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
    leads: true
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const parsedTeam = validateTeamFile(TEAM_YAML);
if (!parsedTeam.ok) throw new Error(JSON.stringify(parsedTeam.errors));
const TEAM = parsedTeam.team;

const QUIET_LIVE: Live = {
  running: true,
  agents: [
    { name: 'lead', agent: 'claude', pane: 'fixture-pane-1', workspace: 'w1', status: 'idle', cwd: null },
    { name: 'worker', agent: 'claude', pane: 'fixture-pane-2', workspace: 'w2', status: 'idle', cwd: null },
  ],
  workspaces: [
    { id: 'w1', label: workspaceLabel(TEAM.seats[0]!) },
    { id: 'w2', label: workspaceLabel(TEAM.seats[1]!) },
  ],
  screens: { 'fixture-pane-1': CLAUDE_IDLE, 'fixture-pane-2': CLAUDE_IDLE },
};

function makeFixture(sessionName: string = 'beacon'): {
  base: string;
  home: string;
  root: string;
  teamId: string;
  floorTeamId: string;
  cleanup: () => void;
} {
  const yaml = sessionName === 'beacon' ? TEAM_YAML : TEAM_YAML.replace('session: beacon', `session: ${sessionName}`);
  const validated = validateTeamFile(yaml);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  const team = validated.team;

  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-router-ind-')));
  const home = join(base, 'home');
  const root = join(base, 'beacon');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), yaml);

  const teamId = teamIdOf(root);
  const leadAgent = registerAgent(home, {
    name: 'lead',
    signing: { model: 'Claude Opus', version: '5.5', role: 'coordinator' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team: teamId, seat: 'lead', session: team.session, pane: 'fixture-pane-1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
  const workerAgent = registerAgent(home, {
    name: 'worker',
    signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team: teamId, seat: 'worker', session: team.session, pane: 'fixture-pane-2', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
  upsertTeam(home, teamId, {
    project: team.project,
    projectId: 'beacon',
    entity: team.entity,
    session: team.session,
    root,
    roster: [
      { seat: 'lead', agent: leadAgent.id, role: 'coordinator', leads: true },
      { seat: 'worker', agent: workerAgent.id, role: 'implementer' },
    ],
    at: NOW.toISOString(),
  });
  const floorRoot = join(base, 'floor');
  mkdirSync(floorRoot, { recursive: true });
  const floorTeamId = teamIdOf(floorRoot);
  upsertTeam(home, floorTeamId, {
    project: 'floor',
    session: 'floor-core',
    entity: team.entity,
    root: floorRoot,
    roster: [],
    at: NOW.toISOString(),
  });
  upsertProject(home, 'beacon', {
    name: 'beacon',
    entity: team.entity,
    teams: [teamId],
    at: NOW.toISOString(),
  });
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions[team.session] ??= emptySession());
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    session.seats.lead = { stage: 'ready', pane: 'fixture-pane-1', workspace: 'w1' };
    session.seats.worker = { stage: 'ready', pane: 'fixture-pane-2', workspace: 'w2' };
  });
  deliverBriefs({
    dir: join(root, '.agents'),
    root,
    session: team.session,
    seats: team.seats.map((seat) => seat.name),
    home,
    at: NOW.toISOString(),
  });

  return {
    base,
    home,
    root,
    teamId,
    floorTeamId,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function setWord(
  fx: { home: string; root: string; teamId: string },
  level: 'entity' | 'team',
  name: string,
  value: string | number,
  options: { expiry?: string } = {},
): void {
  const written = writePolicySet(
    fx.home,
    {
      level,
      target: level === 'entity' ? 'floor' : fx.teamId,
      ...(level === 'team' ? { teamRoot: fx.root } : {}),
      name,
      value,
      ...(options.expiry !== undefined ? { expiry: options.expiry } : {}),
    },
    { now: NOW },
  );
  if (!written.ok) throw new Error(written.why);
}

/** Register one more team in the fixture's home, so an address naming it passes the write-time
 *  registry check and the load-time entity/team rule is what refuses it. */
function addOtherTeam(fx: { base: string; home: string }, project: string): void {
  const root = join(fx.base, project);
  mkdirSync(root, { recursive: true });
  upsertTeam(fx.home, teamIdOf(root), {
    project,
    session: project,
    entity: 'other-org',
    root,
    roster: [],
    at: NOW.toISOString(),
  });
}

describe('independent verification of feat/router-policies', () => {
  test('probe 1: a team cannot retarget an entity alias or touch its fallback; with no entity word it may add its own', () => {
    // 1a. The release ships no alias, so a team word for an alias no entity placed is an add:
    const fxAdd = makeFixture();
    try {
      setWord(fxAdd, 'team', 'router.aliases', 'lead=lead@beacon');
      const read = readMailboxRouterPolicy(fxAdd.root, fxAdd.home, NOW);
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.policy.routes).toEqual([{ alias: 'lead', address: 'lead@beacon', fallback: null }]);
      }
    } finally {
      fxAdd.cleanup();
    }

    // 1b. Once the entity places the alias, a team retarget is refused:
    const fxRetarget = makeFixture();
    try {
      setWord(fxRetarget, 'entity', 'router.aliases', 'lead=lead@beacon');
      setWord(fxRetarget, 'team', 'router.aliases', 'lead=worker@beacon');
      expect(readMailboxRouterPolicy(fxRetarget.root, fxRetarget.home, NOW)).toEqual({
        ok: false,
        why: 'router alias "lead" is set by the entity; a team may add an alias, never retarget one',
      });
    } finally {
      fxRetarget.cleanup();
    }

    // 1c. Entity adds a new alias `alpha=lead@beacon`; team cannot retarget `alpha` or set/clear `alpha`'s fallback:
    const fx = makeFixture();
    try {
      setWord(fx, 'entity', 'router.aliases', 'alpha=lead@beacon');
      setWord(fx, 'team', 'router.aliases', 'alpha=worker@beacon');
      expect(readMailboxRouterPolicy(fx.root, fx.home, NOW)).toEqual({
        ok: false,
        why: 'router alias "alpha" is set by the entity; a team may add an alias, never retarget one',
      });

      const fxFallback = makeFixture();
      try {
        setWord(fxFallback, 'entity', 'router.aliases', 'alpha=lead@beacon');
        setWord(fxFallback, 'team', 'router.fallback', 'alpha=worker@beacon');
        expect(readMailboxRouterPolicy(fxFallback.root, fxFallback.home, NOW)).toEqual({
          ok: false,
          why: 'router fallback for "alpha" belongs to the entity; only the entity level may change or clear it',
        });
      } finally {
        fxFallback.cleanup();
      }
    } finally {
      fx.cleanup();
    }

    // 1d. Team cannot clear an entity alias's fallback (`lead=none`) or add a fallback to `worker`:
    for (const entry of ['lead=none', 'worker=lead@beacon']) {
      const sub = makeFixture();
      try {
        setWord(sub, 'entity', 'router.aliases', 'lead=lead@beacon,worker=worker@beacon');
        setWord(sub, 'team', 'router.fallback', entry);
        const alias = entry.split('=')[0]!;
        expect(readMailboxRouterPolicy(sub.root, sub.home, NOW)).toEqual({
          ok: false,
          why: `router fallback for "${alias}" belongs to the entity; only the entity level may change or clear it`,
        });
      } finally {
        sub.cleanup();
      }
    }
  });

  test('probe 2: desk targets, empty addresses, malformed addresses, duplicate aliases, and self-fallbacks are refused at write and load', () => {
    const fx = makeFixture();
    try {
      // 2a. Desk targets in both `router.aliases` and `router.fallback` are refused at write and load:
      const aliasDesk = planPolicySet(
        fx.home,
        { level: 'entity', target: 'floor', name: 'router.aliases', value: 'helper=desk@beacon' },
        { now: NOW },
      );
      expect(aliasDesk.ok).toBe(false);
      if (!aliasDesk.ok) {
        expect(aliasDesk.why).toBe('entity: router alias "helper" targets the desk seat, which no alias may name');
      }

      const fallbackDesk = planPolicySet(
        fx.home,
        { level: 'entity', target: 'floor', name: 'router.fallback', value: 'lead=desk@beacon' },
        { now: NOW },
      );
      expect(fallbackDesk.ok).toBe(false);
      if (!fallbackDesk.ok) {
        expect(fallbackDesk.why).toBe(
          'entity: router fallback for "lead" targets the desk seat, which no alias may name',
        );
      }

      const fallbackDeskLoad = resolvePolicy(
        'router.fallback',
        [
          {
            name: 'router.fallback',
            level: 'entity',
            value: 'lead=desk@acme',
            kind: 'advised',
            setter: 'owner',
            date: NOW.toISOString(),
            expiry: null,
            signature: 'sig',
            target: 'floor',
            generation: 1,
          },
        ],
        { now: NOW },
      );
      expect(fallbackDeskLoad.ok).toBe(false);

      // 2b. Empty addresses in both `router.aliases` and `router.fallback` are refused:
      for (const val of ['lead=', 'lead', 'helper=helper@acme,lead=']) {
        const res = planPolicySet(
          fx.home,
          { level: 'entity', target: 'floor', name: 'router.aliases', value: val },
          { now: NOW },
        );
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.why).toContain('router alias "lead" has no address');
      }
      for (const val of ['lead=', 'lead', 'lead=helper@acme,worker=']) {
        const res = planPolicySet(
          fx.home,
          { level: 'entity', target: 'floor', name: 'router.fallback', value: val },
          { now: NOW },
        );
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.why).toMatch(/router fallback for "(lead|worker)" has no address/);
      }

      // 2c. Self-fallbacks:
      // - Naming the alias itself (`lead=lead`) is refused at write and at load:
      const selfAlias = planPolicySet(
        fx.home,
        { level: 'entity', target: 'floor', name: 'router.fallback', value: 'lead=lead' },
        { now: NOW },
      );
      expect(selfAlias.ok).toBe(false);
      if (!selfAlias.ok) {
        expect(selfAlias.why).toBe('entity: router fallback for "lead" names the alias itself');
      }

      // - Naming the route's own address (entity alias `lead=lead@beacon` with fallback `lead=lead@beacon`,
      //   or team alias `mirror=lead@beacon` with fallback `mirror=lead@beacon`):
      const sub1 = makeFixture();
      try {
        setWord(sub1, 'entity', 'router.aliases', 'lead=lead@beacon');
        setWord(sub1, 'entity', 'router.fallback', 'lead=lead@beacon');
        expect(readMailboxRouterPolicy(sub1.root, sub1.home, NOW)).toEqual({
          ok: false,
          why: 'router fallback for "lead" names the route itself (lead@beacon)',
        });
      } finally {
        sub1.cleanup();
      }

      const sub2 = makeFixture();
      try {
        setWord(sub2, 'team', 'router.aliases', 'mirror=lead@beacon');
        setWord(sub2, 'team', 'router.fallback', 'mirror=lead@beacon');
        expect(readMailboxRouterPolicy(sub2.root, sub2.home, NOW)).toEqual({
          ok: false,
          why: 'router fallback for "mirror" names the route itself (lead@beacon)',
        });
        expect(mailboxRouterPolicyProblems(sub2.root, sub2.home, NOW)).toEqual([
          {
            why: 'router fallback for "mirror" names the route itself (lead@beacon)',
            level: 'team',
            name: 'router.fallback',
            kind: 'rule',
          },
        ]);
      } finally {
        sub2.cleanup();
      }

      // Final route belt checker:
      expect(
        mailboxRouterPolicyProblem([{ alias: 'lead', address: 'lead@acme', fallback: 'lead@acme' }]),
      ).toBe('router fallback for "lead" names the route itself (lead@acme)');
    } finally {
      fx.cleanup();
    }
  });

  test('probe 3: router.reply-bound bounds 1..86400 hold, nearest level wins, expired declarations revert to unset (null = twice unread window)', () => {
    expect(parseRouterReplyBound(1)).toBe(1);
    expect(parseRouterReplyBound('1')).toBe(1);
    expect(parseRouterReplyBound('1s')).toBe(1);
    expect(parseRouterReplyBound(86400)).toBe(86400);
    expect(parseRouterReplyBound('86400')).toBe(86400);
    expect(parseRouterReplyBound('86400s')).toBe(86400);

    for (const invalid of [
      0,
      '0',
      '0s',
      -1,
      '-5s',
      86401,
      '86401',
      '86401s',
      1.5,
      '1.5s',
      '',
      'unset',
      null,
      undefined,
    ]) {
      expect(parseRouterReplyBound(invalid)).toBeNull();
    }

    const fx = makeFixture();
    try {
      const initial = readMailboxRouterPolicy(fx.root, fx.home, NOW);
      expect(initial.ok).toBe(true);
      if (initial.ok) {
        expect(initial.policy.routes).toEqual([]);
        expect(initial.policy.replyBoundSeconds).toBeNull();
      }

      setWord(fx, 'entity', 'router.reply-bound', '1s');
      const atEntity1 = readMailboxRouterPolicy(fx.root, fx.home, NOW);
      expect(atEntity1.ok).toBe(true);
      if (atEntity1.ok) expect(atEntity1.policy.replyBoundSeconds).toBe(1);

      setWord(fx, 'team', 'router.reply-bound', '86400s', { expiry: '2026-11-04T12:05:00Z' });
      const atTeamMax = readMailboxRouterPolicy(fx.root, fx.home, NOW);
      expect(atTeamMax.ok).toBe(true);
      if (atTeamMax.ok) expect(atTeamMax.policy.replyBoundSeconds).toBe(86400);

      const afterTeamExpiry = readMailboxRouterPolicy(fx.root, fx.home, new Date('2026-11-04T12:06:00Z'));
      expect(afterTeamExpiry.ok).toBe(true);
      if (afterTeamExpiry.ok) expect(afterTeamExpiry.policy.replyBoundSeconds).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  test('probe 4: aliases and fallbacks cannot reach outside the entity or outside the team', () => {
    // 4a. Entity alias and entity fallback naming a registered foreign team (`entity: "other-org"`) or unknown team are refused:
    const fxEntityForeign = makeFixture();
    try {
      const foreignRoot = join(fxEntityForeign.base, 'foreign-repo');
      mkdirSync(foreignRoot, { recursive: true });
      const foreignId = teamIdOf(foreignRoot);
      upsertTeam(fxEntityForeign.home, foreignId, {
        project: 'foreign',
        entity: 'other-org',
        session: 'other-org-foreign',
        root: foreignRoot,
        roster: [{ seat: 'outsider', agent: 'agt_outsider0000', role: 'implementer' }],
        at: NOW.toISOString(),
      });
      upsertProject(fxEntityForeign.home, 'foreign', {
        name: 'foreign',
        entity: 'other-org',
        teams: [foreignId],
        at: NOW.toISOString(),
      });

      for (const foreignTarget of ['outsider@foreign', 'outsider@other-org-foreign', `outsider@${foreignId}`]) {
        const subAlias = makeFixture();
        try {
          upsertTeam(subAlias.home, foreignId, {
            project: 'foreign',
            entity: 'other-org',
            session: 'other-org-foreign',
            root: foreignRoot,
            roster: [{ seat: 'outsider', agent: 'agt_outsider0000', role: 'implementer' }],
            at: NOW.toISOString(),
          });
          setWord(subAlias, 'entity', 'router.aliases', `bridge=${foreignTarget}`);
          expect(readMailboxRouterPolicy(subAlias.root, subAlias.home, NOW)).toEqual({
            ok: false,
            why: `router alias "bridge" names "${foreignTarget}", which is not a team of this entity`,
          });
        } finally {
          subAlias.cleanup();
        }

        const subFallback = makeFixture();
        try {
          upsertTeam(subFallback.home, foreignId, {
            project: 'foreign',
            entity: 'other-org',
            session: 'other-org-foreign',
            root: foreignRoot,
            roster: [{ seat: 'outsider', agent: 'agt_outsider0000', role: 'implementer' }],
            at: NOW.toISOString(),
          });
          setWord(subFallback, 'entity', 'router.fallback', `lead=${foreignTarget}`);
          expect(readMailboxRouterPolicy(subFallback.root, subFallback.home, NOW)).toEqual({
            ok: false,
            why: `router fallback for "lead" names "${foreignTarget}", which is not a team of this entity`,
          });
        } finally {
          subFallback.cleanup();
        }
      }

      // Entity alias targeting a team of its own entity by id, project name, or session name is accepted:
      setWord(
        fxEntityForeign,
        'entity',
        'router.aliases',
        `by-proj=lead@beacon,by-sess=worker@floor-core,by-id=worker@${fxEntityForeign.floorTeamId}`,
      );
      const validEntity = readMailboxRouterPolicy(fxEntityForeign.root, fxEntityForeign.home, NOW);
      expect(validEntity.ok).toBe(true);
    } finally {
      fxEntityForeign.cleanup();
    }

    // 4b. A team alias and a team-added fallback outside its own team (even inside the same entity!) are refused:
    for (const outsideTarget of ['outsider@other-team', 'outsider@foreign-entity', 'ghost@beacon']) {
      const subAlias = makeFixture();
      try {
        for (const word of ['other-team', 'foreign-entity']) addOtherTeam(subAlias, word);
        setWord(subAlias, 'team', 'router.aliases', `helper=${outsideTarget}`);
        expect(readMailboxRouterPolicy(subAlias.root, subAlias.home, NOW)).toEqual({
          ok: false,
          why: `router alias "helper" names "${outsideTarget}", which is not a seat of this team`,
        });
      } finally {
        subAlias.cleanup();
      }

      const subFallback = makeFixture();
      try {
        for (const word of ['other-team', 'foreign-entity']) addOtherTeam(subFallback, word);
        setWord(subFallback, 'team', 'router.aliases', 'mirror=lead@beacon');
        setWord(subFallback, 'team', 'router.fallback', `mirror=${outsideTarget}`);
        expect(readMailboxRouterPolicy(subFallback.root, subFallback.home, NOW)).toEqual({
          ok: false,
          why: `router fallback for "mirror" names "${outsideTarget}", which is not a seat of this team`,
        });
      } finally {
        subFallback.cleanup();
      }
    }

    // 4c. Team check surfaces broken router words with per-level unset repairs:
    const fxCheck = makeFixture();
    try {
      addOtherTeam(fxCheck, 'foreign-entity');
      setWord(fxCheck, 'entity', 'router.aliases', 'lead=lead@beacon');
      setWord(fxCheck, 'team', 'router.aliases', 'helper=outsider@foreign-entity');
      setWord(fxCheck, 'team', 'router.fallback', 'lead=worker@beacon');
      const io = testIo(fxCheck.root, { kind: 'owner' });
      const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
        live: () => QUIET_LIVE,
        branch: () => 'main',
        standing: (at) => approvalStanding(at, fxCheck.home),
        now: () => NOW,
        home: fxCheck.home,
      });
      expect(code).toBe(1);
      expect(io.out).toContain(
        'difference: router alias "helper" names "outsider@foreign-entity", which is not a seat of this team',
      );
      expect(io.out).toContain('  repair: team policy unset team router.aliases');
      expect(io.out).toContain(
        'difference: router fallback for "lead" belongs to the entity; only the entity level may change or clear it',
      );
      expect(io.out).toContain('  repair: team policy unset team router.fallback');
    } finally {
      fxCheck.cleanup();
    }
  });

  test('probe 5: all three team address forms (project name, session name, registry team id) are accepted for a team own seats in aliases and fallback', () => {
    const fx = makeFixture('floor-beacon');
    try {
      expect(fx.teamId).not.toBe('beacon');
      expect(fx.teamId).not.toBe('floor-beacon');

      setWord(
        fx,
        'team',
        'router.aliases',
        `a-proj=lead@beacon,a-sess=lead@floor-beacon,a-id=lead@${fx.teamId}`,
      );
      setWord(
        fx,
        'team',
        'router.fallback',
        `a-proj=worker@${fx.teamId},a-sess=worker@beacon,a-id=worker@floor-beacon`,
      );

      const read = readMailboxRouterPolicy(fx.root, fx.home, NOW);
      expect(read.ok).toBe(true);
      if (!read.ok) return;

      expect(read.policy.routes.find((r) => r.alias === 'a-proj')).toEqual({
        alias: 'a-proj',
        address: 'lead@beacon',
        fallback: `worker@${fx.teamId}`,
      });
      expect(read.policy.routes.find((r) => r.alias === 'a-sess')).toEqual({
        alias: 'a-sess',
        address: 'lead@floor-beacon',
        fallback: 'worker@beacon',
      });
      expect(read.policy.routes.find((r) => r.alias === 'a-id')).toEqual({
        alias: 'a-id',
        address: `lead@${fx.teamId}`,
        fallback: 'worker@floor-beacon',
      });
    } finally {
      fx.cleanup();
    }
  });

  test('probe 6: an unreadable team file, unreadable registry, or tampered policy source refuses the read (never returning a guessed map)', () => {
    // 6a. Unreadable / invalid team.yaml refuses:
    const fxTeam = makeFixture();
    try {
      writeFileSync(join(fxTeam.root, '.agents', 'team.yaml'), 'format: 1\nseats: [broken\n');
      const read = readMailboxRouterPolicy(fxTeam.root, fxTeam.home, NOW);
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.why).toContain('the team file cannot be read');
      }
    } finally {
      fxTeam.cleanup();
    }

    // 6b. Missing team.yaml refuses:
    const fxMissing = makeFixture();
    try {
      rmSync(join(fxMissing.root, '.agents', 'team.yaml'));
      const read = readMailboxRouterPolicy(fxMissing.root, fxMissing.home, NOW);
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.why).toContain('the team file cannot be read');
      }
    } finally {
      fxMissing.cleanup();
    }

    // 6c. Unreadable registry (`teams.yaml` or `projects.yaml` corrupted) when an entity router word is evaluated refuses:
    const fxRegTeams = makeFixture();
    try {
      setWord(fxRegTeams, 'entity', 'router.aliases', 'lead=lead@beacon');
      writeFileSync(join(fxRegTeams.home, '.config', 'team', 'teams.yaml'), 'format: 1\nteams:\n  - [broken\n');
      const read = readMailboxRouterPolicy(fxRegTeams.root, fxRegTeams.home, NOW);
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.why).toContain('entity: the registry cannot be read');
      }
    } finally {
      fxRegTeams.cleanup();
    }

    const fxRegProjects = makeFixture();
    try {
      setWord(fxRegProjects, 'entity', 'router.fallback', 'lead=lead@beacon');
      writeFileSync(join(fxRegProjects.home, '.config', 'team', 'projects.yaml'), 'format: 1\nprojects:\n  - [broken\n');
      const read = readMailboxRouterPolicy(fxRegProjects.root, fxRegProjects.home, NOW);
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.why).toContain('entity: the registry cannot be read');
      }
    } finally {
      fxRegProjects.cleanup();
    }
  });
});

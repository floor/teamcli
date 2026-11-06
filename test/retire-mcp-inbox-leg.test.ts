// Independent verification of the retired `mcp-inbox` alias across the signed policy chain,
// signed settings store, project registry, team file validation, and send delivery walk.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { runSend } from '../src/commands/send.ts';
import { type SeatOverrides } from '../src/config/apply.ts';
import { composeSeatConfig } from '../src/config/compose.ts';
import { signConfigRecord } from '../src/config/record.ts';
import {
  loadAndResolveConfigChain,
  planConfigSet,
  readConfigSources,
  writeConfigSet,
} from '../src/config/sources.ts';
import { entitiesPath } from '../src/entities.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { grantsDir } from '../src/grant.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import {
  loadAndResolvePolicyChain,
  planPolicySet,
  policySignaturePayload,
  readPolicyChain,
  resolvePolicy,
  resolvePolicyChain,
  writePolicySet,
  type Policy,
  type PolicyLevel,
  type PolicyValue,
} from '../src/policy/index.ts';
import { POLICY_DOMAIN } from '../src/policy/types.ts';
import { agentsDir, registerAgent, updateAgent } from '../src/registry/agents.ts';
import { get as getProject, projectsFile, ProjectsError, readProjects, upsertProject } from '../src/registry/projects.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { deliveryChainOf } from '../src/send/delivery.ts';
import { readHistory } from '../src/send/history.ts';
import {
  DELIVERY_LEGS,
  DELIVERY_ORDER,
  LEGACY_ORDER_WORDS,
  liveOrderRecord,
  orderDeclarationsOf,
} from '../src/settings/inherit.ts';
import { deliveryOrder, resolveOrderSetting } from '../src/settings/resolve.ts';
import type { Live } from '../src/status/compare.ts';
import { bumpGeneration, keyOf, keyState, signDomain } from '../src/store/keys.ts';
import { approvalStanding } from '../src/store/store.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';
import { fake, owner, world, type World } from './send-native-fixtures.ts';

const AT = new Date('2026-11-04T02:00:00.000Z');
const ISO = AT.toISOString();
const dirs: string[] = [];
const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const BASE_TEAM_YAML = `format: 1
entity: corp
project: acme
session: acme-dev
coordinator: crew-lead
operator: crew-lead
workspace:
  mode: shared
seats:
  - name: crew-lead
    role: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    inbound: accept
  - name: codex-worker
    role: builder
    cli: codex
    vendor: openai
    model: GPT-6.4
    version: "6.4"
    launch: codex
  - name: jules-worker
    role: builder
    cli: jules
    vendor: google
    model: Jules
    version: "0.1"
    launch: jules
  - name: human-seat
    role: reviewer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    human: true
`;

function makeSandbox(teamYaml: string = BASE_TEAM_YAML): {
  base: string;
  home: string;
  root: string;
  teamId: string;
  agentId: string;
  team: TeamFile;
} {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-retire-mcp-inbox-')));
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'repo');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamYaml);

  const validated = validateTeamFile(teamYaml);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));

  const teamId = teamIdOf(root);
  const agent = registerAgent(home, {
    name: 'Alex',
    signing: { model: 'Claude Opus', version: '5.5', role: 'coordinator' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: teamId, session: 'acme-dev', pane: 'pane-lead', seat: 'crew-lead', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });

  upsertTeam(home, teamId, {
    project: 'acme',
    entity: 'corp',
    session: 'acme-dev',
    root,
    roster: [{ agent: agent.id, seat: 'crew-lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
    by: 'team up',
    at: ISO,
  });

  upsertProject(home, 'acme', {
    name: 'acme',
    entity: 'corp',
    lead: agent.id,
    teams: [teamId],
    by: 'team up',
    at: ISO,
  });

  writeFileSync(entitiesPath(home), 'corp:\n  roots:\n    - ~/work\n');
  return { base, home, root, teamId, agentId: agent.id, team: validated.team };
}

/** Signs a policy entry directly with the owner key, as an older build that still permitted
 *  `mcp-inbox` in `delivery-order` would have signed and stored it on disk. */
function signOldBuildPolicyDiskEntry(
  home: string,
  level: PolicyLevel,
  target: string,
  name: string,
  value: PolicyValue,
  expiry: string | null = null,
): { policy: Policy; disk: Record<string, unknown> } {
  const folder = grantsDir(home);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const generation = bumpGeneration(folder, home, AT);
  const key = keyOf(home);
  const payload = policySignaturePayload({
    name,
    value,
    level,
    target,
    setter: 'owner',
    date: ISO,
    expiry,
    kind: 'enforced',
    generation,
  });
  const signature = signDomain(POLICY_DOMAIN, payload, key);
  return {
    policy: {
      name,
      value,
      level,
      target,
      setter: 'owner',
      date: ISO,
      expiry,
      kind: 'enforced',
      generation,
      signature,
    },
    disk: {
      value,
      setter: 'owner',
      date: ISO,
      expiry,
      kind: 'enforced',
      target,
      generation,
      signature,
    },
  };
}

/** Writes an older-build signed `delivery-order` policy into the target level's storage file. */
function writeOldBuildPolicyToDisk(
  sandbox: { home: string; root: string; agentId: string },
  level: PolicyLevel,
  value: readonly string[],
): void {
  const target =
    level === 'entity'
      ? 'corp'
      : level === 'project'
        ? 'acme'
        : level === 'team'
          ? sandbox.root
          : sandbox.agentId;
  // Write a live policy first so the file structure is formatted by the production writer,
  // then re-value and re-sign it over `value` as the older build's writer did.
  const seeded = writePolicySet(
    sandbox.home,
    {
      level,
      target,
      ...(level === 'team' ? { teamRoot: sandbox.root } : {}),
      name: 'delivery-order',
      value: ['typed'],
    },
    { now: AT },
  );
  if (!seeded.ok) throw new Error(seeded.why);

  const file =
    level === 'entity'
      ? entitiesPath(sandbox.home)
      : level === 'project'
        ? projectsFile(sandbox.home)
        : level === 'team'
          ? join(sandbox.root, '.agents', 'team.yaml')
          : join(agentsDir(sandbox.home), `${sandbox.agentId}.yaml`);

  const text = readFileSync(file, 'utf8');
  const signature = signDomain(
    POLICY_DOMAIN,
    policySignaturePayload({
      name: 'delivery-order',
      value: [...value],
      level,
      target: seeded.policy.target!,
      setter: 'owner',
      date: seeded.policy.date!,
      expiry: null,
      kind: 'enforced',
      generation: seeded.policy.generation!,
    }),
    keyOf(sandbox.home),
  );
  const quoted = `[${value.map((w) => `"${w}"`).join(', ')}]`;
  const replaced = text
    .replace('value: ["typed"]', `value: ${quoted}`)
    .replace(`signature: "${seeded.policy.signature}"`, `signature: "${signature}"`);
  if (replaced === text) throw new Error(`failed to re-sign ${file}`);
  writeFileSync(file, replaced);
}

describe('fix/retire-mcp-inbox-leg independent verification', () => {
  test('1. an alias-only signed level declares nothing in the policy chain and in deliveryChainOf, while still shadowing legacy unsigned words at its level', () => {
    expect(DELIVERY_LEGS).not.toContain('mcp-inbox');
    expect(LEGACY_ORDER_WORDS).toEqual(['mcp-inbox']);

    // Check every level individually when it holds a signed `delivery-order: ['mcp-inbox']` on disk.
    for (const level of ['entity', 'project', 'team', 'seat'] as const) {
      const sb = makeSandbox();
      writeOldBuildPolicyToDisk(sb, level, ['mcp-inbox']);

      const sources = readPolicyChain({
        home: sb.home,
        entity: 'corp',
        projectId: 'acme',
        teamRoot: sb.root,
        agentId: sb.agentId,
        seat: sb.team.seats[0]!,
      });
      expect(sources[level]?.ok).toBe(true);

      const chain = resolvePolicyChain(sources, { now: AT });
      expect(chain.ok).toBe(true);
      if (!chain.ok) throw new Error('expected policy chain to resolve');
      const resolved = chain.policies['delivery-order'];
      expect(resolved).toBeDefined();
      // An alias-only signed record declares nothing: the default stands with 0 refusals.
      expect(resolved?.level).toBe('default');
      expect(resolved?.value).toEqual(['typed', 'drop']);
    }

    // When a wider level (`entity`) holds a live tightening `['drop']` and `project`, `team`, and
    // `seat` all hold signed alias-only `['mcp-inbox']` records, none of the narrower levels
    // replaces `['drop']` with `[]` or triggers a refusal.
    const sb = makeSandbox();
    const entityWrite = writePolicySet(
      sb.home,
      { level: 'entity', target: 'corp', name: 'delivery-order', value: ['drop'] },
      { now: AT },
    );
    expect(entityWrite.ok).toBe(true);
    writeOldBuildPolicyToDisk(sb, 'project', ['mcp-inbox']);
    writeOldBuildPolicyToDisk(sb, 'team', ['mcp-inbox']);
    writeOldBuildPolicyToDisk(sb, 'seat', ['mcp-inbox']);

    const chain = loadAndResolvePolicyChain(
      {
        home: sb.home,
        entity: 'corp',
        projectId: 'acme',
        teamRoot: sb.root,
        agentId: sb.agentId,
        seat: sb.team.seats[0]!,
      },
      { now: AT },
    );
    expect(chain.ok).toBe(true);
    if (!chain.ok) throw new Error('expected policy chain to resolve');
    expect(chain.policies['delivery-order']?.level).toBe('entity');
    expect(chain.policies['delivery-order']?.value).toEqual(['drop']);

    // In `deliveryChainOf`, an alias-only signed policy at `project` or `team` leaves that level
    // `undefined` (never `[]`), AND shadows any legacy unsigned `delivery_order` at that same level.
    const sbShadow = makeSandbox(`format: 1
entity: corp
project: acme
session: acme-dev
coordinator: crew-lead
operator: crew-lead
delivery_order: [drop]
workspace:
  mode: shared
seats:
  - name: crew-lead
    role: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`);
    // Put a legacy unsigned `delivery_order: [drop]` in `projects.yaml` AND a signed `['mcp-inbox']` policy on both project and team.
    writeOldBuildPolicyToDisk(sbShadow, 'project', ['mcp-inbox']);
    const projPath = projectsFile(sbShadow.home);
    writeFileSync(
      projPath,
      readFileSync(projPath, 'utf8').replace('    teams:', '    delivery_order: [drop]\n    teams:'),
    );
    writeOldBuildPolicyToDisk(sbShadow, 'team', ['mcp-inbox']);

    const reloaded = readTeamConfig(sbShadow.root, { home: sbShadow.home });
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) throw new Error('expected team config to load');

    const dChain = deliveryChainOf({
      root: sbShadow.root,
      seat: 'crew-lead',
      home: sbShadow.home,
      file: reloaded.team,
      projectOfTeam: () => getProject(sbShadow.home, 'acme'),
      now: AT,
    });
    // Both project and team signed records are alias-only: they shadow the unsigned `[drop]`
    // declarations, and the walk reads those levels as the mailbox, never as an absent word
    // the typed fallback would fill.
    expect(dChain.entity).toBeUndefined();
    expect(dChain.project).toEqual(['drop']);
    expect(dChain.team).toEqual(['drop']);
    expect(deliveryOrder(dChain)).toEqual(['drop']);
    expect(deliveryOrder(dChain)).not.toContain('typed');
  });

  test('2. the retired alias cannot widen any order or bypass duplicate validation', () => {
    const sb = makeSandbox();
    // Entity locks `delivery-order` to `['drop']`.
    const entityDrop = signOldBuildPolicyDiskEntry(sb.home, 'entity', 'corp', 'delivery-order', ['drop']).policy;

    // Case A: project holds `['mcp-inbox', 'drop']` -> strips to `['drop']`, within `['drop']`, no widening.
    const projInboxDrop = signOldBuildPolicyDiskEntry(
      sb.home,
      'project',
      'acme',
      'delivery-order',
      ['mcp-inbox', 'drop'],
    ).policy;
    const resA = resolvePolicy('delivery-order', [entityDrop, projInboxDrop], { now: AT });
    expect(resA.ok).toBe(true);
    if (!resA.ok) throw new Error('expected resA to resolve');
    expect(resA.effective.level).toBe('project');
    expect(resA.effective.value).toEqual(['drop']);

    // Case B: team tries to smuggle `typed` alongside `mcp-inbox` (`['mcp-inbox', 'typed', 'drop']`) under `['drop']` -> refused as loosening!
    const teamSmuggle = signOldBuildPolicyDiskEntry(
      sb.home,
      'team',
      sb.root,
      'delivery-order',
      ['mcp-inbox', 'typed', 'drop'],
    ).policy;
    const resB = resolvePolicy('delivery-order', [entityDrop, teamSmuggle], { now: AT });
    expect(resB.ok).toBe(false);
    if (resB.ok) throw new Error('expected resB to be refused');
    expect(resB.refusals).toHaveLength(1);
    expect(resB.refusals[0]?.kind).toBe('loosening');
    if (resB.refusals[0]?.kind === 'loosening') {
      expect(resB.refusals[0].lowerLevel).toBe('team');
      expect(resB.refusals[0].higherLevel).toBe('entity');
      expect(resB.refusals[0].higherValue).toEqual(['drop']);
    }

    // Case C: a signed policy with duplicate `['mcp-inbox', 'mcp-inbox']` or `['mcp-inbox', 'drop', 'mcp-inbox']`
    // is refused as `invalid-policy` because duplicates are checked before dropping the retired alias.
    const dupAliasOnly = signOldBuildPolicyDiskEntry(
      sb.home,
      'team',
      sb.root,
      'delivery-order',
      ['mcp-inbox', 'mcp-inbox'],
    ).policy;
    const resC1 = resolvePolicy('delivery-order', [dupAliasOnly], { now: AT });
    expect(resC1.ok).toBe(false);
    if (resC1.ok) throw new Error('expected resC1 to be refused');
    expect(resC1.refusals).toHaveLength(1);
    expect(resC1.refusals[0]?.kind).toBe('invalid-policy');

    const dupAliasMixed = signOldBuildPolicyDiskEntry(
      sb.home,
      'team',
      sb.root,
      'delivery-order',
      ['mcp-inbox', 'drop', 'mcp-inbox'],
    ).policy;
    const resC2 = resolvePolicy('delivery-order', [dupAliasMixed], { now: AT });
    expect(resC2.ok).toBe(false);
    if (resC2.ok) throw new Error('expected resC2 to be refused');
    expect(resC2.refusals).toHaveLength(1);
    expect(resC2.refusals[0]?.kind).toBe('invalid-policy');

    // Case D: in `resolveOrderSetting` / `deliveryOrder`, when project holds `['drop']`:
    // - a team word of `['mcp-inbox']` declares nothing (0 refusals, value stays `['drop']`)
    // - a team word of `['mcp-inbox', 'typed', 'drop']` is stripped to `['typed', 'drop']` and refused as widening `['drop']`.
    const resAliasOnly = resolveOrderSetting(
      DELIVERY_ORDER,
      orderDeclarationsOf(liveOrderRecord({ project: ['drop'], team: ['mcp-inbox'] })),
    );
    expect(resAliasOnly.value).toEqual(['drop']);
    expect(resAliasOnly.refused).toEqual([]);

    const resAttemptedWiden = resolveOrderSetting(
      DELIVERY_ORDER,
      orderDeclarationsOf(liveOrderRecord({ project: ['drop'], team: ['mcp-inbox', 'typed', 'drop'] })),
    );
    expect(resAttemptedWiden.value).toEqual(['drop']);
    expect(resAttemptedWiden.refused).toEqual([{ level: 'team', value: ['typed', 'drop'] }]);
  });

  test('3. new writes naming mcp-inbox (alone or mixed) are refused across policy set, config set, and registry upsert without bumping key generation', () => {
    const sb = makeSandbox();
    // Seed the owner key so we can verify its generation never advances on refused writes.
    const initialPolicy = writePolicySet(
      sb.home,
      { level: 'entity', target: 'corp', name: 'delivery-order', value: ['typed', 'drop'] },
      { now: AT },
    );
    expect(initialPolicy.ok).toBe(true);
    if (!initialPolicy.ok) throw new Error(initialPolicy.why);
    const startGen = initialPolicy.policy.generation!;

    const retiredInputs: unknown[] = [
      ['mcp-inbox'],
      'mcp-inbox',
      ['mcp-inbox', 'typed'],
      ['typed', 'mcp-inbox'],
      ['socket', 'mcp-inbox', 'drop'],
      'mcp-inbox,typed',
      'typed, mcp-inbox, drop',
    ];

    // 3a. Policy writes (`planPolicySet` and `writePolicySet`) at all 4 levels (`entity`, `project`, `team`, `seat`).
    for (const level of ['entity', 'project', 'team', 'seat'] as const) {
      const target =
        level === 'entity'
          ? 'corp'
          : level === 'project'
            ? 'acme'
            : level === 'team'
              ? sb.root
              : sb.agentId;
      for (const value of retiredInputs) {
        const req = {
          level,
          target,
          ...(level === 'team' ? { teamRoot: sb.root } : {}),
          name: 'delivery-order',
          value,
        };
        const planned = planPolicySet(sb.home, req, { now: AT });
        expect(planned).toEqual({
          ok: false,
          why: 'policy "delivery-order" names mcp-inbox, which is no longer a leg; remove it',
        });
        const written = writePolicySet(sb.home, req, { now: AT });
        expect(written).toEqual({
          ok: false,
          why: 'policy "delivery-order" names mcp-inbox, which is no longer a leg; remove it',
        });
      }
    }

    // 3b. Signed settings writes (`planConfigSet` and `writeConfigSet`) for `delivery_order`.
    for (const value of retiredInputs) {
      const plan = planConfigSet(sb.home, {
        level: 'seat',
        target: sb.agentId,
        settings: [{ key: 'delivery_order', value }],
      });
      expect(plan).toEqual({
        ok: false,
        kind: 'value',
        why: 'setting "delivery_order" names mcp-inbox, which is no longer a leg; remove it',
      });
      const written = writeConfigSet(sb.home, plan, { now: AT });
      expect(written).toEqual({
        ok: false,
        kind: 'value',
        why: 'setting "delivery_order" names mcp-inbox, which is no longer a leg; remove it',
      });
    }

    // 3c. Project registry upserts (`upsertProject`) naming `mcp-inbox` alone or mixed.
    for (const order of [['mcp-inbox'], ['mcp-inbox', 'drop'], ['typed', 'mcp-inbox']] as const) {
      expect(() =>
        upsertProject(sb.home, 'acme', {
          deliveryOrder: [...order],
          by: 'owner',
          at: ISO,
        }),
      ).toThrow(new ProjectsError('delivery_order names mcp-inbox, which is no longer a leg; remove it'));

      expect(() =>
        upsertProject(sb.home, 'new-proj', {
          name: 'new-proj',
          deliveryOrder: [...order],
          by: 'owner',
          at: ISO,
        }),
      ).toThrow(new ProjectsError('delivery_order names mcp-inbox, which is no longer a leg; remove it'));
    }

    // Owner key generation was never bumped by any refused write: the next valid write lands at startGen + 1.
    const nextValidWrite = writePolicySet(
      sb.home,
      { level: 'entity', target: 'corp', name: 'delivery-order', value: ['drop'] },
      { now: AT },
    );
    expect(nextValidWrite.ok).toBe(true);
    if (!nextValidWrite.ok) throw new Error(nextValidWrite.why);
    expect(nextValidWrite.policy.generation).toBe(startGen + 1);
  });

  test('4. old files and rows carrying mcp-inbox (alone or mixed) still read cleanly across team.yaml, projects.yaml, signed policies, and signed settings', () => {
    const legacyTeamYaml = `format: 1
entity: corp
project: acme
session: acme-dev
coordinator: crew-lead
operator: crew-lead
delivery_order: [mcp-inbox]
workspace:
  mode: shared
seats:
  - name: crew-lead
    role: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    delivery_order: [mcp-inbox, drop]
  - name: codex-worker
    role: builder
    cli: codex
    vendor: openai
    model: GPT-6.4
    version: "6.4"
    launch: codex
    delivery_order: [mcp-inbox]
`;
    const sb = makeSandbox(legacyTeamYaml);

    // 4a. `validateTeamFile` and `readTeamConfig` accept both `[mcp-inbox]` and `[mcp-inbox, drop]`.
    const loaded = readTeamConfig(sb.root, { home: sb.home });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('expected legacy team config to read');
    expect(loaded.team.deliveryOrder).toEqual(['mcp-inbox']);
    expect(loaded.team.seats[0]?.deliveryOrder).toEqual(['mcp-inbox', 'drop']);
    expect(loaded.team.seats[1]?.deliveryOrder).toEqual(['mcp-inbox']);

    // Duplicate `mcp-inbox` in `team.yaml` is still rejected at validation.
    const dupValidated = validateTeamFile(
      legacyTeamYaml.replace('delivery_order: [mcp-inbox]', 'delivery_order: [mcp-inbox, mcp-inbox]'),
    );
    expect(dupValidated.ok).toBe(false);

    // `runTeamCheck` emits the retirement note for the team and for each seat naming `mcp-inbox`,
    // and never reports `[mcp-inbox]` as a set-aside difference.
    const checkIo = testIo(sb.root, { kind: 'owner' });
    const liveState: Live = {
      running: true,
      agents: loaded.team.seats.map((seat, idx) => ({
        name: seat.name,
        agent: seat.cli,
        pane: `pane-${String(idx + 1)}`,
        workspace: `ws-${String(idx + 1)}`,
        status: 'idle',
        cwd: null,
        displayAgent: displayAgent(seat),
      })),
      workspaces: loaded.team.seats.map((seat, idx) => ({
        id: `ws-${String(idx + 1)}`,
        label: workspaceLabel(seat),
      })),
      screens: Object.fromEntries(loaded.team.seats.map((_, idx) => [`pane-${String(idx + 1)}`, CLAUDE_IDLE])),
    };
    runTeamCheck({ file: '.agents/team.yaml', json: true }, checkIo, {
      home: sb.home,
      live: () => liveState,
      branch: () => 'main',
      standing: (at) => approvalStanding(at, join(sb.root, 'nowhere')),
      now: () => AT,
    });
    const checkReport = JSON.parse(checkIo.out) as {
      notes: string[];
      differences: { what: string }[];
    };
    expect(checkReport.notes).toContain(
      'delivery_order [mcp-inbox] in team config names mcp-inbox, which is no longer a leg; remove it',
    );
    expect(checkReport.notes).toContain(
      'crew-lead: delivery_order [mcp-inbox, drop] in team config names mcp-inbox, which is no longer a leg; remove it',
    );
    expect(checkReport.notes).toContain(
      'codex-worker: delivery_order [mcp-inbox] in team config names mcp-inbox, which is no longer a leg; remove it',
    );
    expect(checkReport.differences.filter((d) => d.what.includes('delivery_order'))).toEqual([]);

    // 4b. `projects.yaml` rows written by an older build with `delivery_order: [mcp-inbox]` and
    // `delivery_order: [mcp-inbox, drop]` read cleanly via `readProjects` and `getProject`.
    const pFile = projectsFile(sb.home);
    writeFileSync(
      pFile,
      `projects:
  acme:
    name: acme
    entity: corp
    lead: ${sb.agentId}
    teams: [${sb.teamId}]
    delivery_order: [mcp-inbox]
    provenance: { registered_by: owner, registered_at: "${ISO}", updated_at: "${ISO}" }
  acme-mixed:
    name: acme-mixed
    entity: corp
    lead: null
    teams: []
    delivery_order: [mcp-inbox, drop]
    provenance: { registered_by: owner, registered_at: "${ISO}", updated_at: "${ISO}" }
`,
    );
    const projects = readProjects(sb.home);
    expect(projects.acme?.deliveryOrder).toEqual(['mcp-inbox']);
    expect(projects['acme-mixed']?.deliveryOrder).toEqual(['mcp-inbox', 'drop']);

    // 4c. Signed settings records on disk carrying `['mcp-inbox']` or `['mcp-inbox', 'drop']`
    // verify and read cleanly in `readConfigSources`, `loadAndResolveConfigChain`, and `composeSeatConfig`.
    const folder = grantsDir(sb.home);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const gen = bumpGeneration(folder, sb.home, AT);
    const key = keyOf(sb.home);
    const signedSeatOrder = signConfigRecord(
      {
        key: 'delivery_order',
        value: ['mcp-inbox'],
        level: 'seat',
        target: sb.agentId,
        setter: 'owner',
        date: ISO,
        generation: gen,
      },
      key,
    );
    updateAgent(sb.home, sb.agentId, {
      settingsDelta: {
        delivery_order: {
          value: ['mcp-inbox'],
          setter: signedSeatOrder.setter,
          date: signedSeatOrder.date,
          target: signedSeatOrder.target,
          generation: signedSeatOrder.generation,
          signature: signedSeatOrder.signature,
        },
      },
    });

    const cfgSources = readConfigSources({
      home: sb.home,
      entity: 'corp',
      projectId: 'acme',
      teamId: sb.teamId,
      agentId: sb.agentId,
    });
    expect(cfgSources.seat?.ok).toBe(true);
    const cfgResolved = loadAndResolveConfigChain({
      home: sb.home,
      entity: 'corp',
      projectId: 'acme',
      teamId: sb.teamId,
      agentId: sb.agentId,
    });
    expect(cfgResolved.ok).toBe(true);
    if (cfgResolved.ok) {
      expect(cfgResolved.settings.find((s) => s.key === 'delivery_order')?.value).toEqual(['mcp-inbox']);
    }
    const fileRows = composeSeatConfig(loaded.team.seats[0]!, loaded.team.deliveryOrder);
    expect(fileRows.find((r) => r.key === 'delivery_order')?.value).toEqual(['mcp-inbox', 'drop']);
    const recordRows = composeSeatConfig(loaded.team.seats[0]!, loaded.team.deliveryOrder, {
      delivery_order: { value: ['mcp-inbox'], level: 'seat' },
    });
    expect(recordRows.find((r) => r.key === 'delivery_order')?.value).toEqual(['mcp-inbox']);
  });

  test('5. a seat with [mcp-inbox] walks drop, not the no-order typed path, across socket, native, watcherless, and human seats', async () => {
    const sbNoOrder = makeSandbox(BASE_TEAM_YAML);
    const sbAliasOrder = makeSandbox(`format: 1
entity: corp
project: acme
session: acme-dev
coordinator: crew-lead
operator: crew-lead
delivery_order: [mcp-inbox]
workspace:
  mode: shared
seats:
  - name: crew-lead
    role: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    inbound: accept
    delivery_order: [mcp-inbox]
  - name: codex-worker
    role: builder
    cli: codex
    vendor: openai
    model: GPT-6.4
    version: "6.4"
    launch: codex
    delivery_order: [mcp-inbox]
  - name: jules-worker
    role: builder
    cli: jules
    vendor: google
    model: Jules
    version: "0.1"
    launch: jules
    delivery_order: [mcp-inbox]
  - name: human-seat
    role: reviewer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    human: true
    delivery_order: [mcp-inbox]
`);

    // Also test when `[mcp-inbox]` comes from signed seat settings (`overrides.deliveryOrder: ['mcp-inbox']`).
    const overridesWithAlias: SeatOverrides = {
      deliveryOrder: ['mcp-inbox'] as unknown as SeatOverrides['deliveryOrder'],
    };

    for (const seatName of ['crew-lead', 'codex-worker', 'jules-worker', 'human-seat'] as const) {
      const chainNoOrder = deliveryChainOf({
        root: sbNoOrder.root,
        seat: seatName,
        home: sbNoOrder.home,
        file: sbNoOrder.team,
        projectOfTeam: () => getProject(sbNoOrder.home, 'acme'),
        now: AT,
      });
      const chainAliasOrder = deliveryChainOf({
        root: sbAliasOrder.root,
        seat: seatName,
        home: sbAliasOrder.home,
        file: sbAliasOrder.team,
        projectOfTeam: () => getProject(sbAliasOrder.home, 'acme'),
        ...(seatName === 'crew-lead' ? { overrides: overridesWithAlias } : {}),
        now: AT,
      });
      expect(deliveryOrder(chainAliasOrder)).toEqual(['drop']);
      expect(deliveryOrder(chainAliasOrder)).not.toContain('typed');
      expect(chainAliasOrder).not.toEqual(chainNoOrder);
    }

    // Verify specific seat shapes:
    // - `jules-worker` is watcherless, and the shape would have answered `typed`. The retired
    //   word is the mailbox instead, on the team and on the seat.
    const julesChain = deliveryChainOf({
      root: sbAliasOrder.root,
      seat: 'jules-worker',
      home: sbAliasOrder.home,
      file: sbAliasOrder.team,
      projectOfTeam: () => getProject(sbAliasOrder.home, 'acme'),
      now: AT,
    });
    expect(julesChain).toEqual({ team: ['drop'], seat: ['drop'] });
    expect(deliveryOrder(julesChain)).toEqual(['drop']);

    // - `human-seat`: `['drop']` alone
    const humanChain = deliveryChainOf({
      root: sbAliasOrder.root,
      seat: 'human-seat',
      home: sbAliasOrder.home,
      file: sbAliasOrder.team,
      projectOfTeam: () => getProject(sbAliasOrder.home, 'acme'),
      now: AT,
    });
    expect(humanChain).toEqual({ team: ['drop'], seat: ['drop'] });
    expect(deliveryOrder(humanChain)).toEqual(['drop']);

    // End-to-end `runSend`: a seat with no order may take the implied socket. A seat whose word
    // is only the retired name walks drop, dials nothing, and names no typed or socket leg.
    const runAcceptingSend = async (withAlias: boolean) => {
      const made: World = world(withAlias ? ['mcp-inbox'] : null);
      cleanups.push(made.cleanup);
      const settingsPath = cliHookSettingsPath(made.dir, 'acme', 'lead');
      if (settingsPath === null) throw new Error('expected hook settings path for lead');
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ crossSessionInbound: 'accept' }));
      writeFileSync(join(made.sockets, '222.sock'), '');
      const settingsAt = Date.now() - 60_000;
      utimesSync(settingsPath, new Date(settingsAt), new Date(settingsAt));

      if (withAlias) {
        const teamPath = join(made.dir, 'team.yaml');
        const raw = readFileSync(teamPath, 'utf8');
        writeFileSync(
          teamPath,
          raw.replace('    name: lead\n', '    name: lead\n    delivery_order: [mcp-inbox]\n'),
        );
      }

      const dialed: string[] = [];
      const host = fake(made, {
        deliver: async (_path: string, frame: string) => {
          dialed.push(frame);
          return { ok: true };
        },
      });
      const io = owner(made.root);
      const code = await runSend(['lead', 'hello over implied socket', '--json'], io, host);
      expect(code).toBe(0);
      if (withAlias) expect(io.err).toContain('queued');
      else expect(io.err).toBe('');
      expect(host.frames).toEqual([]);
      expect(dialed).toHaveLength(withAlias ? 0 : 1);
      const report = JSON.parse(io.out) as {
        status: string;
        via: string;
        delivery: { leg: string; state: string; reason?: string }[];
      };
      const history = readHistory('acme', made.root, made.home);
      return { report, history };
    };

    const plainRun = await runAcceptingSend(false);
    const aliasRun = await runAcceptingSend(true);

    expect(aliasRun.report.delivery).not.toEqual(plainRun.report.delivery);
    expect(aliasRun.report.delivery.map((d) => d.leg)).toEqual(['drop']);
    expect(aliasRun.report.delivery.some((d) => d.leg === 'typed' || d.leg === 'socket')).toBe(false);
    expect(aliasRun.history.ok).toBe(true);
    if (!aliasRun.history.ok) throw new Error(aliasRun.history.reason);
    expect(aliasRun.history.entries).toHaveLength(1);
    expect(aliasRun.history.entries[0]?.via).toBe('drop');
  });
});

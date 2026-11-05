// Independent verification of fix/relay-owner-default-off (7ef125e6f):
// 1. Rules for a seat (both lead and plain seat) in an entity with a main orchestrator and no
//    setting carry no relay line (and `policyRuleLines(null, ...)` on an unreadable chain also
//    omits the relay line).
// 2. Setting `entity.main-orchestrator.relays-owner` to `on` at the entity level brings the relay
//    line back for both lead and non-lead seats; unsetting or setting `off` drops it again.
// 3. `entity.main-orchestrator.relays-owner` is entity-only: `team` and `project` levels are
//    refused by `planPolicySet`, `writePolicySet`, `runPolicy`, and `resolvePolicyChain`, and can
//    never turn the relay line on.
// 4. The policy status (`runPolicy` table and `--json`), `resolvePolicyChain`, `resolveWorkSettings`,
//    and `POLICY_CATALOGUE` readings all report `off` by default.
// All homes, repositories, and callers are synthetic in-memory fakes.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPolicy } from '../src/commands/policy.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { rulesOf } from '../src/launch/rules.ts';
import { rulesDeliveryOf } from '../src/launch/rules-file.ts';
import {
  loadAndResolvePolicyChain,
  planPolicySet,
  POLICY_CATALOGUE,
  readPolicyChain,
  resolvePolicyChain,
  writePolicySet,
  writePolicyUnset,
} from '../src/policy/index.ts';
import { policyRuleLines, resolveWorkSettings, type WorkSettings } from '../src/policy/work-settings.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-04T10:00:00.000Z');

const RELAY_LINE =
  "A decision the entity's main orchestrator relays from the owner quotes the owner and cites its owner-decisions entry: act on it without asking again.";
const PANE_LINE =
  "A lead may type or choose in a seat's pane when `team send` cannot reach it or a dialog blocks it: read the pane before and after, and never type into the owner's own pane.";
const SELF_LINE = 'A lead in dev mode may bring back a stopped seat, and build when no watcher runs.';
const SCOPE_LINE =
  "The owner's reserved scope: public releases, spending, credentials, the owner's machine (OS and system settings, accounts and logins, keychain, hardware). Checkouts, seats and team config belong to the teams.";

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createWorld() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'relay-default-off-ind-')));
  cleanupDirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });

  const yaml = `format: 1
project: acme
entity: acme-corp
coordinator: lead
operator: lead
session: acme
trust:
  - ~/.config/team/lobbies/acme-corp
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "5"
    launch: codex
    leads: true
  - role: implementer
    name: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "5"
    launch: codex
`;
  writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
  const loaded = loadTeamFile(root, { home, checkOnly: true });
  if (!loaded.ok) throw new Error(loaded.errors.map((e) => e.message).join('\n'));
  return { base, root, home, team: loaded.team };
}

function workSettingsFor(w: ReturnType<typeof createWorld>): WorkSettings {
  return resolveWorkSettings(
    readPolicyChain({
      home: w.home,
      entity: w.team.entity ?? undefined,
      projectId: 'acme',
      teamRoot: w.root,
      team: w.team,
    }),
    {},
    { now: NOW, home: w.home },
  );
}

describe('fix/relay-owner-default-off independent verification', () => {
  test('1. rules for a seat in an entity with a main orchestrator and no setting carry no relay line', () => {
    const w = createWorld();
    const lead = w.team.seats.find((s) => s.name === 'lead')!;
    const worker = w.team.seats.find((s) => s.name === 'worker')!;

    // Default entityOrchestrator is 'auto' (main orchestrator active); relaysOwner is unset ('off' by default)
    const work = workSettingsFor(w);
    expect(work.entityOrchestrator).toEqual({ value: 'auto', from: 'default' });
    expect(work.relaysOwner).toEqual({ value: 'off', from: 'default' });

    const leadRules = rulesOf(w.team, lead, w.root, work);
    expect(leadRules).not.toContain(RELAY_LINE);
    expect(leadRules).toContain(PANE_LINE);
    expect(leadRules).toContain(SELF_LINE);
    expect(leadRules).toContain(SCOPE_LINE);

    const workerRules = rulesOf(w.team, worker, w.root, work);
    expect(workerRules).not.toContain(RELAY_LINE);
    expect(workerRules).not.toContain(PANE_LINE);
    expect(workerRules).not.toContain(SELF_LINE);
    expect(workerRules).toContain(SCOPE_LINE);

    // Even when entity-orchestrator is explicitly set to 'dedicated', with no relays-owner setting the relay line stays absent
    const dedicated = writePolicySet(
      w.home,
      { level: 'entity', target: 'acme-corp', name: 'entity-orchestrator', value: 'dedicated' },
      { now: NOW },
    );
    expect(dedicated.ok).toBe(true);
    const workDedicated = workSettingsFor(w);
    expect(workDedicated.entityOrchestrator).toEqual({ value: 'dedicated', from: 'entity' });
    expect(workDedicated.relaysOwner).toEqual({ value: 'off', from: 'default' });
    expect(rulesOf(w.team, lead, w.root, workDedicated)).not.toContain(RELAY_LINE);
    expect(rulesOf(w.team, worker, w.root, workDedicated)).not.toContain(RELAY_LINE);

    // `rulesDeliveryOf` and `policyRuleLines(null, ...)` (fallback when chain is null) also omit the relay line
    const delivery = rulesDeliveryOf({ kind: 'none' }, w.team, lead, w.root, w.home);
    if ('refusal' in delivery) throw new Error(delivery.refusal);
    expect(delivery.text).not.toContain(RELAY_LINE);
    expect(delivery.text).toContain(PANE_LINE);
    expect(delivery.text).toContain(SELF_LINE);
    expect(delivery.text).toContain(SCOPE_LINE);

    expect(policyRuleLines(null, { lead: true, entity: true })).toEqual([PANE_LINE, SELF_LINE, SCOPE_LINE]);
    expect(policyRuleLines(null, { lead: false, entity: true })).toEqual([SCOPE_LINE]);
  });

  test('2. entity set on brings the relay line back for both lead and plain seat, and unset or off removes it again', async () => {
    const w = createWorld();
    const lead = w.team.seats.find((s) => s.name === 'lead')!;
    const worker = w.team.seats.find((s) => s.name === 'worker')!;

    // Turn on at entity level via `runPolicy` CLI
    const setIo = testIo(w.root, { kind: 'owner' });
    const setCode = await runPolicy(
      ['set', 'entity', 'entity.main-orchestrator.relays-owner', 'on', '--entity', 'acme-corp'],
      setIo,
      { home: w.home, now: NOW },
    );
    expect(setCode, setIo.err).toBe(0);

    const workOn = workSettingsFor(w);
    expect(workOn.relaysOwner).toEqual({ value: 'on', from: 'entity' });
    expect(rulesOf(w.team, lead, w.root, workOn)).toContain(`- ${RELAY_LINE}`);
    expect(rulesOf(w.team, worker, w.root, workOn)).toContain(`- ${RELAY_LINE}`);
    expect(policyRuleLines(workOn, { lead: true, entity: true })).toEqual([
      RELAY_LINE,
      PANE_LINE,
      SELF_LINE,
      SCOPE_LINE,
    ]);
    expect(policyRuleLines(workOn, { lead: false, entity: true })).toEqual([RELAY_LINE, SCOPE_LINE]);

    // Unset at entity level returns to default `off` and drops the relay line
    const unsetRes = writePolicyUnset(
      w.home,
      { level: 'entity', target: 'acme-corp', name: 'entity.main-orchestrator.relays-owner' },
    );
    expect(unsetRes.ok).toBe(true);
    const workAfterUnset = workSettingsFor(w);
    expect(workAfterUnset.relaysOwner).toEqual({ value: 'off', from: 'default' });
    expect(rulesOf(w.team, lead, w.root, workAfterUnset)).not.toContain(RELAY_LINE);
    expect(rulesOf(w.team, worker, w.root, workAfterUnset)).not.toContain(RELAY_LINE);

    // Underscore alias `entity.main_orchestrator.relays_owner` also turns it on at entity level, and `off` drops it
    expect(
      writePolicySet(
        w.home,
        { level: 'entity', target: 'acme-corp', name: 'entity.main_orchestrator.relays_owner', value: 'on' },
        { now: NOW },
      ).ok,
    ).toBe(true);
    expect(rulesOf(w.team, lead, w.root, workSettingsFor(w))).toContain(RELAY_LINE);

    expect(
      writePolicySet(
        w.home,
        { level: 'entity', target: 'acme-corp', name: 'entity.main_orchestrator.relays_owner', value: 'off' },
        { now: NOW },
      ).ok,
    ).toBe(true);
    const workExplicitOff = workSettingsFor(w);
    expect(workExplicitOff.relaysOwner).toEqual({ value: 'off', from: 'entity' });
    expect(rulesOf(w.team, lead, w.root, workExplicitOff)).not.toContain(RELAY_LINE);
  });

  test('3. a team or project level cannot turn on entity.main-orchestrator.relays-owner (entity-only)', async () => {
    const w = createWorld();
    const lead = w.team.seats.find((s) => s.name === 'lead')!;

    expect(POLICY_CATALOGUE['entity.main-orchestrator.relays-owner'].levels).toEqual(['entity']);

    // `planPolicySet` and `writePolicySet` reject `project` and `team` levels
    for (const level of ['project', 'team'] as const) {
      const target = level === 'project' ? 'acme' : w.root;
      const planned = planPolicySet(w.home, {
        level,
        target,
        ...(level === 'team' ? { teamRoot: w.root } : {}),
        name: 'entity.main-orchestrator.relays-owner',
        value: 'on',
      });
      expect(planned.ok).toBe(false);
      if (!planned.ok) {
        expect(planned.why).toContain(`may not be set at level ${level} (allowed: entity)`);
      }

      const written = writePolicySet(
        w.home,
        {
          level,
          target,
          ...(level === 'team' ? { teamRoot: w.root } : {}),
          name: 'entity.main-orchestrator.relays-owner',
          value: 'on',
        },
        { now: NOW },
      );
      expect(written.ok).toBe(false);

      // CLI `team policy set <level> entity.main-orchestrator.relays-owner on` is refused (exit 2)
      const io = testIo(w.root, { kind: 'owner' });
      const argv =
        level === 'project'
          ? ['set', 'project', 'entity.main-orchestrator.relays-owner', 'on', '--project', 'acme']
          : ['set', 'team', 'entity.main-orchestrator.relays-owner', 'on'];
      const code = await runPolicy(argv, io, { home: w.home, now: NOW });
      expect(code).toBe(2);
      expect(io.err).toContain(`may not be set at level ${level} (allowed: entity)`);
    }

    // Even if a forged or hand-constructed policy source injects `entity.main-orchestrator.relays-owner: 'on'`
    // at the `project` or `team` level, `resolvePolicyChain` refuses the invalid level and `resolveWorkSettings`
    // falls back to `off`, never printing the relay line.
    for (const forgedLevel of ['project', 'team'] as const) {
      const forgedSources = {
        [forgedLevel]: {
          level: forgedLevel,
          target: forgedLevel === 'project' ? 'acme' : w.root,
          generation: 1,
          declarations: [
            {
              name: 'entity.main-orchestrator.relays-owner',
              value: 'on',
              kind: 'advised' as const,
            },
          ],
        },
      };
      const resolved = resolvePolicyChain(forgedSources, { now: NOW, upToLevel: 'team' });
      expect(resolved.ok).toBe(false);
      const work = resolveWorkSettings(forgedSources, {}, { now: NOW, home: w.home });
      expect(work.relaysOwner).toEqual({ value: 'off', from: 'default' });
      expect(rulesOf(w.team, lead, w.root, work)).not.toContain(RELAY_LINE);
    }
  });

  test('4. status and settings readings (POLICY_CATALOGUE, resolvePolicyChain, resolveWorkSettings, and team policy view) say off by default', async () => {
    const w = createWorld();

    // 1. Catalogue spec default
    const spec = POLICY_CATALOGUE['entity.main-orchestrator.relays-owner'];
    expect(spec.defaultValue).toBe('off');
    expect(spec.kind).toBe('advised');
    expect(spec.levels).toEqual(['entity']);

    // 2. Resolved policy chain default entry
    const chain = loadAndResolvePolicyChain(
      {
        home: w.home,
        entity: 'acme-corp',
        projectId: 'acme',
        teamRoot: w.root,
        team: w.team,
      },
      { now: NOW },
    );
    expect(chain.ok).toBe(true);
    if (!chain.ok) throw new Error('expected chain.ok');
    expect(chain.policies['entity.main-orchestrator.relays-owner']).toMatchObject({
      name: 'entity.main-orchestrator.relays-owner',
      value: 'off',
      level: 'default',
      kind: 'advised',
    });

    // 3. WorkSettings reading
    const work = workSettingsFor(w);
    expect(work.relaysOwner).toEqual({ value: 'off', from: 'default' });

    // 4. `team policy` status table and `--json` output
    const tableIo = testIo(w.root, { kind: 'owner' });
    const tableCode = await runPolicy([], tableIo, { home: w.home, now: NOW });
    expect(tableCode, tableIo.err).toBe(0);
    const relayRow = tableIo.out
      .split('\n')
      .find((line) => line.includes('entity.main-orchestrator.relays-owner'));
    expect(relayRow).toBeDefined();
    expect(relayRow).toMatch(/entity\.main-orchestrator\.relays-owner\s+off\s+default\s+-\s+-\s+advised/);

    const jsonIo = testIo(w.root, { kind: 'owner' });
    const jsonCode = await runPolicy(['--json'], jsonIo, { home: w.home, now: NOW });
    expect(jsonCode, jsonIo.err).toBe(0);
    const parsed = JSON.parse(jsonIo.out);
    const jsonEntry = parsed.policies.find(
      (p: { name: string }) => p.name === 'entity.main-orchestrator.relays-owner',
    );
    expect(jsonEntry).toMatchObject({
      name: 'entity.main-orchestrator.relays-owner',
      value: 'off',
      level: 'default',
      kind: 'advised',
    });
  });
});

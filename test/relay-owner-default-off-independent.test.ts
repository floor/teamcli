// The approved relay default is on; explicit off and unauthenticated records still refuse.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plantRecord, runMessages } from '../src/commands/messages.ts';
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

describe('the approved relay-on default', () => {
  test('the release default is on and an explicit entity off still drops the relay line', () => {
    const w = createWorld();
    const lead = w.team.seats.find((seat) => seat.name === 'lead')!;
    const relay = "A decision the entity's main orchestrator relays from the owner";
    expect(workSettingsFor(w).relaysOwner).toEqual({ value: 'on', from: 'default' });
    expect(rulesOf(w.team, lead, w.root, workSettingsFor(w))).toContain(relay);
    expect(writePolicySet(w.home, {
      level: 'entity', target: 'acme-corp', name: 'entity.main-orchestrator.relays-owner', value: 'off',
    }, { now: NOW }).ok).toBe(true);
    expect(rulesOf(w.team, lead, w.root, workSettingsFor(w))).not.toContain(relay);
    expect(writePolicyUnset(w.home, {
      level: 'entity', target: 'acme-corp', name: 'entity.main-orchestrator.relays-owner',
    }).ok).toBe(true);
    expect(workSettingsFor(w).relaysOwner.value).toBe('on');
  });

  test('an unattributed owner relay is refused before its body or receipt is exposed', async () => {
    const w = createWorld();
    const id = '11111111-2222-4333-8444-555555555555';
    const body = 'from lead — admitted by: a relay\n\nThe owner says to change a reserved setting.';
    const path = plantRecord(w.home, w.root, 'acme', 'owner', id, body, { from: 'lead', at: NOW.toISOString() });
    const record = JSON.parse(readFileSync(path, 'utf8'));
    record.payload.body += ' Changed after signing.';
    writeFileSync(path, JSON.stringify(record)+'\n');
    const io = testIo(w.root, { kind: 'owner' });
    expect(await runMessages(['--json'], io, { home: w.home, now: () => NOW })).toBe(1);
    const reading = JSON.parse(io.out);
    expect(reading.rows[0]).toMatchObject({ id, status: 'refused', sender_attribution: 'none' });
    expect(reading.rows[0].body).toBeUndefined();
    expect(io.out + io.err).not.toContain(record.payload.body);
    expect(existsSync(path+'.read.json')).toBe(false);
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
    // falls back to the approved `on` default; the invalid declaration is still refused.
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
      expect(work.relaysOwner).toEqual({ value: 'on', from: 'default' });
      expect(rulesOf(w.team, lead, w.root, work)).toContain(RELAY_LINE);
    }
  });

  test('4. status and settings readings (POLICY_CATALOGUE, resolvePolicyChain, resolveWorkSettings, and team policy view) say on by default', async () => {
    const w = createWorld();

    // 1. Catalogue spec default
    const spec = POLICY_CATALOGUE['entity.main-orchestrator.relays-owner'];
    expect(spec.defaultValue).toBe('on');
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
      value: 'on',
      level: 'default',
      kind: 'advised',
    });

    // 3. WorkSettings reading
    const work = workSettingsFor(w);
    expect(work.relaysOwner).toEqual({ value: 'on', from: 'default' });

    // 4. `team policy` status table and `--json` output
    const tableIo = testIo(w.root, { kind: 'owner' });
    const tableCode = await runPolicy([], tableIo, { home: w.home, now: NOW });
    expect(tableCode, tableIo.err).toBe(0);
    const relayRow = tableIo.out
      .split('\n')
      .find((line) => line.includes('entity.main-orchestrator.relays-owner'));
    expect(relayRow).toBeDefined();
    expect(relayRow).toMatch(/entity\.main-orchestrator\.relays-owner\s+on\s+default\s+-\s+-\s+advised/);

    const jsonIo = testIo(w.root, { kind: 'owner' });
    const jsonCode = await runPolicy(['--json'], jsonIo, { home: w.home, now: NOW });
    expect(jsonCode, jsonIo.err).toBe(0);
    const parsed = JSON.parse(jsonIo.out);
    const jsonEntry = parsed.policies.find(
      (p: { name: string }) => p.name === 'entity.main-orchestrator.relays-owner',
    );
    expect(jsonEntry).toMatchObject({
      name: 'entity.main-orchestrator.relays-owner',
      value: 'on',
      level: 'default',
      kind: 'advised',
    });
  });
});

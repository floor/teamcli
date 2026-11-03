// The lead rules OD-20261103-03 decided, carried in every seat's generated rules: the entity
// main orchestrator's relay of the owner's word, pane actions and self-service for leads, and
// the owner's reserved scope with the team-owned rest. Defaults print; a setting turned off
// drops its line; the rules file is checked against the live team file's text.
// Synthetic homes and repositories only.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTeamFile } from '../src/file/load.ts';
import { rulesOf } from '../src/launch/rules.ts';
import { checkRulesFile, rulesDeliveryOf, rulesFileHash, writeRulesFile } from '../src/launch/rules-file.ts';
import { readPolicyChain, writePolicySet } from '../src/policy/sources.ts';
import { policyRuleLines, resolveWorkSettings, type WorkSettings } from '../src/policy/work-settings.ts';

const NOW = new Date('2026-11-03T18:00:00Z');

const RELAY =
  "A decision the entity's main orchestrator relays from the owner quotes the owner and cites its owner-decisions entry: act on it without asking again.";
const PANE =
  "A lead may type or choose in a seat's pane when `team send` cannot reach it or a dialog blocks it: read the pane before and after, and never type into the owner's own pane.";
const SELF = 'A lead in dev mode may bring back a stopped seat, and build when no watcher runs.';
const SCOPE =
  "The owner's reserved scope: public releases, spending, credentials, the owner's machine (OS and system settings, accounts and logins, keychain, hardware). Checkouts, seats and team config belong to the teams.";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function teamYaml(extra = ''): string {
  return `format: 1
project: acme
entity: acme-corp
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
${extra}seats:
  - role: coordinator
    name: lead
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex
  - role: builder
    name: worker
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex
`;
}

function world(extra = '') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'rules-settings-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamYaml(extra));
  const loaded = loadTeamFile(root, { home, checkOnly: true });
  if (!loaded.ok) throw new Error(loaded.errors.map((e) => e.message).join('\n'));
  return { base, root, home, team: loaded.team };
}

function workOf(w: { home: string; root: string; team: ReturnType<typeof world>['team'] }): WorkSettings {
  return resolveWorkSettings(
    readPolicyChain({ home: w.home, entity: w.team.entity ?? undefined, projectId: 'acme', teamRoot: w.root, team: w.team }),
    {},
    { now: NOW, home: w.home },
  );
}

function set(w: { home: string; root: string }, level: 'entity' | 'team', name: string, value: unknown) {
  const target = level === 'entity' ? 'acme-corp' : w.root;
  return writePolicySet(w.home, { level, target, ...(level === 'team' ? { teamRoot: w.root } : {}), name, value }, { now: NOW });
}

describe('the generated rules carry the lead rules of OD-20261103-03', () => {
  test('a lead reads all four at their defaults; the defaults are what an unset chain gives', () => {
    const w = world();
    const work = workOf(w);
    expect(work.relaysOwner).toEqual({ value: 'on', from: 'default' });
    expect(work.paneActions).toEqual({ value: 'on', from: 'default' });
    expect(work.leadSelfService).toEqual({ value: 'on', from: 'default' });
    expect(work.ownerReservedScope.from).toBe('default');
    const lead = w.team.seats.find((s) => s.name === 'lead')!;
    const text = rulesOf(w.team, lead, w.root, work);
    for (const line of [RELAY, PANE, SELF, SCOPE]) expect(text).toContain(`- ${line}`);
    // A chain that could not be read keeps the same defaults: these lines never vanish silently.
    expect(policyRuleLines(null, { lead: true, entity: true })).toEqual([RELAY, PANE, SELF, SCOPE]);
  });

  test('a seat that is not a lead reads the relay and the reserved scope, never the lead-only lines', () => {
    const w = world();
    const worker = w.team.seats.find((s) => s.name === 'worker')!;
    const text = rulesOf(w.team, worker, w.root, workOf(w));
    expect(text).toContain(RELAY);
    expect(text).toContain(SCOPE);
    expect(text).not.toContain(PANE);
    expect(text).not.toContain(SELF);
  });

  test('a team outside an entity reads neither the relay nor the lead lines; the scope stays', () => {
    const w = world();
    const withoutEntity = { ...w.team, entity: null };
    const lead = w.team.seats.find((s) => s.name === 'lead')!;
    const text = rulesOf(withoutEntity, lead, w.root, workOf(w));
    expect(text).not.toContain(RELAY);
    expect(text).toContain(PANE);
    expect(text).toContain(SCOPE);
  });

  test('the owner-decision spellings set each setting, and off drops its line', () => {
    const w = world();
    expect(set(w, 'entity', 'entity.main_orchestrator.relays_owner', 'off').ok).toBe(true);
    expect(set(w, 'team', 'leads.pane_actions', 'off').ok).toBe(true);
    expect(set(w, 'team', 'leads.self_service', 'off').ok).toBe(true);
    const work = workOf(w);
    expect(work.relaysOwner).toEqual({ value: 'off', from: 'entity' });
    expect(work.paneActions).toEqual({ value: 'off', from: 'team' });
    expect(work.leadSelfService).toEqual({ value: 'off', from: 'team' });
    const lead = w.team.seats.find((s) => s.name === 'lead')!;
    const text = rulesOf(w.team, lead, w.root, work);
    expect(text).not.toContain(RELAY);
    expect(text).not.toContain(PANE);
    expect(text).not.toContain(SELF);
    expect(text).toContain(SCOPE);
  });

  test("an entity with no main orchestrator drops the relay line even while the setting is on", () => {
    const w = world();
    expect(set(w, 'entity', 'entity-orchestrator', 'off').ok).toBe(true);
    const lead = w.team.seats.find((s) => s.name === 'lead')!;
    const text = rulesOf(w.team, lead, w.root, workOf(w));
    expect(text).not.toContain(RELAY);
    expect(text).toContain(PANE);
    expect(text).toContain(SCOPE);
  });

  test('the reserved scope is a list a team can rewrite; the team-owned sentence stays', () => {
    const w = world();
    expect(set(w, 'team', 'owner.reserved_scope', 'public releases; spending').ok).toBe(true);
    const work = workOf(w);
    expect(work.ownerReservedScope.value).toEqual(['public releases', 'spending']);
    const lead = w.team.seats.find((s) => s.name === 'lead')!;
    expect(rulesOf(w.team, lead, w.root, work)).toContain(
      "- The owner's reserved scope: public releases, spending. Checkouts, seats and team config belong to the teams.",
    );
  });

  test('a seat launched fresh gets the lines in its rules file, and a stale file is named', () => {
    const w = world();
    const lead = w.team.seats.find((s) => s.name === 'lead')!;
    const delivery = rulesDeliveryOf({ kind: 'none' }, w.team, lead, w.root, w.home);
    if ('refusal' in delivery) throw new Error(delivery.refusal);
    for (const line of [RELAY, PANE, SELF, SCOPE]) expect(delivery.text).toContain(`- ${line}`);
    const written = writeRulesFile(
      { kind: 'none' },
      'lead',
      w.root,
      w.home,
      delivery.text,
      rulesFileHash(delivery.text),
      () => 'rules-settings-test',
      w.team.project,
    );
    expect(written.ok).toBe(true);
    expect(readFileSync(delivery.path, 'utf8')).toBe(delivery.text);
    expect(checkRulesFile(delivery.path, delivery.text)).toEqual({ ok: true });
    // The text before these rules, without the new line, is a difference the team check names.
    const stale = delivery.text
      .split('\n')
      .filter((line) => !line.includes("- The owner's reserved scope:"))
      .join('\n');
    const rewrote = writeRulesFile(
      { kind: 'none' },
      'lead',
      w.root,
      w.home,
      stale,
      rulesFileHash(stale),
      () => 'rules-settings-stale',
      w.team.project,
    );
    expect(rewrote.ok).toBe(true);
    expect(checkRulesFile(delivery.path, delivery.text)).toEqual({
      ok: false,
      what: "its rules file differs from the team file's rules",
    });
  });
});

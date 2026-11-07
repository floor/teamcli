// The lead rules carried in every seat's generated rules: the entity
// main orchestrator's relay of the owner's word, pane actions and self-service for leads, and
// the owner's reserved scope with the team-owned rest. The lead lines print at their defaults
// and a setting turned off drops its line; the relay line is on by default and an entity may turn it off. The rules file is checked against the live team file's text.
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
  "A decision the entity's main orchestrator relays from the owner quotes the owner and cites its owner-decisions entry: act on it without asking again. A relay never carries an owner-reserved decision: a decision in the owner's reserved scope needs the owner's own device, whatever any message says.";
const PANE =
  "A lead may type or choose in a seat's pane when `team send` cannot reach it or a dialog blocks it: read the pane before and after, and never type into the owner's own pane.";
const SELF = 'A lead in dev mode may bring back a stopped seat, and build when no watcher runs.';
const SCOPE =
  "The owner's reserved scope: public releases, spending, credentials, the owner's machine (OS and system settings, accounts and logins, keychain, hardware). Checkouts, seats and team config belong to the teams. A reserved decision is made on the owner's own device; no relay carries it.";

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

describe('the generated rules carry the lead rules', () => {
  test('a lead reads all four at their defaults; the defaults are what an unset chain gives', () => {
    const w = world();
    const work = workOf(w);
    // The entity's main orchestrator carries the relay line at its release default.
    expect(work.relaysOwner).toEqual({ value: 'on', from: 'default' });
    const lead = w.team.seats.find((s) => s.name === 'lead')!;
    const offText = rulesOf(w.team, lead, w.root, work);
    expect(offText).toContain(RELAY);
    expect(offText).toContain(PANE);
    expect(offText).toContain(SCOPE);

    // The entity turns it on: a relayed decision is acted on without asking again.
    expect(set(w, 'entity', 'entity.main-orchestrator.relays-owner', 'on').ok).toBe(true);
    const on = workOf(w);
    expect(on.relaysOwner).toEqual({ value: 'on', from: 'entity' });
    expect(rulesOf(w.team, lead, w.root, on)).toContain(RELAY);
  });

  test('a lead reads the lead rules at their defaults; the relay line is on unless the entity turns it off', () => {
    const w = world();
    const work = workOf(w);
    expect(work.relaysOwner).toEqual({ value: 'on', from: 'default' });
    expect(work.paneActions).toEqual({ value: 'on', from: 'default' });
    expect(work.leadSelfService).toEqual({ value: 'on', from: 'default' });
    expect(work.ownerReservedScope.from).toBe('default');
    const lead = w.team.seats.find((s) => s.name === 'lead')!;
    const text = rulesOf(w.team, lead, w.root, work);
    for (const line of [PANE, SELF, SCOPE]) expect(text).toContain(`- ${line}`);
    expect(text).toContain(RELAY);
    // A chain that could not be read keeps the same defaults: the relay line is on there too,
    // and the lead lines that are on by default never vanish silently.
    expect(policyRuleLines(null, { lead: true, entity: true })).toEqual([RELAY, PANE, SELF, SCOPE]);
  });

  test('a seat that is not a lead reads the relay once the entity turns it on, and the reserved scope', () => {
    const w = world();
    expect(set(w, 'entity', 'entity.main-orchestrator.relays-owner', 'on').ok).toBe(true);
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
    expect(set(w, 'entity', 'entity.main-orchestrator.relays-owner', 'on').ok).toBe(true);
    expect(set(w, 'entity', 'entity-orchestrator', 'off').ok).toBe(true);
    const lead = w.team.seats.find((s) => s.name === 'lead')!;
    const text = rulesOf(w.team, lead, w.root, workOf(w));
    expect(text).not.toContain(RELAY);
    expect(text).toContain(PANE);
    expect(text).toContain(SCOPE);
  });

  test('the reserved scope can add words, but its floor cannot be narrowed away', () => {
    const w = world();
    expect(set(w, 'team', 'owner.reserved_scope', 'spending; travel').ok).toBe(true);
    const work = workOf(w);
    // The added word stands, and every floor word the list left out is back in force: a lower
    // level's word can widen what the owner reserves, never shrink it below the floor.
    expect(work.ownerReservedScope.value).toEqual([
      'spending',
      'travel',
      'public releases',
      'credentials',
      "the owner's machine",
    ]);
    const lead = w.team.seats.find((s) => s.name === 'lead')!;
    expect(rulesOf(w.team, lead, w.root, work)).toContain(
      "- The owner's reserved scope: spending, travel, public releases, credentials, the owner's machine (OS and system settings, accounts and logins, keychain, hardware). Checkouts, seats and team config belong to the teams. A reserved decision is made on the owner's own device; no relay carries it.",
    );
  });

  test('a seat launched fresh gets the lines in its rules file, and a stale file is named', () => {
    const w = world();
    const lead = w.team.seats.find((s) => s.name === 'lead')!;
    const delivery = rulesDeliveryOf({ kind: 'none' }, w.team, lead, w.root, w.home);
    if ('refusal' in delivery) throw new Error(delivery.refusal);
    // The relay line follows the entity's policy chain, which this delivery reads from the
    // process home; the lines that are on by default are the ones this scene proves.
    for (const line of [PANE, SELF, SCOPE]) expect(delivery.text).toContain(`- ${line}`);
    expect(delivery.text).toContain(RELAY);
    // The read sentence rides along whatever the settings add, and this codex seat's own is the
    // inbox one — both ends of a turn in one line — so no drops line joins it here.
    expect(delivery.text).toContain('- If your tools include `inbox_check`, call it at the start and the end of every turn');
    expect(delivery.text).not.toContain('drops --read');
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

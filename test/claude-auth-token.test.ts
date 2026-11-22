// A Claude Code seat on Anthropic signs in from the machine's secret store: when the entity's store
// holds CLAUDE_CODE_OAUTH_TOKEN and `claude-auth` is `store` (the default), its launch line takes
// the entry's secret word, filled with the store's lookup, so only the seat's own shell reads the
// value. Every store here is a fake or an adapter with an injected probe: no scene runs a store
// command, reads a real store, or holds a real token.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { claudeNoLoginFindings, type DoctorSources } from '../src/commands/doctor.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { formatPlan, upPlan, type UpSeat } from '../src/launch/plan.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { systemSecretStore, type SecretStore } from '../src/secrets/store.ts';
import { claudeAuthInForce, claudeTokenLine, withClaudeToken } from '../src/settings/claude-auth-policy.ts';
import { CLAUDE_TOKEN_ENTRY, parseClaudeAuth } from '../src/settings/claude-auth.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv } from './helpers.ts';

const made: string[] = [];
afterEach(() => { const held = made.splice(0); discardFixtures(held, { roots: held.map(dirname) }); });
const NOW = new Date('2026-11-22T09:00:00Z');

/** A made-up value no seat line, record or plan may ever carry: the fake store never hands it out
 *  in a plan, because a plan never reads a value. */
const FAKE_VALUE = 'fake-oauth-value-7d1c';
const LOOKUP = `fake-store-lookup ${CLAUDE_TOKEN_ENTRY}`;
const WORD = `${CLAUDE_TOKEN_ENTRY}="$(${LOOKUP})"`;

/** A fake store that holds the entries named, answers a lookup command, and fails the test if any
 *  value is read. `asked` counts the presence questions. */
function fakeStore(held: string[]): SecretStore & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    read: async () => { throw new Error(`a launch never reads a value (${FAKE_VALUE})`); },
    lookupCommand: (name) => ({ ok: true, command: `fake-store-lookup ${typeof name === 'string' ? name : name.secret}` }),
    holds: (name) => { const key = typeof name === 'string' ? name : name.secret; asked.push(key); return held.includes(key); },
  };
}

const SEATS = `seats:
  - name: lead
    role: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - name: provider
    role: implementer
    cli: claude-code
    vendor: deepseek
    model: DeepSeek Flash
    version: "4.0"
    launch: ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic ANTHROPIC_AUTH_TOKEN={secret:DEEPSEEK_API_KEY} claude --model deepseek-flash
  - name: wrapped
    role: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: env ANTHROPIC_BASE_URL=https://provider.example claude --model claude-opus-5-5
  - name: scripted
    role: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: "bash -c 'ANTHROPIC_BASE_URL=https://provider.example claude --model claude-opus-5-5'"
  - name: worker
    role: implementer
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: codex -m gpt-6.1-sol
`;

/** A signed team in a scratch home, with `claude-auth` declared at team level when asked. */
function world(auth?: 'store' | 'login'): { home: string; root: string; team: TeamFile } {
  const base = fixtureBase('claude-auth-'); made.push(base);
  const home = join(base, 'home'), root = join(base, 'project');
  mkdirSync(home); mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
  const text = `format: 1\nproject: acme\nsession: morning\ncoordinator: lead\noperator: lead\nworkspace:\n  mode: shared\n${SEATS}`;
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  const checked = validateTeamFile(text, { home, root });
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  writeApproval(storePath('acme', root, home), { approval: approvalOf(checked.team, root, NOW), file: text }, checked.team.seats, home, NOW);
  if (auth !== undefined) {
    const wrote = writePolicySet(home, { level: 'team', target: teamIdOf(root), teamRoot: root, name: 'claude-auth', value: auth, kind: 'advised' }, { now: NOW });
    if (!wrote.ok) throw new Error(wrote.why);
  }
  const loaded = readTeamConfig(root, { home, source: 'file' });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return { home, root, team: loaded.team };
}

function seat(name: string, cli: string, launch: string): UpSeat {
  return { name, cli, launch, cwd: '.', label: name, stopped: false, rules: 'Rules.', repairLine: 'repair' };
}

function plan(w: ReturnType<typeof world>, store: SecretStore) {
  const seats = [
    seat('lead', 'claude-code', 'claude --model claude-opus-5-5'),
    seat('provider', 'claude-code', 'ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic ANTHROPIC_AUTH_TOKEN={secret:DEEPSEEK_API_KEY} claude --model deepseek-flash'),
    seat('wrapped', 'claude-code', 'env ANTHROPIC_BASE_URL=https://provider.example claude --model claude-opus-5-5'),
    seat('scripted', 'claude-code', "bash -c 'ANTHROPIC_BASE_URL=https://provider.example claude --model claude-opus-5-5'"),
    seat('worker', 'codex', 'codex -m gpt-6.1-sol'),
  ];
  const steps = upPlan({
    root: w.root, home: w.home, team: w.team, session: 'morning', sessionRunning: true, watchAlive: true, watchLabel: 'Watch',
    cliHooks: { lead: join(w.root, 'lead.json'), provider: join(w.root, 'provider.json'), wrapped: join(w.root, 'wrapped.json'), scripted: join(w.root, 'scripted.json') }, seats, secretStore: store,
  });
  const launches = new Map<string, { command: string; recordLine: string | undefined }>();
  for (const step of steps) if (step.do?.do === 'launch') launches.set(step.do.seat, { command: step.do.command, recordLine: step.do.recordLine });
  return { steps, launches, text: formatPlan(steps) };
}

describe('the line rule', () => {
  const on = { cli: 'claude-code', vendor: 'anthropic', auth: 'store' as const, held: true };
  test('a Claude Code seat on Anthropic takes the word only when the store holds the entry and the setting is store', () => {
    expect(withClaudeToken('claude --model x', on)).toBe(`${CLAUDE_TOKEN_ENTRY}={secret:${CLAUDE_TOKEN_ENTRY}} claude --model x`);
    expect(withClaudeToken('claude', { ...on, held: false })).toBe('claude');
    expect(withClaudeToken('claude', { ...on, held: null })).toBe('claude');
    expect(withClaudeToken('claude', { ...on, auth: 'login' })).toBe('claude');
    expect(withClaudeToken('claude', { ...on, vendor: 'deepseek' })).toBe('claude');
    expect(withClaudeToken('claude', { ...on, vendor: undefined })).toBe('claude');
    expect(withClaudeToken('codex', { ...on, cli: 'codex' })).toBe('codex');
  });
  test('a line with a credential or endpoint of its own, or one whose words do not read, is left as it is', () => {
    for (const line of [
      'ANTHROPIC_BASE_URL=https://example.test claude', 'ANTHROPIC_AUTH_TOKEN=x claude', 'ANTHROPIC_API_KEY=x claude',
      `${CLAUDE_TOKEN_ENTRY}=x claude`, "claude 'unclosed", 'CLAUDE_CODE_USE_BEDROCK=1 claude',
    ]) expect(withClaudeToken(line, on)).toBe(line);
  });
  test('a line through env, a shell, a wrapper or a launcher script gets nothing, whatever it sets inside (fail closed)', () => {
    for (const line of [
      // env with an endpoint after its first word
      'env ANTHROPIC_BASE_URL=https://provider.example claude',
      'env claude --model x',
      // a quoted shell script that routes the CLI
      "bash -c 'ANTHROPIC_BASE_URL=https://provider.example claude'",
      "zsh -c 'export ANTHROPIC_AUTH_TOKEN=x; claude'",
      // a wrapper or launcher script, even one that sets nothing visible
      'zsh ./as-acme.sh claude --model x',
      './launch-claude.sh',
      'team-deepseek',
      // compound lines and run-time words
      'export ANTHROPIC_BASE_URL=https://provider.example; claude',
      'claude && true', 'X=$(cat endpoint) claude', 'claude --model "$MODEL"',
      // a word that names a routing variable anywhere after the program, or a settings file of its own
      'claude --append-system-prompt ANTHROPIC_BASE_URL=https://provider.example',
      'claude --settings ./routes.json', 'claude --settings=./routes.json',
      // another program whose name merely contains it
      'claude-wrapper', 'notclaude',
    ]) {
      expect(claudeTokenLine(line), line).toBe(false);
      expect(withClaudeToken(line, on), line).toBe(line);
    }
    for (const line of ['claude', '/usr/local/bin/claude --model claude-opus-5-5', 'AGENT_UNATTENDED=1 claude --model x']) {
      expect(claudeTokenLine(line), line).toBe(true);
    }
  });
  test('the setting reads store or login, nothing else', () => {
    expect(parseClaudeAuth('store')).toBe('store');
    expect(parseClaudeAuth('login')).toBe('login');
    expect(parseClaudeAuth('on')).toBeNull();
  });
});

describe('the launch plan', () => {
  test('only the Anthropic Claude seat gets the lookup; no value is read, recorded or printed', () => {
    const w = world();
    expect(claudeAuthInForce({ home: w.home, root: w.root, team: w.team })).toBe('store');
    const store = fakeStore([CLAUDE_TOKEN_ENTRY, 'DEEPSEEK_API_KEY']);
    const { launches, steps, text } = plan(w, store);
    expect(launches.get('lead')?.command).toContain(`${WORD} claude --model claude-opus-5-5`);
    // The seat's record keeps the file's recipe: neither the word nor the lookup is in it.
    expect(launches.get('lead')?.recordLine).not.toContain(CLAUDE_TOKEN_ENTRY);
    expect(launches.get('provider')?.command).not.toContain(CLAUDE_TOKEN_ENTRY);
    expect(launches.get('provider')?.command).toContain('ANTHROPIC_AUTH_TOKEN="$(fake-store-lookup DEEPSEEK_API_KEY)"');
    expect(launches.get('worker')?.command).not.toContain(CLAUDE_TOKEN_ENTRY);
    // Declared on Anthropic, but routed through env or a quoted script to another endpoint: nothing.
    for (const name of ['wrapped', 'scripted']) {
      const op = steps.map((step) => step.do).find((one) => (one?.do === 'launch' || one?.do === 'refuse') && one.seat === name);
      expect(op, name).toBeDefined();
      expect(JSON.stringify(op), name).not.toContain(CLAUDE_TOKEN_ENTRY);
    }
    expect(JSON.stringify(steps)).not.toContain(FAKE_VALUE);
    expect(text).not.toContain(FAKE_VALUE);
    expect(text).not.toContain('{secret:');
    // Presence was asked for the Anthropic Claude seats alone (the wrapped ones are then refused by the gate).
    expect(store.asked.every((name) => name === CLAUDE_TOKEN_ENTRY)).toBe(true);
  });

  test('a seat on the shipped claude-code launcher, on Anthropic, takes it on its resolved line', () => {
    const w = world();
    const steps = upPlan({
      root: w.root, home: w.home, team: w.team, session: 'morning', sessionRunning: true, watchAlive: true, watchLabel: 'Watch',
      cliHooks: { lead: join(w.root, 'lead.json') }, secretStore: fakeStore([CLAUDE_TOKEN_ENTRY]),
      seats: [{ ...seat('lead', 'claude-code', 'claude'), launcher: 'claude-code', vendor: 'anthropic', model: 'Claude Opus', version: '5.5' }],
    });
    const op = steps.map((step) => step.do).find((one) => one?.do === 'launch');
    const command = op?.do === 'launch' ? op.command : '';
    expect(command).toContain(`${WORD} GH_TOKEN=`);
    expect(command).toContain(' claude --model claude-opus-5-5');
  });

  test('a store that holds no entry launches the seat as before', () => {
    const w = world();
    const { launches } = plan(w, fakeStore(['DEEPSEEK_API_KEY']));
    expect(launches.get('lead')?.command).not.toContain(CLAUDE_TOKEN_ENTRY);
  });

  test('claude-auth login keeps the session login: the store is not even asked', () => {
    const w = world('login');
    expect(claudeAuthInForce({ home: w.home, root: w.root, team: w.team })).toBe('login');
    const store = fakeStore([CLAUDE_TOKEN_ENTRY, 'DEEPSEEK_API_KEY']);
    const { launches } = plan(w, store);
    expect(launches.get('lead')?.command).not.toContain(CLAUDE_TOKEN_ENTRY);
    expect(store.asked).toEqual([]);
  });

  test('claude-auth store, declared, is the default\'s behaviour', () => {
    const w = world('store');
    const { launches } = plan(w, fakeStore([CLAUDE_TOKEN_ENTRY, 'DEEPSEEK_API_KEY']));
    expect(launches.get('lead')?.command).toContain(`${WORD} claude --model claude-opus-5-5`);
  });
});

describe('presence is read by name, never by value', () => {
  test('the Keychain probe runs the lookup without -w and reads only its exit status', () => {
    const calls: string[][] = [];
    const store = (status: number | null) => systemSecretStore({
      platform: 'darwin', runner: async () => { throw new Error('no value is read'); },
      probe: (command, args) => { calls.push([command, ...args]); return status; },
    })!;
    expect(store(0).holds?.(CLAUDE_TOKEN_ENTRY)).toBe(true);
    expect(store(44).holds?.(CLAUDE_TOKEN_ENTRY)).toBe(false);
    expect(store(1).holds?.(CLAUDE_TOKEN_ENTRY)).toBeNull();
    expect(calls.every((argv) => !argv.includes('-w'))).toBe(true);
    expect(calls[0]).toEqual(['/usr/bin/security', 'find-generic-password', '-s', CLAUDE_TOKEN_ENTRY]);
  });

  test('the encrypted file is read for its entry names, never decrypted', () => {
    const HOME = '/home/owner';
    const store = (text: string | null, file = true) => systemSecretStore({
      platform: 'linux', home: HOME, entity: 'acme', env: { HOME, PATH: '/usr/bin' },
      runner: async () => { throw new Error('nothing is decrypted'); },
      isFile: (path) => file || !path.endsWith('.env.sops'), isExecutable: (path) => path === '/usr/bin/sops',
      readText: () => text,
    })!;
    expect(store(`${CLAUDE_TOKEN_ENTRY}=ENC[AES256_GCM,data:abc,type:str]\nsops_version=3.9.0\n`).holds?.(CLAUDE_TOKEN_ENTRY)).toBe(true);
    expect(store('GITHUB_SEAT_TOKEN=ENC[AES256_GCM,data:abc,type:str]\n').holds?.(CLAUDE_TOKEN_ENTRY)).toBe(false);
    expect(store(null).holds?.(CLAUDE_TOKEN_ENTRY)).toBeNull();
    expect(store('', false).holds?.(CLAUDE_TOKEN_ENTRY)).toBe(false);
  });

  test('the suite never probes the machine\'s own store', () => {
    expect(process.env.TEAM_NO_SYSTEM_SECRETS).toBe('1');
    expect(systemSecretStore({ platform: 'darwin' })?.holds?.(CLAUDE_TOKEN_ENTRY)).toBeNull();
    expect(systemSecretStore({ platform: 'linux', entity: 'acme' })?.holds?.(CLAUDE_TOKEN_ENTRY)).toBeNull();
  });
});

describe('team doctor', () => {
  const sources = (w: ReturnType<typeof world>, store: SecretStore | null): DoctorSources => ({
    version: () => null, onPath: () => false, loggedIn: () => false, herdrVersion: () => null, sessionRunning: () => null,
    now: () => NOW, home: w.home, secretStore: () => store,
  });
  const HINT = 'claude auth login';
  const only = (w: ReturnType<typeof world>, names: string[]) => w.team.seats.filter((one) => names.includes(one.name));

  test('no session login and no entry: the miss names claude setup-token and the entry', () => {
    const w = world();
    const findings = claudeNoLoginFindings(w.team, w.root, w.team.seats, sources(w, fakeStore([])), HINT);
    expect(findings?.map((one) => one.level)).toEqual(['miss']);
    expect(findings?.[0]?.text).toContain('claude setup-token');
    expect(findings?.[0]?.text).toContain(`as ${CLAUDE_TOKEN_ENTRY}`);
    expect(claudeNoLoginFindings(w.team, w.root, w.team.seats, sources(w, null), HINT)?.[0]?.level).toBe('miss');
  });

  test('the entry held: ok names only the seats the launch hands it, and a seat that takes none still needs the login', () => {
    const w = world();
    const findings = claudeNoLoginFindings(w.team, w.root, w.team.seats, sources(w, fakeStore([CLAUDE_TOKEN_ENTRY])), HINT) ?? [];
    expect(findings[0]).toEqual({ level: 'ok', text: `claude-code: no session login; lead sign in with the secret store's ${CLAUDE_TOKEN_ENTRY}` });
    expect(findings[1]?.level).toBe('miss');
    expect(findings[1]?.text).toContain('wrapped, scripted take no stored token');
    expect(claudeNoLoginFindings(w.team, w.root, only(w, ['lead']), sources(w, fakeStore([CLAUDE_TOKEN_ENTRY])), HINT)?.map((one) => one.level)).toEqual(['ok']);
  });

  test('a team whose Claude seats would take no token gets no ok from the store: the plain login line stands', () => {
    const w = world();
    expect(claudeNoLoginFindings(w.team, w.root, only(w, ['wrapped', 'scripted', 'provider']), sources(w, fakeStore([CLAUDE_TOKEN_ENTRY])), HINT)).toBeNull();
  });

  test('claude-auth login keeps the plain login line', () => {
    const w = world('login');
    expect(claudeNoLoginFindings(w.team, w.root, w.team.seats, sources(w, fakeStore([CLAUDE_TOKEN_ENTRY])), HINT)).toBeNull();
  });
});

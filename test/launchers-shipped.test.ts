// The launchers TeamCLI ships: one per vendor CLI, configured by the seat's role and effort.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTeamFile } from '../src/file/validate.ts';
import { formatPlan, upPlan, type UpSeat } from '../src/launch/plan.ts';
import { accountKeyCommand, isShippedLauncher, shippedClaudeSettings, shippedEnv, shippedLauncher, shippedLauncherNames } from '../src/launchers/shipped.ts';
import { NO_SECRET_STORE, systemSecretStore, type SecretLookup, type SecretStore } from '../src/secrets/store.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { discover, resolveLaunch } from '../src/launchers/resolve.ts';

test('grok-build ships, and an unknown name does not', () => {
  expect(shippedLauncherNames()).toContain('grok-build');
  expect(isShippedLauncher('grok-build')).toBe(true);
  expect(isShippedLauncher('made-up')).toBe(false);
  expect(isShippedLauncher(undefined)).toBe(false);
  expect(isShippedLauncher('toString')).toBe(false);
  expect(shippedLauncher('made-up', {})).toBeNull();
});

test('a builder seat gets the always-approve line with the model named', () => {
  const made = shippedLauncher('grok-build', { role: 'builder' });
  expect(made?.argv).toEqual(['grok', '--trust', '--model', 'grok-4.7', '--no-subagents', '--always-approve']);
});

test('a reviewer seat gets the read-only line: no always-approve, writes, edits, git and bun denied', () => {
  const argv = shippedLauncher('grok-build', { role: 'reviewer' })?.argv ?? [];
  expect(argv).not.toContain('--always-approve');
  expect(argv.join(' ')).toContain('--permission-mode dontAsk');
  for (const rule of ['Write', 'Edit', 'Bash(git *)', 'Bash(bun *)']) {
    const at = argv.indexOf(rule);
    expect(at, rule).toBeGreaterThan(0);
    expect(argv.at(at - 1), rule).toBe('--deny');
  }
  expect(argv[argv.indexOf('Read') - 1]).toBe('--allow');
});

test('the seat\'s effort rides the line when it has one', () => {
  expect((shippedLauncher('grok-build', { role: 'builder', effort: 'high' })?.argv ?? []).slice(-2)).toEqual(['--effort', 'high']);
  expect(shippedLauncher('grok-build', { role: 'builder' })?.argv).not.toContain('--effort');
});

test('a shipped launcher passes the library\'s own validation and resolves to its argv', () => {
  const made = shippedLauncher('grok-build', { role: 'reviewer' });
  const found = discover([{ level: 'machine', files: { 'grok-build.yaml': made } }]);
  expect(found.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
  const resolved = resolveLaunch({ launcher: 'grok-build' }, found, {
    teamRoot: '/work/team', teamHome: '/work/team', cwd: '/work/team/seat', parentEnv: {}, existingPaths: [], seatNames: ['argus'],
  });
  expect(resolved.ok).toBe(true);
  if (resolved.ok) expect(resolved.argv.slice(0, 4)).toEqual(['grok', '--trust', '--model', 'grok-4.7']);
});

test('the model follows the seat\'s version, 4.7 when it names none', () => {
  expect(shippedLauncher('grok-build', { role: 'builder', version: '4.6' })?.argv).toContain('grok-4.6');
  expect(shippedLauncher('grok-build', { role: 'builder' })?.argv).toContain('grok-4.7');
  expect(shippedLauncher('grok-build', { role: 'builder', version: '4.7; rm' })?.argv).toContain('grok-4.7');
});

test('claude-code builds the Anthropic model id from the seat and skips the CLI prompts', () => {
  expect(shippedLauncher('claude-code', { model: 'Claude Opus', version: '5.5' })?.argv)
    .toEqual(['claude', '--model', 'claude-opus-5-5', '--dangerously-skip-permissions']);
  const reviewer = shippedLauncher('claude-code', { model: 'Claude Haiku', version: '5.5', role: 'tester' })?.argv ?? [];
  expect(reviewer).not.toContain('--dangerously-skip-permissions');
  expect(reviewer.join(' ')).toContain('--permission-mode dontAsk');
  expect(reviewer[reviewer.indexOf('--disallowedTools') + 1]).toContain('Bash(git *)');
  expect(reviewer).not.toContain('--settings');
  const settings = shippedClaudeSettings('claude-code', 'tester') as { sandbox: { enabled: boolean; excludedCommands: string[] }; permissions: { deny: string[] } };
  expect(settings.sandbox.enabled).toBe(true);
  expect(settings.sandbox.excludedCommands).toContain('team');
  expect(settings.permissions.deny).toContain('Edit(**)');
  expect(shippedLauncher('claude-code', { model: 'DeepSeek Flash', version: '4.0', vendor: 'deepseek' })?.argv)
    .toEqual(['claude', '--dangerously-skip-permissions']);
  expect(shippedEnv('claude-code', { model: 'Claude Opus', version: '5.5', effort: 'high' })).toEqual(['CLAUDE_CODE_EFFORT_LEVEL=high']);
});

test('claude-code on a provider takes its words from the launch account, the key only as a lookup', () => {
  const account = { name: 'deepseek', provider: 'deepseek', endpoint: 'https://api.deepseek.com/anthropic', keychain: 'deepseek-api-key',
    secret: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-flash', effortDefault: 'high', autoCompactWindow: 786432 };
  const words = shippedEnv('claude-code', { vendor: 'deepseek', account });
  expect(words).toContain('ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic');
  expect(words).toContain('ANTHROPIC_MODEL=deepseek-flash');
  expect(words).toContain('CLAUDE_CODE_SUBAGENT_MODEL=deepseek-flash');
  expect(words).toContain('CLAUDE_CODE_EFFORT_LEVEL=high');
  expect(words).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432');
  const token = words.find((word) => word.startsWith('ANTHROPIC_AUTH_TOKEN='));
  expect(token?.startsWith('ANTHROPIC_AUTH_TOKEN="$(/usr/bin/security ')).toBe(true);
  expect(token?.slice('ANTHROPIC_AUTH_TOKEN="'.length, -1)).not.toContain('"');
  expect(shippedEnv('claude-code', { vendor: 'deepseek' })).toEqual([]);
  expect(shippedEnv('grok-build', { vendor: 'deepseek', account })).toEqual([]);
});

describe('the key word is the machine store\'s own lookup', () => {
  // The Keychain reads the owner's entry; an entity's own file holds the key under its generic name.
  const account = { name: 'deepseek', provider: 'deepseek', endpoint: 'https://api.deepseek.com/anthropic', keychain: 'deepseek-api-key', secret: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-flash' };
  const tokenOf = (words: string[]) => words.find((word) => word.startsWith('ANTHROPIC_AUTH_TOKEN='));
  const DARWIN_WORD = 'ANTHROPIC_AUTH_TOKEN="$(/usr/bin/security find-generic-password -s deepseek-api-key -w)"';

  test('on the Keychain the word is byte for byte the one it has always been', () => {
    expect(tokenOf(shippedEnv('claude-code', { vendor: 'deepseek', account }))).toBe(DARWIN_WORD);
    const key = accountKeyCommand(account, systemSecretStore({ platform: 'darwin' }));
    expect(key.ok).toBe(true);
    if (key.ok) expect(tokenOf(shippedEnv('claude-code', { vendor: 'deepseek', account, keyCommand: key.command }))).toBe(DARWIN_WORD);
  });

  test('on the encrypted dotenv store the word runs that store\'s lookup, one double-quoted word with nothing nested', () => {
    const home = '/home/owner';
    const store = systemSecretStore({ platform: 'linux', home, entity: 'acme', env: { HOME: home, PATH: '/usr/bin' }, isFile: () => true, isExecutable: (path) => path === '/usr/bin/sops' });
    const key = accountKeyCommand({ ...account, keychain: 'acme-deepseek-key' }, store);
    expect(key.ok).toBe(true);
    if (!key.ok) return;
    const word = tokenOf(shippedEnv('claude-code', { vendor: 'deepseek', account, keyCommand: key.command }));
    expect(word).toBe(
      'ANTHROPIC_AUTH_TOKEN="$(SOPS_AGE_KEY_FILE=/home/owner/.config/sops/age/keys.txt /usr/bin/sops decrypt --input-type dotenv ' +
      '--output-type dotenv /home/owner/.config/sops/acme.env.sops | sed -n s/\\^DEEPSEEK_API_KEY=//p)"',
    );
    expect(word).not.toContain('/usr/bin/security');
    expect(word?.slice('ANTHROPIC_AUTH_TOKEN="'.length, -1)).not.toMatch(/["']/);
  });

  test('a machine whose store has none for the entry gives the reason, never a word', () => {
    expect(accountKeyCommand(account, null)).toEqual({ ok: false, reason: NO_SECRET_STORE });
    const unset = systemSecretStore({ platform: 'linux', home: '/home/owner', entity: 'acme', env: { HOME: '/home/owner' }, isFile: () => false, isExecutable: () => false });
    expect(accountKeyCommand(account, unset)).toEqual({ ok: false, reason: 'the system\'s secret store is not set up on this machine' });
    const paid = { ...account, keychain: 'anthropic-api-key', secret: 'ANTHROPIC_API_KEY' };
    const set = systemSecretStore({ platform: 'linux', home: '/home/owner', entity: 'acme', env: { HOME: '/home/owner' }, isFile: () => true, isExecutable: () => true });
    expect(accountKeyCommand(paid, set).ok).toBe(false);
    // A store that keeps one file per entity opens none without one.
    const noEntity = systemSecretStore({ platform: 'linux', home: '/home/owner', env: { HOME: '/home/owner' }, isFile: () => true, isExecutable: () => true });
    expect(accountKeyCommand(account, noEntity)).toEqual({ ok: false, reason: 'the system\'s secret store keeps one file per entity, and no entity applies here' });
  });
});

describe('the Codex and Antigravity launchers', () => {
  test('a Codex builder runs its model and effort with no approval and full access', () => {
    const line = shippedLauncher('codex', { role: 'builder', model: 'GPT Sol', version: '6.1', effort: 'high' })!.argv;
    expect(line).toEqual(['codex', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high', '-a', 'never', '-s', 'danger-full-access']);
  });

  test('a Codex reader runs the builder line (its sandbox stops team), and a plain GPT model has no family word', () => {
    const line = shippedLauncher('codex', { role: 'reviewer', model: 'GPT', version: '6' })!.argv;
    expect(line).toEqual(['codex', '-m', 'gpt-6', '-a', 'never', '-s', 'danger-full-access']);
  });

  test('an Antigravity seat names its Gemini model with its effort, high by default; a reader runs the same line', () => {
    expect(shippedLauncher('antigravity', { role: 'builder', model: 'Gemini Argon', version: '4' })!.argv)
      .toEqual(['agy', '--model', 'gemini-4-argon-high']);
    expect(shippedLauncher('antigravity', { role: 'reviewer', model: 'Gemini Flash', version: '3.8', effort: 'medium' })!.argv)
      .toEqual(['agy', '--model', 'gemini-3.8-flash-medium']);
  });

  test('both are shipped names', () => {
    expect(shippedLauncherNames()).toEqual(['antigravity', 'claude-code', 'codex', 'grok-build']);
  });
});

describe('a provider seat\'s launch plan takes its key word from the machine\'s store', () => {
  const made: string[] = [];
  afterEach(() => discardFixtures(made.splice(0)));

  const TEAM = `format: 1
project: acme
entity: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: deepseek
    model: DeepSeek Flash
    version: "4.0"
    launch: claude
    launcher: claude-code
`;

  function planWith(store: SecretStore | null): string {
    const home = mkdtempSync(join(tmpdir(), 'shipped-key-plan-'));
    made.push(home);
    const entity = join(home, '.config', 'team', 'entities', 'acme');
    mkdirSync(entity, { recursive: true });
    writeFileSync(join(entity, 'accounts.yaml'), [
      'accounts:',
      '  deepseek:',
      '    provider: deepseek',
      '    endpoint: https://api.deepseek.com/anthropic',
      '    keychain: deepseek-api-key',
      '    default_model: deepseek-flash',
      '',
    ].join('\n'), { mode: 0o600 });
    const checked = validateTeamFile(TEAM);
    if (!checked.ok) throw new Error(`refused: ${JSON.stringify(checked.errors)}`);
    const seat: UpSeat = {
      name: 'lead', cli: 'claude-code', launch: 'claude', launcher: 'claude-code', vendor: 'deepseek', role: 'coordinator',
      model: 'DeepSeek Flash', version: '4.0', cwd: '.', label: 'lead · coordinator', displayAgent: 'DeepSeek Flash 4.0 default',
      repairLine: '`team down` then `team up` (to restart the whole team)', stopped: false, rules: '',
    };
    return formatPlan(upPlan({
      root: '/work/acme', session: 'acme', sessionRunning: true, seats: [seat], watchAlive: true, watchLabel: 'Watch · acme',
      home, team: checked.team, secretStore: store,
    }));
  }

  /** A store whose lookup answers `answer` for every name, and reads nothing. */
  function storeAnswering(answer: SecretLookup): SecretStore {
    return { read: async () => ({ ok: false, reason: 'not read in a plan' }), lookupCommand: () => answer };
  }

  test('the line the pane runs carries the store\'s own lookup', () => {
    const plan = planWith(storeAnswering({ ok: true, command: 'fixture-store print deepseek-api-key' }));
    expect(plan).toContain('ANTHROPIC_AUTH_TOKEN="$(fixture-store print deepseek-api-key)"');
    expect(plan).not.toContain('/usr/bin/security');
  });

  test('a store with no lookup for the entry refuses the seat before any workspace is made', () => {
    const plan = planWith(storeAnswering({ ok: false, reason: 'the system\'s secret store is not set up on this machine' }));
    expect(plan).toContain('lead: would refuse: its provider key cannot be read: the system\'s secret store is not set up on this machine');
    expect(plan).not.toContain('ANTHROPIC_AUTH_TOKEN');
    expect(plan).not.toContain('workspace create');
    expect(planWith(null)).toContain(`lead: would refuse: its provider key cannot be read: ${NO_SECRET_STORE}`);
  });
});

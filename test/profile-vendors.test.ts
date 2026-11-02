// The vendor table a CLI profile carries is how a seat moves between providers of the same CLI
// with no launcher script: the env words the CLI reads, the credential item the machine must
// hold, and the model ids the vendor offers. The credential lookup belongs to the adapter, and
// every scene here injects it: no test queries the machine's credential store, not even for
// presence.
import { describe, expect, test } from 'bun:test';
import { addCommandFor, checkArgv, credentialProbeFor, type CredentialProbe } from '../src/profiles/credentials.ts';
import { profileFor } from '../src/profiles/profile.ts';
import { shellWordTexts } from '../src/launch/shell-words.ts';
import { planVendorSwap, vendorTargetOf } from '../src/swap/vendor.ts';

const profile = profileFor('claude-code')!;

const AUTH = (item: string): string =>
  `ANTHROPIC_AUTH_TOKEN=$(/usr/bin/security find-generic-password -s ${item} -a "$USER" -w)`;

const DEEPSEEK_LAUNCH =
  'ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic ' +
  `${AUTH('deepseek-api-key')} ` +
  'ANTHROPIC_MODEL=deepseek-flash claude --model deepseek-flash';
const ZAI_LAUNCH =
  'ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic ' +
  `${AUTH('glm-api-key')} ` +
  'ANTHROPIC_MODEL=glm-5.3 claude --model glm-5.3';
const MOONSHOT_LAUNCH =
  'ANTHROPIC_BASE_URL=https://api.kimi.ai/coding/ ' +
  `${AUTH('kimi-api-key')} ` +
  'ANTHROPIC_MODEL=kimi-k2.5 claude --model kimi-k2.5';

function seat(launch: string, over: { vendor?: string; account?: string } = {}) {
  return {
    name: 'lead',
    cli: 'claude-code',
    vendor: over.vendor ?? 'anthropic',
    launch,
    ...(over.account === undefined ? {} : { account: over.account }),
  };
}

const present: CredentialProbe = () => 'present';

describe('the vendors a profile declares', () => {
  test('three vendors name their env words, their credential item and their models', () => {
    expect(profile.vendors.map((vendor) => vendor.name)).toEqual(['deepseek', 'zai', 'moonshot']);
    const [deepseek, zai, moonshot] = profile.vendors;
    expect(deepseek).toEqual({
      name: 'deepseek',
      credential: 'deepseek-api-key',
      env: [
        'ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic',
        'ANTHROPIC_AUTH_TOKEN=$(/usr/bin/security find-generic-password -s {credential} -a "$USER" -w)',
        'ANTHROPIC_MODEL={model}',
      ],
      models: [{ id: 'deepseek-flash', model: 'DeepSeek Flash', version: '4.0', display: 'DeepSeek Flash 4.0' }],
    });
    expect(zai).toEqual({
      name: 'zai',
      credential: 'glm-api-key',
      env: [
        'ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic',
        'ANTHROPIC_AUTH_TOKEN=$(/usr/bin/security find-generic-password -s {credential} -a "$USER" -w)',
        'ANTHROPIC_MODEL={model}',
      ],
      models: [{ id: 'glm-5.3', model: 'GLM', version: '5.3', display: 'GLM 5.3' }],
    });
    expect(moonshot).toEqual({
      name: 'moonshot',
      credential: 'kimi-api-key',
      env: [
        'ANTHROPIC_BASE_URL=https://api.kimi.ai/coding/',
        'ANTHROPIC_AUTH_TOKEN=$(/usr/bin/security find-generic-password -s {credential} -a "$USER" -w)',
        'ANTHROPIC_MODEL={model}',
      ],
      models: [{ id: 'kimi-k2.5', model: 'Kimi K2.5', version: '2.5', display: 'Kimi K2.5' }],
    });
    // The other profiles carry no vendor table: the store naming stays in the adapter that has
    // one.
    for (const cli of ['codex', 'grok', 'gemini', 'cursor', 'muse', 'antigravity']) {
      expect(profileFor(cli)?.vendors ?? [], cli).toEqual([]);
    }
  });

  test('each env word is one assignment word once its placeholders fill', () => {
    for (const vendor of profile.vendors) {
      for (const word of vendor.env) {
        const filled = word.replaceAll('{model}', 'an-id').replaceAll('{credential}', 'an-item');
        expect(shellWordTexts(filled)).toEqual([filled]);
        expect(filled).toMatch(/^[A-Za-z_][A-Za-z0-9_]*=/);
      }
      expect(vendor.env.filter((word) => word.includes('{model}'))).toHaveLength(1);
      expect(vendor.env.filter((word) => word.includes('{credential}'))).toHaveLength(1);
    }
  });

  test('the credential check is attribute-only and the add command prompts for the secret', () => {
    const credentials = profile.credentials!;
    expect(credentials.missingStatus).toBe(44);
    expect(checkArgv(credentials, 'glm-api-key', 'tester')).toEqual([
      '/usr/bin/security',
      'find-generic-password',
      '-s',
      'glm-api-key',
      '-a',
      'tester',
    ]);
    for (const word of credentials.check) expect(['-w', '--wait', '-g']).not.toContain(word);
    const add = addCommandFor(credentials, 'glm-api-key');
    expect(add).toBe('/usr/bin/security add-generic-password -s glm-api-key -a "$USER" -w');
    // A one-time command: no redirect and no substitution, so nothing it prints is a secret and
    // nothing it reads comes from stdin.
    expect(add).not.toMatch(/[<`]|\$\(/);
  });

  test("the probe reads the store's answer and never asks for the secret", () => {
    const credentials = profile.credentials!;
    const asked: { file: string; args: readonly string[] }[] = [];
    const probe = credentialProbeFor(credentials, 'tester', (file, args) => {
      asked.push({ file, args });
      return { status: 0 };
    });
    expect(probe('glm-api-key')).toBe('present');
    expect(asked).toEqual([
      { file: '/usr/bin/security', args: ['find-generic-password', '-s', 'glm-api-key', '-a', 'tester'] },
    ]);
    expect(asked[0]!.args).not.toContain('-w');
    const answer = (status: number | null, error?: unknown): CredentialProbe =>
      credentialProbeFor(credentials, 'tester', () => (error === undefined ? { status } : { status, error }));
    expect(answer(44)('glm-api-key')).toBe('absent');
    expect(answer(0)('glm-api-key')).toBe('present');
    expect(answer(36)('glm-api-key')).toBe('unavailable');
    expect(answer(null)('glm-api-key')).toBe('unavailable');
    expect(answer(0, new Error('spawn failed'))('glm-api-key')).toBe('unavailable');
  });
});

describe('a vendor target', () => {
  test("a name in the profile's own table is a vendor target, whatever its case", () => {
    expect(vendorTargetOf(profile, 'ZAI')?.name).toBe('zai');
    expect(vendorTargetOf(profile, 'openai')).toBeNull();
    expect(vendorTargetOf(null, 'zai')).toBeNull();
  });

  // A vendor env word is exactly one shell word. An unquoted space makes two: the rewrite joins
  // the words with single spaces, so the second one would land where the CLI's program is read.
  test('a vendor word that would split into two words is refused, never joined into the line', () => {
    const split = {
      ...profile,
      vendors: profile.vendors.map((vendor) =>
        vendor.name === 'deepseek' ? { ...vendor, env: ['SYNTHETIC_VAR=one extra'] } : vendor,
      ),
    };
    const plan = planVendorSwap(split, seat(DEEPSEEK_LAUNCH), 'deepseek', 'deepseek-flash', present);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.why).toContain('one assignment word');
  });

  test('the plan is a recipe for the same CLI, with no donor model and no modelFrom', () => {
    const plan = planVendorSwap(profile, seat('claude --model claude-opus-5-5'), 'zai', 'glm-5.3', present);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.why);
    expect(plan.recipe).toEqual({
      cli: 'claude-code',
      vendor: 'zai',
      model: 'GLM',
      version: '5.3',
      display: 'GLM 5.3',
      launch: ZAI_LAUNCH,
    });
    expect('modelFrom' in plan.recipe).toBe(false);
  });

  test('the wrapper prefix is kept and the vendor words go in front of the shell it reads', () => {
    const plan = planVendorSwap(
      profile,
      seat('zsh ~/tools/as-floor.sh claude --model claude-opus-5-5'),
      'deepseek',
      'deepseek-flash',
      present,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.why);
    // `exec "$@"` reads its arguments as the command: an assignment word after `zsh` would be a
    // program name, so every assignment precedes the shell and reaches it as its environment.
    expect(plan.recipe.launch).toBe(DEEPSEEK_LAUNCH.replace('claude --model', 'zsh ~/tools/as-floor.sh claude --model'));
  });

  test("a leading assignment that is not a vendor's is kept in front of the vendor words", () => {
    const plan = planVendorSwap(profile, seat('AGENT_UNATTENDED=1 claude --model claude-opus-5-5'), 'zai', 'glm-5.3', present);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.why);
    expect(plan.recipe.launch).toBe(`AGENT_UNATTENDED=1 ${ZAI_LAUNCH}`);
  });

  test("switching away from a vendor drops every word of the previous vendor's", () => {
    const plan = planVendorSwap(profile, seat(DEEPSEEK_LAUNCH, { vendor: 'deepseek' }), 'moonshot', 'kimi-k2.5', present);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.why);
    expect(plan.recipe.launch).toBe(MOONSHOT_LAUNCH);
    expect(plan.recipe.launch).not.toContain('deepseek');
  });

  test('a launch line whose prefix cannot be proven is refused, never guessed', () => {
    for (const launch of [
      "sh -c 'claude --model claude-opus-5-5'",
      'env ANTHROPIC_BASE_URL=https://example.invalid claude --model claude-opus-5-5',
      'sudo claude --model claude-opus-5-5',
      'zsh ~/tools/team-deepseek claude --model claude-opus-5-5',
      'claude --model "claude-opus-5-5',
    ]) {
      const plan = planVendorSwap(profile, seat(launch), 'zai', 'glm-5.3', present);
      expect(plan.ok, launch).toBe(false);
      if (plan.ok) continue;
      expect(plan.why).toContain('refused rather than guessing');
    }
  });

  test('a missing credential is refused, naming the item and the one-time add command', () => {
    const asked: string[] = [];
    const plan = planVendorSwap(profile, seat('claude --model claude-opus-5-5'), 'zai', 'glm-5.3', (item) => {
      asked.push(item);
      return 'absent';
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(asked).toEqual(['glm-api-key']);
    expect(plan.why).toContain('"glm-api-key"');
    expect(plan.why).toContain('/usr/bin/security add-generic-password -s glm-api-key -a "$USER" -w');
    expect(plan.repair).toBe('/usr/bin/security add-generic-password -s glm-api-key -a "$USER" -w');
  });

  test('an unreadable credential store is refused, never read as present or absent', () => {
    const plan = planVendorSwap(profile, seat('claude --model claude-opus-5-5'), 'moonshot', 'kimi-k2.5', () => 'unavailable');
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.why).toContain('"kimi-api-key"');
    expect(plan.why).toContain('refused rather than guessing');
    expect(plan.repair).toBeNull();
  });

  test('an unknown model is refused before the credential is looked at', () => {
    const asked: string[] = [];
    const plan = planVendorSwap(profile, seat('claude --model x'), 'zai', 'glm-4', (item) => {
      asked.push(item);
      return 'present';
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.why).toContain('offers no model "glm-4"');
    expect(plan.why).toContain('glm-5.3');
    expect(asked).toEqual([]);
  });

  test("an account is carried only when it names the vendor's own", () => {
    const same = planVendorSwap(profile, seat('claude --model x', { account: 'zai' }), 'zai', 'glm-5.3', present);
    expect(same.ok).toBe(true);
    if (!same.ok) throw new Error(same.why);
    expect(same.recipe.account).toBe('zai');
    const other = planVendorSwap(profile, seat('claude --model x', { account: 'anthropic' }), 'zai', 'glm-5.3', present);
    expect(other.ok).toBe(true);
    if (!other.ok) throw new Error(other.why);
    expect(other.recipe.account).toBeUndefined();
  });
});

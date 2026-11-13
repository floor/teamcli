// A provider key on a seat's own launch line is the word `NAME={secret:<entry>}`, filled at launch
// with the machine's secret store's own lookup. Every store here is a fake or an adapter whose
// lookup reads nothing: no scene runs a store command or reads the machine's store.
import { describe, expect, test } from 'bun:test';
import { formatPlan, upPlan, type UpSeat } from '../src/launch/plan.ts';
import { fillSecretWords, hasSecretWord, secretWord } from '../src/launch/secret-words.ts';
import { profileFor } from '../src/profiles/profile.ts';
import { NO_SECRET_STORE, systemSecretStore, type SecretLookup, type SecretStore } from '../src/secrets/store.ts';

/** A store whose lookup answers `answer` for every name, and reads nothing. */
function storeAnswering(answer: (name: string) => SecretLookup): SecretStore {
  return { read: async () => ({ ok: false, reason: 'not read in a plan' }), lookupCommand: answer };
}

const KEYCHAIN = systemSecretStore({ platform: 'darwin', runner: async () => { throw new Error('no store command runs'); } });
const HOME = '/home/owner';
const DOTENV = systemSecretStore({
  platform: 'linux', home: HOME, entity: 'acme', env: { HOME, PATH: '/usr/bin' },
  isFile: () => true, isExecutable: (path) => path === '/usr/bin/sops',
});

// The line `team swap` wrote before the store was neutral: its own lookup, unquoted, with the
// account named. It must launch exactly as it did.
const LEGACY =
  'ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic ' +
  'ANTHROPIC_AUTH_TOKEN=$(/usr/bin/security find-generic-password -s deepseek-api-key -a "$USER" -w) ' +
  'ANTHROPIC_MODEL=deepseek-flash claude --model deepseek-flash';

const NAMED =
  'ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic ' +
  'ANTHROPIC_AUTH_TOKEN={secret:deepseek-api-key} ' +
  'ANTHROPIC_MODEL=deepseek-flash claude --model deepseek-flash';

describe('the profile names the key and no store command', () => {
  test('each vendor of the claude-code profile carries the secret word for its own item', () => {
    const vendors = profileFor('claude-code')!.vendors;
    expect(vendors.length).toBeGreaterThan(0);
    for (const vendor of vendors) {
      expect(vendor.env).toContain(secretWord('ANTHROPIC_AUTH_TOKEN', '{credential}'));
      expect(vendor.env.join(' ')).not.toContain('/usr/bin/security');
    }
  });
});

describe('filling the secret words of a launch line', () => {
  test('a line an earlier swap wrote, with its own lookup, is returned byte for byte', () => {
    expect(hasSecretWord(LEGACY)).toBe(false);
    for (const store of [KEYCHAIN, DOTENV, null]) {
      expect(fillSecretWords(LEGACY, store)).toEqual({ ok: true, line: LEGACY, entries: [] });
    }
  });

  test('on the Keychain the word is the shipped launcher\'s own key word, pinned whole', () => {
    expect(fillSecretWords(NAMED, KEYCHAIN)).toEqual({
      ok: true,
      line:
        'ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic ' +
        'ANTHROPIC_AUTH_TOKEN="$(/usr/bin/security find-generic-password -s deepseek-api-key -w)" ' +
        'ANTHROPIC_MODEL=deepseek-flash claude --model deepseek-flash',
      entries: ['deepseek-api-key'],
    });
  });

  test('on the encrypted dotenv store the word is that store\'s lookup, one double-quoted word', () => {
    const filled = fillSecretWords(NAMED, DOTENV);
    expect(filled.ok).toBe(true);
    if (!filled.ok) return;
    expect(filled.line).toContain(
      'ANTHROPIC_AUTH_TOKEN="$(SOPS_AGE_KEY_FILE=/home/owner/.config/sops/age/keys.txt /usr/bin/sops decrypt --input-type dotenv ' +
      '--output-type dotenv /home/owner/.config/sops/acme.env.sops | sed -n s/\\^DEEPSEEK_API_KEY=//p)" ',
    );
    expect(filled.line).not.toContain('/usr/bin/security');
    expect(filled.line.endsWith(' claude --model deepseek-flash')).toBe(true);
  });

  test('every leading secret word is filled, in order, and the rest of the line is left as written', () => {
    const line = "A={secret:one} B=plain C={secret:two.key} claude --append-system-prompt 'keep {braces}'";
    const filled = fillSecretWords(line, storeAnswering((name) => ({ ok: true, command: `lookup ${name}` })));
    expect(filled).toEqual({
      ok: true,
      line: "A=\"$(lookup one)\" B=plain C=\"$(lookup two.key)\" claude --append-system-prompt 'keep {braces}'",
      entries: ['one', 'two.key'],
    });
  });

  test('no store, or a store with no lookup for the entry, refuses with the store\'s reason', () => {
    expect(fillSecretWords(NAMED, null)).toEqual({ ok: false, why: NO_SECRET_STORE });
    const unset = storeAnswering(() => ({ ok: false, reason: 'the system\'s secret store is not set up on this machine' }));
    expect(fillSecretWords(NAMED, unset)).toEqual({ ok: false, why: 'the system\'s secret store is not set up on this machine' });
  });

  test('a secret word anywhere but a leading variable\'s whole value refuses: a key never becomes an argument', () => {
    const store = storeAnswering(() => ({ ok: true, command: 'lookup' }));
    for (const line of [
      'claude --model m KEY={secret:item}',
      'env KEY={secret:item} claude',
      'claude --note {secret:item}',
      "KEY='{secret:item}' claude",
      'KEY={secret:item}x claude',
      'KEY=x{secret:item} claude',
    ]) {
      const filled = fillSecretWords(line, store);
      expect(filled.ok, line).toBe(false);
    }
  });
});

describe('the launch plan fills the word from the machine\'s store', () => {
  function seat(launch: string): UpSeat {
    return {
      name: 'lead', cli: 'claude-code', launch, vendor: 'deepseek', role: 'coordinator',
      model: 'DeepSeek Flash', version: '4.0', cwd: '.', label: 'lead · coordinator', displayAgent: 'DeepSeek Flash 4.0',
      repairLine: '`team down` then `team up` (to restart the whole team)', stopped: false, rules: '',
    };
  }
  const plan = (launch: string, store: SecretStore | null): string => formatPlan(upPlan({
    root: '/work/acme', session: 'acme', sessionRunning: true, seats: [seat(launch)], watchAlive: true,
    watchLabel: 'Watch · acme', secretStore: store,
  }));

  test('a line an earlier swap wrote launches with its own words, unchanged', () => {
    const text = plan(LEGACY, storeAnswering(() => { throw new Error('a line with no secret word asks no store'); }));
    expect(text).toContain('ANTHROPIC_AUTH_TOKEN=$(/usr/bin/security find-generic-password -s deepseek-api-key -a "$USER" -w)');
    expect(text).not.toContain('would refuse');
  });

  test('a named key launches with the store\'s lookup, and the Keychain\'s is the shipped word', () => {
    const text = plan(NAMED, KEYCHAIN);
    expect(text).toContain('ANTHROPIC_AUTH_TOKEN="$(/usr/bin/security find-generic-password -s deepseek-api-key -w)"');
    expect(text).not.toContain('{secret:');
  });

  test('a store with no lookup for the entry refuses the seat before any workspace is made', () => {
    const text = plan(NAMED, storeAnswering(() => ({ ok: false, reason: 'the system\'s secret store is not set up on this machine' })));
    expect(text).toContain('lead: would refuse: its provider key cannot be read: the system\'s secret store is not set up on this machine');
    expect(text).not.toContain('workspace create');
    expect(plan(NAMED, null)).toContain(`lead: would refuse: its provider key cannot be read: ${NO_SECRET_STORE}`);
  });
});

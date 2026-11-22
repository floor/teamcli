// The local secret-store adapter for the system's Keychain. Every platform-specific word and
// command of that store lives here; the neutral interface in store.ts prints none of them. The
// lookup is the one it has always been — `find-generic-password` by service name, `-w` for the
// password alone on standard output — and its reasons are unchanged, so `team git`, `team gh`,
// `team release check` and `team broker` read exactly what they read before the store was
// neutral. The service name is the only argument the system tool ever sees; the key is taken from
// its standard output, is never echoed, and is never an argument, an environment variable or
// input to any process.
import { spawnSync } from 'node:child_process';
import { hostedCommit } from '../host/request-scope.ts';
import { realSecretRun, SECRET_NAME, type SecretRunner } from './run.ts';
import { systemProbeAllowed, type SecretLookup, type SecretName, type SecretRead, type SecretStore, type SecretStoreOptions } from './store.ts';

export type KeyResult = { ok: true; key: string } | { ok: false; reason: string };

/** The Keychain lookup by service name alone, so a test can stand in for it without running it. */
export type SecurityRun = (service: string) => Promise<{ ok: true; stdout: string } | { ok: false }>;

/** The lookup's deadline: at expiry the lookup is terminated and reads unknown. */
export const KEYCHAIN_TIMEOUT_MS = 5000;

/** A bound on what the lookup may print before it is cut off: a key is a short ASCII string. */
const STDOUT_CAP = 4096;

/** The system tool and its words, as one argv. */
const SECURITY = '/usr/bin/security';
function lookupArgs(service: string): string[] {
  return ['find-generic-password', '-s', service, '-w'];
}

/** The production wiring of the one lookup, with its deadline. Never run by a test. */
export const realSecurityRun: SecurityRun = (service) => securityRunWith(realSecretRun)(service);

function securityRunWith(run: SecretRunner): SecurityRun {
  return (service) => run(SECURITY, lookupArgs(service), { cap: STDOUT_CAP, timeoutMs: KEYCHAIN_TIMEOUT_MS });
}

/**
 * The key as the contract reads it: exactly one trailing line feed removed, then one or more
 * ASCII bytes 0x21 through 0x7e. Empty or any other output is a failure before any request is
 * formed. The output is never echoed into the failure.
 */
export function keyOf(stdout: string): KeyResult {
  const key = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  if (key.length === 0) return { ok: false, reason: 'the lookup printed nothing' };
  for (let index = 0; index < key.length; index++) {
    const code = key.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return { ok: false, reason: 'the lookup printed an illegal key' };
  }
  return { ok: true, key };
}

/** The lookup a launch line runs for one item: the same words `read` runs, as the pane's shell
 *  reads them. The name is a plain word (`SECRET_NAME`), so nothing in it needs quoting. */
export function keychainLookupCommand(service: string): string {
  return `${SECURITY} ${lookupArgs(service).join(' ')}`;
}

/** The name this store keeps an entry under: the owner's own Keychain entry. An entry's generic
 *  name and its prefix belong to the stores that keep one file per entity; the Keychain reads its
 *  own entry exactly as it always has, whatever it holds. */
function serviceOf(name: SecretName): string {
  return typeof name === 'string' ? name : name.keychain;
}

/** The system tool's exit status when it holds no item by that name. */
const NOT_FOUND = 44;

/** The presence probe: the same lookup without `-w`, so the tool prints the item's attributes and
 *  never its password, and every stream is discarded; only the exit status is read. */
function realProbe(command: string, args: string[]): number | null {
  hostedCommit('node:child_process.spawnSync');
  const result = spawnSync(command, args, { stdio: 'ignore', timeout: KEYCHAIN_TIMEOUT_MS });
  return result.error ? null : result.status;
}

export function darwinSecretStore(options: SecretStoreOptions = {}): SecretStore {
  const lookup = securityRunWith(options.runner ?? realSecretRun);
  const probe = options.probe ?? (systemProbeAllowed(options.env ?? process.env) ? realProbe : null);
  return {
    holds(asked: SecretName): boolean | null {
      const name = serviceOf(asked);
      if (!SECRET_NAME.test(name) || probe === null) return null;
      const status = probe(SECURITY, ['find-generic-password', '-s', name]);
      return status === 0 ? true : status === NOT_FOUND ? false : null;
    },
    async read(asked: SecretName): Promise<SecretRead> {
      const name = serviceOf(asked);
      const out = await lookup(name);
      if (!out.ok) return { ok: false, reason: 'the lookup failed' };
      const key = keyOf(out.stdout);
      return key.ok ? { ok: true, value: key.key } : key;
    },
    lookupCommand(asked: SecretName): SecretLookup {
      const name = serviceOf(asked);
      if (!SECRET_NAME.test(name)) return { ok: false, reason: 'the entry name is not a plain word' };
      return { ok: true, command: keychainLookupCommand(name) };
    },
  };
}

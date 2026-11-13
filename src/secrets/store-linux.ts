// The local secret-store adapter for a machine whose secrets are kept in one encrypted dotenv
// file: sops, with the machine's age key. Every platform-specific word, file and command of that
// store lives here; the neutral interface in store.ts prints none of them, and no reason this
// adapter gives names the tool, the file or the key.
//
// The file is `~/.config/sops/agents.env.sops` (or the absolute path `TEAMCLI_SECRETS_FILE`
// names), its entries env-style names: a store name is read under its env form, upper-cased
// with `-` made `_`, so `deepseek-api-key` is `DEEPSEEK_API_KEY`. Two env forms are refused
// before anything runs, `ANTHROPIC_API_KEY` and `GEMINI_API_KEY`: seats run on subscriptions,
// never on a pay-per-use key, so no seat line and no command may be handed one.
//
// A read decrypts the file to standard output and keeps the one entry, in memory: the plaintext
// is never written to disk, never logged and never an argument of any process. sops reads the
// age key from `SOPS_AGE_KEY_FILE`, which is set to `~/.config/sops/age/keys.txt` when the
// environment leaves it unset (sops looks elsewhere by default on some systems). sops itself is
// looked for on PATH, then in the places a user install puts it, because a service manager starts
// a process with a PATH that often holds none of them.
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { realSecretRun, SECRET_NAME } from './run.ts';
import type { SecretLookup, SecretRead, SecretStore, SecretStoreOptions } from './store.ts';

/** The decrypt's deadline: at expiry it is terminated and the read fails. */
export const STORE_TIMEOUT_MS = 10_000;

/** A bound on the decrypted file: it holds a handful of short keys, never more than this. */
const STDOUT_CAP = 65_536;

/** The env forms no store read hands out (see the header). */
const PAY_PER_USE: ReadonlySet<string> = new Set(['ANTHROPIC_API_KEY', 'GEMINI_API_KEY']);

/** The places looked in after PATH, in order: a user install, then the system-wide ones. */
const TOOL_PLACES = (home: string): string[] => [join(home, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'];

/** A path a launch line may carry unquoted: absolute, and no character a shell reads. */
const LINE_PATH = /^\/[A-Za-z0-9._\/+-]+$/;

const DECRYPT = ['decrypt', '--input-type', 'dotenv', '--output-type', 'dotenv'];

const NOT_SET_UP = 'the system\'s secret store is not set up on this machine';
const NO_TOOL = 'the system\'s secret store cannot be opened: its tool is not installed';
const NO_KEY = 'the system\'s secret store cannot be opened: its key is not on this machine';
const NOT_OPENED = 'the system\'s secret store could not be opened';

type Found<T> = { ok: true } & T | { ok: false; reason: string };

/** A store name's env form, or why the store refuses it. */
export function envNameOf(name: string): Found<{ env: string }> {
  if (!SECRET_NAME.test(name)) return { ok: false, reason: 'the entry name is not a plain word' };
  const env = name.toUpperCase().replaceAll('-', '_');
  if (!/^[A-Z_][A-Z0-9_]*$/.test(env)) return { ok: false, reason: 'the entry name is not one the system\'s secret store can hold' };
  if (PAY_PER_USE.has(env)) return { ok: false, reason: `${env} is a pay-per-use key, and seats run on subscriptions only` };
  return { ok: true, env };
}

/** The one entry `env` names in decrypted dotenv text, or why there is none. The text is never
 *  part of a reason. */
export function entryOf(text: string, env: string): Found<{ value: string }> {
  const prefix = `${env}=`;
  const lines = text.split('\n').filter((line) => line.startsWith(prefix));
  if (lines.length === 0) return { ok: false, reason: 'the system\'s secret store holds no entry for it' };
  if (lines.length > 1) return { ok: false, reason: 'the system\'s secret store holds that entry more than once' };
  const value = lines[0]!.slice(prefix.length);
  if (value.length === 0) return { ok: false, reason: 'its entry in the system\'s secret store is empty' };
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return { ok: false, reason: 'its entry in the system\'s secret store holds a character no key holds' };
  }
  return { ok: true, value };
}

function realIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function realIsExecutable(path: string): boolean {
  if (!realIsFile(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function linuxSecretStore(options: SecretStoreOptions = {}): SecretStore {
  const env = options.env ?? process.env;
  // Only an absolute home places the default locations; an empty or relative one would read them
  // from the current folder, so the account's own home stands in.
  const home = [options.home, env.HOME].find((one) => one !== undefined && isAbsolute(one)) ?? homedir();
  const isFile = options.isFile ?? realIsFile;
  const isExecutable = options.isExecutable ?? realIsExecutable;
  const run = options.runner ?? realSecretRun;

  /** The encrypted file: the override when it is set, else the default under the home. */
  const storeFile = (): Found<{ path: string }> => {
    const named = env.TEAMCLI_SECRETS_FILE;
    if (named !== undefined && named !== '') {
      if (!isAbsolute(named)) return { ok: false, reason: 'TEAMCLI_SECRETS_FILE must name an absolute path' };
      return isFile(named) ? { ok: true, path: named } : { ok: false, reason: NOT_SET_UP };
    }
    const path = join(home, '.config', 'sops', 'agents.env.sops');
    return isFile(path) ? { ok: true, path } : { ok: false, reason: NOT_SET_UP };
  };

  /** The tool: the first executable on PATH (absolute entries only), then the install places. */
  const tool = (): Found<{ path: string }> => {
    const onPath = (env.PATH ?? '').split(':').filter((dir) => dir !== '' && isAbsolute(dir));
    for (const dir of [...onPath, ...TOOL_PLACES(home)]) {
      const path = join(dir, 'sops');
      if (isExecutable(path)) return { ok: true, path };
    }
    return { ok: false, reason: NO_TOOL };
  };

  /** The age key file sops is pointed at: the environment's when it names one, else the default. */
  const keyFile = (): string => {
    const named = env.SOPS_AGE_KEY_FILE;
    return named !== undefined && named !== '' ? named : join(home, '.config', 'sops', 'age', 'keys.txt');
  };

  return {
    async read(name: string): Promise<SecretRead> {
      const entry = envNameOf(name);
      if (!entry.ok) return entry;
      const file = storeFile();
      if (!file.ok) return file;
      const sops = tool();
      if (!sops.ok) return sops;
      const childEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(env)) if (value !== undefined) childEnv[key] = value;
      childEnv.SOPS_AGE_KEY_FILE = keyFile();
      const out = await run(sops.path, [...DECRYPT, file.path], { env: childEnv, cap: STDOUT_CAP, timeoutMs: STORE_TIMEOUT_MS });
      if (!out.ok) return { ok: false, reason: NOT_OPENED };
      const found = entryOf(out.stdout, entry.env);
      return found.ok ? { ok: true, value: found.value } : found;
    },
    lookupCommand(name: string): SecretLookup {
      const entry = envNameOf(name);
      if (!entry.ok) return entry;
      const file = storeFile();
      if (!file.ok) return file;
      const sops = tool();
      if (!sops.ok) return sops;
      // A pane starts with only the herdr server's few variables, so every location is written
      // into the command as it is found now, and the key file is named even when sops would find
      // it alone. The words carry no quote: each path is checked to need none, and the one
      // pattern character is escaped, so no shell's globbing reads the sed program (`^` is a
      // glob operator under zsh's extended_glob). The env form is `[A-Z0-9_]` only, so it is
      // literal in the sed program too.
      const key = keyFile();
      if (!isFile(key)) return { ok: false, reason: NO_KEY };
      if (![file.path, sops.path, key].every((path) => LINE_PATH.test(path))) {
        return { ok: false, reason: 'the system\'s secret store is at a path a launch line cannot carry unquoted' };
      }
      return {
        ok: true,
        command: `SOPS_AGE_KEY_FILE=${key} ${sops.path} ${DECRYPT.join(' ')} ${file.path} | sed -n s/\\^${entry.env}=//p`,
      };
    },
  };
}

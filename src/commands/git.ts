// `team git` and `team gh`: the only doors from a seat to GitHub. The entity's GitHub token stays
// in the keychain and out of every seat: TeamCLI reads it for the one command it runs, hands it to
// that `git` or `gh` process alone, and checks the command against the team's rules first (no
// force push, no push to a trunk, no merge, release or credential command). Local git (commit,
// branch, diff, log) needs no token and stays plain `git`.
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Command, Io } from '../io.ts';
import { loadTeamFile } from '../file/load.ts';
import { keyOf, realSecurityRun } from '../release/keychain.ts';
import { parseYaml, toValue } from '../yaml.ts';

export const USAGE = `Usage: team git push [<git push arguments>]
       team git fetch [<git fetch arguments>]
       team git pull [<git pull arguments>]
       team gh <gh arguments>

Runs git or gh against GitHub with the entity's GitHub identity
(~/.config/team/entities/<entity>/identity.yaml). The token is read from the keychain for this
one command and given to that process only; the seat never holds it. Refused before anything
runs: a force push, a push to main or master, a push that deletes a branch or mirrors, and the gh
commands that merge, release, delete a repository, or touch credentials, secrets or keys.

Exits with the command's own code, 1 when it is refused or the identity cannot be read, 2 when
the invocation can't be read.
`;

/** The trunks no seat pushes to: a trunk merge needs a gate pass (roles RFC 009, A.3). */
const TRUNKS = new Set(['main', 'master']);

export type Identity = { account: string; authorName: string; authorEmail: string; keychain: string };

/** The entity's GitHub identity, or why it cannot be used. The file holds no secret. */
export function identityFor(home: string, entity: string): Identity | { why: string } {
  const path = join(home, '.config', 'team', 'entities', entity, 'identity.yaml');
  let text: string;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || (info.mode & 0o022) !== 0) return { why: `${path} is a link or writable by others` };
    text = readFileSync(path, 'utf8');
  } catch {
    return { why: `the entity ${entity} has no GitHub identity (${path})` };
  }
  let root: unknown;
  try {
    root = toValue(parseYaml(text));
  } catch {
    return { why: `${path} cannot be read` };
  }
  const github = (root as { github?: Record<string, unknown> } | null)?.github ?? {};
  const word = (value: unknown, pattern: RegExp) => (typeof value === 'string' && pattern.test(value) ? value : undefined);
  const account = word(github.account, /^[A-Za-z0-9-]+$/);
  const authorName = word(github.author_name, /^[^\n\r]{1,100}$/);
  const authorEmail = word(github.author_email, /^[^\s@]+@[^\s@]+$/);
  const keychain = word(github.keychain, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  if (!account || !authorName || !authorEmail || !keychain) return { why: `${path} lacks account, author_name, author_email or keychain` };
  return { account, authorName, authorEmail, keychain };
}

/** The entity a folder belongs to: its team's, else the one entity that declares an identity. */
function entityOf(home: string, cwd: string): string | null {
  try {
    const loaded = loadTeamFile(cwd) as { ok?: boolean; team?: { entity?: string | null } };
    if (loaded.ok === true && typeof loaded.team?.entity === 'string' && loaded.team.entity !== '') return loaded.team.entity;
  } catch { /* fall through */ }
  const dir = join(home, '.config', 'team', 'entities');
  if (!existsSync(dir)) return null;
  const withIdentity = readdirSync(dir).filter((name) => existsSync(join(dir, name, 'identity.yaml')));
  return withIdentity.length === 1 ? withIdentity[0]! : null;
}

/** Why a git command is refused, or null. */
export function gitRefusal(verb: string, args: readonly string[], branch: string | null): string | null {
  if (!['push', 'fetch', 'pull'].includes(verb)) return `team git runs push, fetch and pull only; plain git does the rest`;
  if (verb !== 'push') return null;
  const forced = args.find((arg) => /^(-f|--force|--force-with-lease(=.*)?|--force-if-includes|--mirror|--delete|-d|--prune|--all)$/.test(arg) || /^\+/.test(arg));
  if (forced !== undefined) return `a force push, a delete, a mirror or an all-branches push is refused (${forced})`;
  const targets = args.filter((arg) => !arg.startsWith('-')).slice(1);
  for (const spec of targets) {
    const dest = (spec.includes(':') ? spec.slice(spec.lastIndexOf(':') + 1) : spec).replace(/^refs\/heads\//, '');
    if (TRUNKS.has(dest)) return `a push to ${dest} is refused: a trunk merge goes through its gate`;
  }
  if (targets.length === 0 && branch !== null && TRUNKS.has(branch)) return `this checkout is on ${branch}: a push to a trunk is refused`;
  return null;
}

/** Why a gh command is refused, or null. */
export function ghRefusal(args: readonly string[]): string | null {
  const [group, verb] = args;
  if (group === undefined) return 'name a gh command';
  if (['auth', 'secret', 'ssh-key', 'gpg-key', 'release', 'variable', 'codespace', 'extension', 'config', 'alias'].includes(group)) {
    return `gh ${group} is refused: credentials, secrets, keys and releases are not a seat's`;
  }
  if (group === 'pr' && verb === 'merge') return 'gh pr merge is refused: a merge goes through its gate';
  if (group === 'repo' && ['delete', 'edit', 'rename', 'archive', 'create', 'fork'].includes(verb ?? '')) return `gh repo ${verb} is refused`;
  if (group === 'api') {
    const method = args.find((arg, at) => (args[at - 1] === '-X' || args[at - 1] === '--method'))?.toUpperCase();
    const writes = args.some((arg) => /^(-f|-F|--field|--raw-field|--input)$/.test(arg));
    if ((method !== undefined && method !== 'GET') || writes) return 'gh api reads only (GET); a write goes through its own gh command';
  }
  return null;
}

/** The child's environment: the caller's, with every other GitHub credential cleared, the
 *  token for this process only, git sent to GitHub over HTTPS through gh, and the identity. */
function childEnv(io: Io, id: Identity, token: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(io.env)) {
    if (value === undefined) continue;
    if (/^(GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_HOST|GH_CONFIG_DIR|GIT_CONFIG_.*|GIT_ASKPASS|SSH_ASKPASS)$/.test(key)) continue;
    env[key] = value;
  }
  env.GH_TOKEN = token;
  env.GIT_AUTHOR_NAME = id.authorName;
  env.GIT_AUTHOR_EMAIL = id.authorEmail;
  env.GIT_COMMITTER_NAME = id.authorName;
  env.GIT_COMMITTER_EMAIL = id.authorEmail;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_COUNT = '4';
  env.GIT_CONFIG_KEY_0 = 'credential.https://github.com.helper';
  env.GIT_CONFIG_VALUE_0 = '';
  env.GIT_CONFIG_KEY_1 = 'credential.https://github.com.helper';
  env.GIT_CONFIG_VALUE_1 = '!gh auth git-credential';
  env.GIT_CONFIG_KEY_2 = 'url.https://github.com/.insteadOf';
  env.GIT_CONFIG_VALUE_2 = 'git@github.com:';
  env.GIT_CONFIG_KEY_3 = 'url.https://github.com/.insteadOf';
  env.GIT_CONFIG_VALUE_3 = 'ssh://git@github.com/';
  return env;
}

function currentBranch(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer | string) => { out += chunk; });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out.trim() : null));
  });
}

function run(binary: string, args: string[], io: Io, env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { cwd: io.cwd, env, stdio: 'inherit' });
    child.on('error', (error) => { io.stderr(`team: ${binary} could not start: ${error.message}\n`); resolve(1); });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Shared by `team git` and `team gh`: refuse, read the identity and the token, run. */
export async function runGitHub(tool: 'git' | 'gh', argv: string[], io: Io): Promise<number> {
  if (argv.length === 0) {
    io.stderr(USAGE);
    return 2;
  }
  const home = io.env.HOME ?? '';
  const refused = tool === 'gh' ? ghRefusal(argv) : gitRefusal(argv[0]!, argv.slice(1), await currentBranch(io.cwd));
  if (refused !== null) {
    io.stderr(`team ${tool}: refused: ${refused}\n`);
    return 1;
  }
  const entity = entityOf(home, io.cwd);
  if (entity === null) {
    io.stderr(`team ${tool}: no entity GitHub identity applies to this folder\n`);
    return 1;
  }
  const id = identityFor(home, entity);
  if ('why' in id) {
    io.stderr(`team ${tool}: ${id.why}\n`);
    return 1;
  }
  if (process.platform !== 'darwin') {
    io.stderr(`team ${tool}: the token's store is not available on this platform\n`);
    return 1;
  }
  const read = await realSecurityRun(id.keychain);
  const key = read.ok ? keyOf(read.stdout) : { ok: false as const, reason: 'the lookup failed' };
  if (!key.ok) {
    io.stderr(`team ${tool}: the GitHub token could not be read (${key.reason})\n`);
    return 1;
  }
  return run(tool, argv, io, childEnv(io, id, key.key));
}

const gitCommand: Command = (argv, io) => runGitHub('git', argv, io);
export default gitCommand;

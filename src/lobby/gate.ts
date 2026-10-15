import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The machine-global lobby path for a given user home: `<home>/.config/team/lobby`. This is the
 *  lobby a team that sets neither `entity` nor `lobby` uses, the shape every team used before
 *  per-entity lobbies existed. The approval-store containment checks (`file/paths.ts`) stay on
 *  this folder: it, and the per-entity lobbies beside it, all sit under `<home>/.config/team`. */
export function lobbyDir(home: string = homedir()): string {
  return join(home, '.config', 'team', 'lobby');
}

/** How a team names the lobby its seats start and wait in. A team that sets neither key uses the
 *  machine-global lobby (`lobbyDir`), the backward-compatible default; one that sets `entity`
 *  gets a lobby of its own under `<home>/.config/team/lobbies/<slug>`; one that sets `lobby`
 *  names the folder outright (a `~` prefix is the home). */
export interface LobbyConfig {
  entity?: string | null;
  lobby?: string | null;
}

/** The path segment an entity resolves to under `.config/team/lobbies`. The section validator
 *  holds `entity` to the project-name shape — letters, digits, ".", "_" and "-", starting with a
 *  letter or digit — so lower-casing is the whole slug and never yields "", "." or "..". */
export function lobbySlug(entity: string): string {
  return entity.toLowerCase();
}

/** Expands a leading `~` to the home. A `~` anywhere else is left as written: the gate's own
 *  symlink and realpath checks refuse a path that does not resolve to a real folder under it. */
function expandHome(path: string, home: string): string {
  return resolve(path.replace(/^~(?=$|\/)/, home));
}

/**
 * The absolute lobby path a team operates on. Explicit `lobby` wins; then `entity`, under
 * `<home>/.config/team/lobbies/<slug>`; then, when neither is set, the machine-global lobby —
 * so a team that declares neither key is byte-for-byte unchanged.
 */
export function resolveLobby(home: string = homedir(), config?: LobbyConfig): string {
  if (config?.lobby) return expandHome(config.lobby, home);
  if (config?.entity) return join(home, '.config', 'team', 'lobbies', lobbySlug(config.entity));
  return lobbyDir(home);
}

/** The lobby entry a team's trust must list, spelled with a `~` when the lobby is under the home
 *  (so the block a migration prints stays portable), and absolute otherwise. For a team that sets
 *  neither key this is exactly `~/.config/team/lobby`, as it has always been. */
export function lobbyTrustEntry(home: string = homedir(), config?: LobbyConfig): string {
  const abs = resolveLobby(home, config);
  const rel = relative(home, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return abs;
  return `~/${rel.split(sep).join('/')}`;
}

/** The components from `home` (inclusive) down to the resolved lobby (inclusive): the chain the
 *  gate verifies and, with `create`, makes one at a time. For a lobby under the home this is
 *  `home`, every folder on the way, and the lobby itself; for the default lobby that is exactly
 *  `[home, .config, .config/team, .config/team/lobby]`. A lobby that is not under the home has no
 *  chain to walk through the home: only the home and the lobby are checked directly. */
function lobbyChain(home: string, lobby: string): string[] {
  const rel = relative(home, lobby);
  if (!rel) return [home];
  if (rel.startsWith('..') || isAbsolute(rel)) return [home, lobby];
  const chain = [home];
  let current = home;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    chain.push(current);
  }
  return chain;
}

export interface FsStats {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isFile(): boolean;
  mode: number;
  uid: number;
  dev: number;
  ino: number;
}

/** What one `lstat` with `bigint: true` says of a declared file: the numbers, at full
 *  nanosecond resolution, a file created again under the same name cannot all keep. Where the
 *  platform reports no birth time, `birthtimeNs` is what that platform reports instead — zero,
 *  or the change time — and is never compared. */
export interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
}

export interface FsReader {
  lstat(path: string): FsStats;
  /** A declared file's identity fields, at full resolution. Still only an `lstat`: the gate
   *  never opens a declared file. */
  lstatIdentity(path: string): FileIdentity;
  mkdir(path: string, options?: { mode?: number }): void;
  readdir(path: string): string[];
  realpath(path: string): string;
}

export const defaultFs: FsReader = {
  lstat: (p) => lstatSync(p),
  lstatIdentity: (p) => lstatSync(p, { bigint: true }),
  mkdir: (p, opts) => mkdirSync(p, { recursive: false, mode: opts?.mode }),
  readdir: (p) => readdirSync(p),
  realpath: (p) => realpathSync(p),
};

function codeOf(err: unknown): string {
  const error = err as { code?: string; message?: string };
  return String(error?.code ?? error?.message ?? 'unknown');
}

export type RepoSearch = { root: string | null; error?: { path: string; code: string } };

/** Walks ancestors for a `.git` entry. A read error other than absence is returned, never treated as "no repository". */
export function searchRepo(startPath: string, fs: FsReader = defaultFs): RepoSearch {
  let current = resolve(startPath);
  while (true) {
    const gitPath = join(current, '.git');
    try {
      const stat = fs.lstat(gitPath);
      if (stat.isDirectory() || stat.isFile()) return { root: current };
    } catch (err) {
      if (codeOf(err) !== 'ENOENT') return { root: null, error: { path: gitPath, code: codeOf(err) } };
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { root: null };
}

/** The repository that holds `startPath`, or null when none does. A read error is null here; the gate uses `searchRepo`. */
export function findRepoRoot(startPath: string, fs: FsReader = defaultFs): string | null {
  return searchRepo(startPath, fs).root;
}

export type LobbyGateResult =
  | { ok: true; path: string; dev: number; ino: number; files: readonly LobbyFileSeen[] }
  | { ok: true; missing: true }
  /** A refusal: `text` is the whole finding — the folders this machine resolved — for the
   *  terminal; `words` is the same cause with no folder in it, what a record and the log may
   *  hold. Every refusal arm authors both, so no later caller has to guess. */
  | { ok: false; problem: 'symlink' | 'owner' | 'mode' | 'not-empty' | 'repo' | 'not-directory' | 'not-file' | 'read-error' | string; text: string; words: string; component?: string };

/** One declared file the gate allowed: its path relative to the lobby, and the identity it
 *  carried when the gate read it — its device and inode, and what a file created again under
 *  the same name cannot keep even where the filesystem hands it the same inode number: its
 *  size, its inode change time and, where the platform reports one, its birth time, both at
 *  full nanosecond resolution. */
export interface LobbyFileSeen {
  path: string;
  dev: number;
  ino: number;
  size: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
}

export interface VerifyLobbyOptions {
  create?: boolean;
  getuid?: () => number;
  fs?: FsReader;
  /** Paths a shipped CLI reads at start. A `directory` entry matches itself and everything
   *  under it, at any depth. Absent, nothing in the tree is refused for being read. */
  reads?: readonly LobbyRead[];
  /** The resolved lobby the team operates on (`resolveLobby`). Absent, the machine-global lobby
   *  is used — the backward-compatible default for a team that sets neither `entity` nor
   *  `lobby`. The ancestor chain the gate verifies runs from the home down to this path. */
  lobby?: string;
}

type CompCheck = { ok: true; stat: FsStats } | { ok: false; problem: string; text: string; words: string; component?: string };

type TreeCheck = { ok: true; files: LobbyFileSeen[] } | { ok: false; problem: string; text: string; words: string };

/** A path a shipped CLI reads at start. `directory` matches that directory and everything
 *  under it. `clis` is the profile `cli` names, in ship order. */
export interface LobbyRead {
  path: string;
  directory: boolean;
  clis: readonly string[];
}

function cliList(clis: readonly string[]): string {
  if (clis.length <= 1) return clis[0] ?? '';
  if (clis.length === 2) return `${clis[0]} and ${clis[1]}`;
  return `${clis.slice(0, -1).join(', ')} and ${clis[clis.length - 1]}`;
}

function readBy(rel: string, reads: readonly LobbyRead[]): readonly string[] {
  const clis: string[] = [];
  for (const read of reads) {
    const hit = read.directory
      ? rel === read.path || rel.startsWith(`${read.path}/`) || rel.endsWith(`/${read.path}`) || rel.includes(`/${read.path}/`)
      : rel === read.path || rel.endsWith(`/${read.path}`);
    if (!hit) continue;
    for (const cli of read.clis) if (!clis.includes(cli)) clis.push(cli);
  }
  return clis;
}

/** The lobby's whole tree. A symbolic link or a file owned by someone else is refused
 *  wherever it sits. A path a shipped CLI reads at start is refused at any depth, naming
 *  the file and those CLIs. Everything else passes. The gate only ever lists and stats:
 *  it opens none of these files, and never follows a name that might be a link. */
function checkClosedTree(lobby: string, reads: readonly LobbyRead[], fs: FsReader, myUid: number): TreeCheck {
  const refuseRead = (rel: string, clis: readonly string[]): TreeCheck => ({
    ok: false, problem: 'startup-read',
    text: `the lobby ${lobby}: ${rel} is read at start by ${cliList(clis)}`,
    words: `the lobby: ${rel} is read at start by ${cliList(clis)}`,
  });

  const walk = (rel: string): TreeCheck | null => {
    let entries: string[];
    try {
      entries = fs.readdir(rel === '' ? lobby : join(lobby, rel));
    } catch (err) {
      return {
        ok: false, problem: 'read-error',
        text: `the lobby ${lobby}: cannot read directory: ${codeOf(err)}`,
        words: 'the lobby: it cannot be listed',
      };
    }
    for (const name of entries) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      const full = join(lobby, childRel);
      let stat: FsStats;
      try {
        stat = fs.lstat(full);
      } catch (err) {
        return {
          ok: false, problem: 'read-error',
          text: `the lobby ${lobby}: cannot read ${full}: ${codeOf(err)}`,
          words: `the lobby: ${childRel} cannot be read`,
        };
      }
      if (stat.isSymbolicLink()) {
        return {
          ok: false, problem: 'symlink',
          text: `the lobby ${lobby}: ${full} is a symbolic link`,
          words: `the lobby: ${childRel} is a symbolic link`,
        };
      }
      if (stat.uid !== myUid) {
        return {
          ok: false, problem: 'owner',
          text: `the lobby ${lobby}: ${full} is not owned by you`,
          words: `the lobby: ${childRel} is not owned by you`,
        };
      }
      // A directory is walked first, so a file under a read directory is named itself.
      // An empty directory that is itself a read is named after the walk finds nothing.
      if (stat.isDirectory()) {
        const down = walk(childRel);
        if (down !== null) return down;
      }
      const clis = readBy(childRel, reads);
      if (clis.length) return refuseRead(childRel, clis);
    }
    return null;
  };

  const refused = walk('');
  if (refused !== null) return refused;
  return { ok: true, files: [] };
}

/**
 * Verifies the lobby folder and every component from `home` down to it.
 * When `create` is set, missing components are made one at a time, without following a link,
 * and the lobby is created with mode `0700` in its own mkdir call — this runtime applies that
 * mode under umask 022 and 077 alike — and nothing chmods it afterwards: the mode is checked
 * below and a wrong one is refused, never repaired, so no link swapped in after creation can
 * steer a mode change at a folder the gate did not create. The successful result's `path` is
 * the canonical path rebuilt from the components just `lstat`ed: the same string `realpath` of
 * the lobby returned. A read-only check of a lobby that is simply absent — including when
 * `~/.config` or `team` is not there yet — is `{ missing: true }`, not a failure.
 *
 * With `reads`, a path a shipped CLI reads at start is refused at any depth. A link or a
 * wrong owner is refused anywhere in the tree. Every other file and directory passes.
 * The gate never opens a file.
 */
export function verifyLobby(home: string, options?: VerifyLobbyOptions): LobbyGateResult {
  const lobby = options?.lobby ?? lobbyDir(home);
  const fs = options?.fs ?? defaultFs;
  const myUid = options?.getuid ? options.getuid() : process.getuid?.() ?? 0;

  const chain = lobbyChain(home, lobby);

  // How a refusal's words name the component that caused it, without the folder itself: the
  // lobby, your home folder, or a folder on the way to it. The words travel in records and the
  // log; the folder travels only in `text`, on the terminal.
  const where = (comp: string): string =>
    comp === lobby ? 'it' : comp === home ? 'your home folder' : 'a folder on the way to it';

  function checkComp(comp: string): CompCheck {
    let stat: FsStats;
    try {
      stat = fs.lstat(comp);
    } catch (err) {
      if (codeOf(err) === 'ENOENT') {
        return {
          ok: false, problem: 'not-directory',
          text: `the lobby ${lobby}: ${comp} does not exist`,
          words: `the lobby: ${where(comp)} is not there`,
          component: comp,
        };
      }
      return {
        ok: false, problem: 'read-error',
        text: `the lobby ${lobby}: cannot read ${comp}: ${codeOf(err)}`,
        words: `the lobby: ${where(comp)} cannot be read`,
        component: comp,
      };
    }
    if (stat.isSymbolicLink()) {
      return {
        ok: false, problem: 'symlink',
        text: `the lobby ${lobby}: ${comp} is a symbolic link`,
        words: `the lobby: ${where(comp)} is a symbolic link`,
        component: comp,
      };
    }
    if (!stat.isDirectory()) {
      const text = comp === lobby ? `the lobby ${lobby}: is not a directory` : `the lobby ${lobby}: ${comp} is not a directory`;
      return { ok: false, problem: 'not-directory', text, words: `the lobby: ${where(comp)} is not a directory`, component: comp };
    }
    if (stat.uid !== myUid) {
      return {
        ok: false, problem: 'owner',
        text: `the lobby ${lobby}: ${comp} is not owned by you`,
        words: `the lobby: ${where(comp)} is not owned by you`,
        component: comp,
      };
    }
    return { ok: true, stat };
  }

  const homeCheck = checkComp(home);
  if (!homeCheck.ok) return homeCheck;

  if (options?.create) {
    for (let i = 1; i < chain.length; i++) {
      const comp = chain[i] as string;
      const parent = chain[i - 1] as string;
      const parentCheck = checkComp(parent);
      if (!parentCheck.ok) return parentCheck;

      try {
        fs.lstat(comp);
      } catch (err) {
        if (codeOf(err) !== 'ENOENT') {
          return {
            ok: false, problem: 'read-error',
            text: `the lobby ${lobby}: cannot read ${comp}: ${codeOf(err)}`,
            words: `the lobby: ${where(comp)} cannot be read`,
            component: comp,
          };
        }
        try {
          fs.mkdir(comp, comp === lobby ? { mode: 0o700 } : undefined);
        } catch (mkErr) {
          return {
            ok: false, problem: 'not-directory',
            text: `the lobby ${lobby}: failed to create ${comp}: ${codeOf(mkErr)}`,
            words: `the lobby: ${where(comp)} could not be created`,
            component: comp,
          };
        }
      }

      const seen = checkComp(comp);
      if (!seen.ok) return seen;
    }
  } else {
    for (const comp of chain) {
      let stat: FsStats;
      try {
        stat = fs.lstat(comp);
      } catch (err) {
        if (codeOf(err) === 'ENOENT') {
          if (comp === home) {
            return {
              ok: false, problem: 'not-directory',
              text: `the lobby ${lobby}: ${comp} does not exist`,
              words: `the lobby: ${where(comp)} is not there`,
              component: comp,
            };
          }
          return { ok: true, missing: true };
        }
        return {
          ok: false, problem: 'read-error',
          text: `the lobby ${lobby}: cannot read ${comp}: ${codeOf(err)}`,
          words: `the lobby: ${where(comp)} cannot be read`,
          component: comp,
        };
      }
      if (stat.isSymbolicLink()) {
        return {
          ok: false, problem: 'symlink',
          text: `the lobby ${lobby}: ${comp} is a symbolic link`,
          words: `the lobby: ${where(comp)} is a symbolic link`,
          component: comp,
        };
      }
      if (!stat.isDirectory()) {
        const text = comp === lobby ? `the lobby ${lobby}: is not a directory` : `the lobby ${lobby}: ${comp} is not a directory`;
        return { ok: false, problem: 'not-directory', text, words: `the lobby: ${where(comp)} is not a directory`, component: comp };
      }
      if (stat.uid !== myUid) {
        return {
          ok: false, problem: 'owner',
          text: `the lobby ${lobby}: ${comp} is not owned by you`,
          words: `the lobby: ${where(comp)} is not owned by you`,
          component: comp,
        };
      }
    }
  }

  for (const comp of chain) {
    const verified = checkComp(comp);
    if (!verified.ok) return verified;
  }

  let homeReal: string;
  try {
    homeReal = fs.realpath(home);
  } catch (err) {
    return {
      ok: false, problem: 'read-error',
      text: `the lobby ${lobby}: cannot resolve ${home}: ${codeOf(err)}`,
      words: 'the lobby: your home folder cannot be resolved',
    };
  }
  // The lobby's canonical path anchored to the canonical home: the same relative tail the
  // resolved lobby has from the home. For the default lobby this is `<homeReal>/.config/team/lobby`,
  // as before. A lobby that is not under the home keeps its own resolved path.
  const lobbyRel = relative(home, lobby);
  const expectedLobby = lobbyRel && !lobbyRel.startsWith('..') && !isAbsolute(lobbyRel)
    ? join(homeReal, lobbyRel)
    : lobby;

  let real: string;
  try {
    real = fs.realpath(lobby);
  } catch (err) {
    return {
      ok: false, problem: 'symlink',
      text: `the lobby ${lobby}: cannot resolve canonical path: ${codeOf(err)}`,
      words: 'the lobby: its canonical path cannot be resolved',
    };
  }
  if (real !== expectedLobby) {
    return {
      ok: false, problem: 'symlink',
      text: `the lobby ${lobby}: canonical path ${real} does not match ${expectedLobby}`,
      words: 'the lobby: its canonical path leads somewhere else',
    };
  }

  let lobbyStat: FsStats;
  try {
    lobbyStat = fs.lstat(lobby);
  } catch (err) {
    return {
      ok: false, problem: 'read-error',
      text: `the lobby ${lobby}: cannot read ${lobby}: ${codeOf(err)}`,
      words: 'the lobby: it cannot be read',
      component: lobby,
    };
  }
  const mode = lobbyStat.mode & 0o7777;
  if (mode !== 0o700) {
    return {
      ok: false, problem: 'mode',
      text: `the lobby ${lobby}: has mode 0${mode.toString(8)}, not 0700`,
      words: `the lobby: it has mode 0${mode.toString(8)}, not 0700`,
    };
  }

  const tree = checkClosedTree(lobby, options?.reads ?? [], fs, myUid);
  if (!tree.ok) return tree;

  const logicalRepo = searchRepo(lobby, fs);
  if (logicalRepo.error) {
    return {
      ok: false, problem: 'repo',
      text: `the lobby ${lobby}: cannot read ${logicalRepo.error.path}: ${logicalRepo.error.code}`,
      words: `the lobby: it cannot be checked for a repository above it (${logicalRepo.error.code})`,
    };
  }
  if (logicalRepo.root) {
    return {
      ok: false, problem: 'repo',
      text: `the lobby ${lobby}: is inside the repository ${logicalRepo.root}`,
      words: 'the lobby: it is inside a repository',
    };
  }
  const canonicalRepo = searchRepo(real, fs);
  if (canonicalRepo.error) {
    return {
      ok: false, problem: 'repo',
      text: `the lobby ${lobby}: cannot read ${canonicalRepo.error.path}: ${canonicalRepo.error.code}`,
      words: `the lobby: it cannot be checked for a repository above it (${canonicalRepo.error.code})`,
    };
  }
  if (canonicalRepo.root) {
    return {
      ok: false, problem: 'repo',
      text: `the lobby ${lobby}: is inside the repository ${canonicalRepo.root}`,
      words: 'the lobby: its canonical path is inside a repository',
    };
  }

  return { ok: true, path: real, dev: lobbyStat.dev, ino: lobbyStat.ino, files: tree.files };
}

/** The lobby the gate verified, so a later check can say it is still the same folder — and
 *  the declared files it allowed then, so the same check can say each is still the file the
 *  gate read: same device and inode, size and times. Absent when the caller recorded none, as
 *  before this field existed. */
export interface LobbySeen {
  path: string;
  dev: number;
  ino: number;
  files?: readonly LobbyFileSeen[];
}

/** Whether a declared file is still the one the gate read: the same device and inode, and —
 *  because a deleted file's inode can be handed straight to a new file under the same name —
 *  the same size and the same inode change time, and the same birth time where the platform
 *  reports one at both reads. What remains possible, and is said in the docs: a file rewritten
 *  in place inside one filesystem timestamp tick, without a size change. */
function isSameFile(seen: LobbyFileSeen, read: LobbyFileSeen): boolean {
  if (seen.dev !== read.dev || seen.ino !== read.ino) return false;
  if (seen.size !== read.size || seen.ctimeNs !== read.ctimeNs) return false;
  if (seen.birthtimeNs !== 0n && read.birthtimeNs !== 0n && seen.birthtimeNs !== read.birthtimeNs) return false;
  return true;
}

/**
 * A refusal, in the two forms the run needs: `reason` is the cause in words, with no folder
 * this machine resolved — what a seat's record and the log may hold; `detail` is the fuller
 * sentence, the folder included, said on stderr under the record, for the owner's terminal
 * only.
 */
export type LobbyRefusal = { reason: string; detail: string };

/**
 * The confirmation a starting folder gets directly before it is used: the gate's own checks
 * again, and that it is still the folder the gate read — the same canonical path, the same
 * device and inode. Null when it is; the refusal when it is not — the gate's own words and
 * text where the check refuses, so the operator reads the same cause the gate would have
 * given. Used by `up` and `add` before each workspace they make in the lobby, with nothing
 * between this and the create.
 */
export function recheckLobby(
  home: string,
  seen: LobbySeen,
  options?: { getuid?: () => number; fs?: FsReader; reads?: readonly LobbyRead[]; lobby?: string },
): LobbyRefusal | null {
  const again = verifyLobby(home, { create: false, getuid: options?.getuid, fs: options?.fs, reads: options?.reads, lobby: options?.lobby });
  if (!again.ok) return { reason: again.words, detail: again.text };
  if (!('path' in again)) {
    return { reason: 'the lobby: it is not there any more', detail: `the lobby ${seen.path}: it is not there any more` };
  }
  if (again.path !== seen.path || again.dev !== seen.dev || again.ino !== seen.ino) {
    return {
      reason: 'the lobby: it is not the folder the gate read',
      detail: `the lobby ${seen.path}: it is not the folder the gate read`,
    };
  }
  // The whole tree is re-checked above; what remains is that each file the gate allowed is
  // still the file it read — the same device and inode, and the size and times a file created
  // again under the same name cannot keep, because a deleted file's inode can be handed
  // straight to a new file on that name (Linux did, in CI, twice). A file gone missing is
  // allowed: the CLI that made it may have removed it, and a later check will see the lobby
  // clean again.
  const now = new Map(again.files.map((one) => [one.path, one]));
  for (const one of seen.files ?? []) {
    const read = now.get(one.path);
    if (read && !isSameFile(one, read)) {
      return {
        reason: `the lobby: ${one.path} is not the file the gate read`,
        detail: `the lobby ${seen.path}: ${one.path} is not the file the gate read`,
      };
    }
  }
  return null;
}

// `team broker`: the one process that reads the tracker credential. The owner runs it, in a
// foreground terminal outside herdr, one per clone — a call placed as a seat, in a pane or under
// herdr at all is refused before the credential is read and before any bind. It refuses to start
// without the macOS Keychain facility or without an interactive run, because the credential's
// home is the owner's Keychain and the read is the owner's act. The key is read once, at start,
// into this process's memory only; it reaches
// exactly one place — the Authorization header of the tracker's single bounded read. The broker
// never puts its own credential, or the tracker's API access, into any field it returns: the
// answer holds the typed record, filtered by the team file's task policy before it is
// serialized. The broker runs as the same OS user as the seats: that is an integrity boundary,
// not an authenticity one, and the page says so. Nothing starts or restarts the broker.
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, detachedRefusal, isOwner } from '../caller.ts';
import { findRoot, loadTeamFile, NOT_A_REPO_NO_FILE } from '../file/load.ts';
import type { Command, Io } from '../io.ts';
import { realFetch, type Fetch } from '../release/http.ts';
import { keychainReader, realSecurityRun, type KeyReader } from '../release/keychain.ts';
import { linearRead } from '../tasks/linear.ts';
import { brokerSocket } from '../broker/protocol.ts';
import { startBroker, type BrokerReadResult } from '../broker/server.ts';

export const USAGE = `Usage: team broker

Runs the one process that holds the tracker credential and answers \`team next\` over
\`.agents/broker.sock\` in this clone. Only the owner runs it, from a terminal outside herdr.
The key is read from the macOS Keychain once, at start,
and never crosses to a seat: the answer holds the typed record, filtered by the team file's
task policy. Ctrl-C stops it.

Exits 0 when it stopped, 1 when it refused to start or lost its socket, 2 when the
invocation can't be read or this folder is not a git checkout.
`;

/** The command's injectable seams, in the house style: the tracker fetch, the one credential
 *  read, and the signal that ends the serve loop. */
export type BrokerSources = {
  home?: string;
  /** The tracker seam, injected the way `team release check` injects its own: a test answers a
   *  map instead of opening a connection. */
  fetch?: Fetch;
  /** Production wires `keychainReader` with `realSecurityRun`; a test hands in a literal string
   *  and never runs the real facility. */
  keyReader?: KeyReader;
  /** Arms the end of the serve loop and returns the undo. Production listens for SIGINT and
   *  SIGTERM; a test ends the loop itself. */
  stop?: (end: () => void) => () => void;
};

export const broker: Command = (argv, io) => runBroker(argv, io);
export default broker;

export async function runBroker(argv: string[], io: Io, sources: BrokerSources = {}): Promise<number> {
  const args = readArgs(argv, [], []);
  if (args.error || args.rest.length) {
    io.stderr(`team broker: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    // exit: broker.invocation
    return 2;
  }
  // The start is the owner's, and this gate comes before every other prerequisite: a call placed
  // as a seat, in a pane, under herdr, or with no terminal is refused here, before the credential
  // is read and before the socket is bound. A run with no terminal gets the one sentence; the
  // Keychain is not asked. Dev mode does not reach this gate: serving is never a dev-mode command
  // (`dev_mode.ts`), so the orchestrator's and the operator's seats are refused as every other
  // caller is.
  const caller = callerOf(io);
  const detached = detachedRefusal(caller);
  if (detached !== undefined) {
    io.stderr(`team broker: ${detached}\n`);
    // exit: broker.detached
    return 1;
  }
  const placement = `only the owner runs \`broker\`, from a terminal outside herdr; this call is ${describeCaller(caller)}`;
  const owner = isOwner(caller);
  if (!owner) {
    io.stderr(`team broker: ${placement}\n`);
    // exit: broker.not-owner
    return 1;
  }
  const root = findRoot(io.cwd);
  if (!root) {
    // `team broker` takes no `--file`, so the no-repository refusal must not offer one.
    io.stderr(`team broker: ${NOT_A_REPO_NO_FILE}\n`);
    // exit: broker.not-a-repo
    return 2;
  }
  const loaded = loadTeamFile(io.cwd, { home: sources.home });
  if (!loaded.ok) return unreadable(io, loaded.errors[0]?.message ?? 'the team file can\'t be read');
  const tasks = loaded.team.tasks;
  if (!tasks) return notLinear(io, 'the team file declares no task source');
  if (tasks.source !== 'linear') return notLinear(io, 'tasks.source must be linear; the broker serves a tracker source');

  // The one credential read, after every non-secret prerequisite is known, at most once: the
  // facility refuses a non-interactive run and a platform without it, before any request is
  // formed. The key lives in this closure and in one header; nothing else ever sees it.
  const keyReader = sources.keyReader ?? keychainReader(process.platform, io.stdinIsTTY, realSecurityRun);
  const credential = await keyReader(tasks.linear.keychainService);
  if (!credential.ok) {
    io.stderr(`team broker: ${credential.reason}\n`);
    // exit: broker.keychain
    return 1;
  }
  const fetcher = sources.fetch ?? realFetch;
  const read = () => trackerRead(tasks.linear.project, fetcher, credential.key);

  const started = await startBroker({
    root: loaded.root,
    team: loaded.team,
    read,
    ...(tasks.policy ? { policy: tasks.policy } : {}),
    stderr: (text) => io.stderr(text),
  });
  if (started.kind === 'busy') {
    io.stderr(`team broker: a broker is already answering on ${relativeSocket()}\n`);
    // exit: broker.busy
    return 1;
  }
  if (started.kind === 'locked') {
    io.stderr(`team broker: another start is binding ${relativeSocket()}; try again\n`);
    // exit: broker.locked
    return 1;
  }
  if (started.kind === 'bind-failed') {
    io.stderr(`team broker: the socket could not be bound${started.code === undefined ? '' : `: ${started.code}`}\n`);
    // exit: broker.bind
    return 1;
  }
  if (started.cleared) io.stderr('team broker: cleared a stale socket file\n');
  io.stderr(`team broker: answering on ${relativeSocket()}\n`);
  await stopped(sources.stop ?? signals);
  await started.handle.close();
  io.stderr('team broker: stopped\n');
  // exit: broker.stopped
  return 0;
}

/** The one bounded tracker read, behind the boundary: the credential goes in, a TaskRead or a
 *  failure comes out. The failure's detail stays on the terminal, where the owner reads it; the
 *  seat hears only that the broker failed the read. */
async function trackerRead(project: string, fetcher: Fetch, credential: string): Promise<BrokerReadResult> {
  const result = await linearRead({ project, fetch: fetcher, credential });
  if (result.kind === 'refused') return { kind: 'failed', message: result.message };
  return result.notice === undefined
    ? { kind: 'read', read: result.read }
    : { kind: 'read', read: result.read, notice: result.notice };
}

/** The socket's name as every line and every page writes it: relative to the clone. */
function relativeSocket(): string {
  return '.agents/broker.sock';
}

/** The serve loop: the promise resolves when the first signal arrives (production) or when the
 *  injected stop calls the end. Signals never kill the process outright, so the close that
 *  removes the socket file still runs. */
export function stopped(arm: (end: () => void) => () => void): Promise<void> {
  return new Promise((done) => {
    const off = arm(() => {
      off();
      done();
    });
  });
}

/** Ctrl-C and SIGTERM end the broker; the returned function removes both listeners. */
function signals(end: () => void): () => void {
  const handler = () => end();
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}

/** The team file is refused: a syntax error, a bad section, or the tasks policy's own rules.
 *  The policy row is the exit-codes suite's other face of this same return. */
function unreadable(io: Io, message: string): number {
  io.stderr(`team broker: ${message}\n`);
  // exit: broker.file
  // exit: broker.policy
  return 1;
}

function notLinear(io: Io, message: string): number {
  io.stderr(`team broker: ${message}\n`);
  // exit: broker.source
  return 1;
}

// The checked-in exceptions of the hosted send path's effect inventory (review round 1, finding 1
// and decision B). Every process, socket, network or relay call the host's import closure can
// make either passes `hostedCommit` earlier in its own function, or is listed here with the reason
// it changes nothing outside the process (a read) or is not part of a hosted line's effects. The
// test fails on a site that is neither, and on an entry here that no longer names a site.
//
// Keys are `<file>#<function> <call>`, as `bun test/host/effect-inventory.ts` prints them.

export const READS: Record<string, string> = {
  // The relay package's internals: the closure reaches `dial` and `listen` only through the
  // package's `deliver`/`dial`/`createHostServer`, and every closure call of those is guarded
  // (src/send/relay-stage.ts, src/send/uds.ts sendFrame) or daemon-side and guarded.
  'packages/relay/host/server.js#listen node:net.createServer': 'package internal; reached through createHostServer, whose closure call sites are guarded',
  'packages/relay/index.js#dial node:net.createConnection': 'package internal; reached through deliver/dial, whose closure call sites are guarded',
  // Process-starting runners: their own body, listed through each call of the runner.
  'src/child.ts#run node:child_process.execFile': 'the body of the execText runner; every execText call is listed',
  'src/herdr.ts#runMeasured node:child_process.execFileSync': 'the body of the run runner; every run call is listed (reads by subcommand, or guarded)',
  'src/herdr.ts#shellCaptureExec node:child_process.execFileSync': 'the body of the captureExec runner; every capture call is listed',
  'src/herdr.ts#shellPaneExec node:child_process.execFileSync': 'the body of the paneExec runner (herdr pane read)',
  // Reads: the child, probe or query changes nothing.
  'src/analyse/read.ts#runGitReadOnly node:child_process.spawnSync': 'git, read-only by construction',
  'src/broker/server.ts#probeSocket node:net.connect': 'socket liveness probe; nothing is asked',
  'src/bus/follow.ts#busAnswers node:net.connect': 'bus liveness probe',
  'src/bus/follow.ts#followBus node:net.connect': 'bus subscription: reads events',
  'src/bus/server.ts#probeSocket node:net.connect': 'socket liveness probe; nothing is asked',
  'src/bus/server.ts#subscribeBusOnce node:net.connect': 'bus subscription: reads events',
  'src/client/owner-action-step.ts#headOf node:child_process.execFileSync': 'git rev-parse HEAD',
  'src/commands/answer.ts#version node:child_process.execFileSync': 'a version query',
  'src/commands/doctor.ts#readCommand node:child_process.spawnSync': 'doctor reads a command output',
  'src/commands/git.ts#currentBranch node:child_process.spawn': 'git branch read',
  'src/commands/mcp.ts#probeSocket node:net.connect': 'socket liveness probe',
  'src/commands/mcp.ts#certExpiry node:tls.connect': 'reads a server certificate expiry; sends no request',
  'src/commands/status.ts#branch node:child_process.execFileSync': 'git branch read',
  'src/daemon/health.ts#requestHealth node:net.connect': 'daemon health read',
  'src/daemon/host.ts#probeBusSocket node:net.connect': 'socket liveness probe',
  'src/file/load.ts#findRoot node:child_process.execFileSync': 'git rev-parse root discovery',
  'src/herdr.ts#herdrVersion node:child_process.execFileSync': 'herdr --version',
  'src/herdr.ts#parentPidOf node:child_process.execFileSync': 'ps parent read',
  'src/herdr.ts#hostConfigCheck runner.captureExec(config check)': 'herdr config check: validates, writes nothing',
  'src/herdr.ts#paneRead runner.paneExec(? --format)': 'herdr pane read',
  'src/herdr.ts#paneRead runner.paneExec(full)': 'herdr pane read',
  'src/herdr.ts#paneReadAsync runner.execText(\'herdr\')': 'herdr pane read',
  'src/herdr.ts#paneReadAsync runner.execText(? --format)': 'herdr pane read',
  'src/herdr.ts#shellWaitExec node:child_process.spawn': 'herdr wait agent-status: waits for a state, changes nothing',
  'src/launch/grok-sandbox.ts#gitAnswer node:child_process.execFileSync': 'git rev-parse',
  'src/placement/confined.ts#agentDirs node:child_process.execFileSync': 'placement read',
  'src/placement/confined.ts#unlockedOnDarwin node:child_process.execFileSync': 'placement read',
  'src/process-tools-adapter.ts#exec node:child_process.execFile': 'the process-tools adapter runs only ps, lsof or pgrep',
  'src/process-tools-adapter.ts#execSync node:child_process.execFileSync': 'the process-tools adapter runs only ps, lsof or pgrep',
  'src/process-tools-adapter.ts#spawnSync node:child_process.spawnSync': 'the process-tools adapter runs only ps, lsof or pgrep',
  'src/send/daemon.ts#probeDaemonSocketReading node:net.connect': 'socket liveness probe',
  'src/send/push-adapters/codex-relay.ts#queryCodexAppServerThreadRead node:net.createConnection': 'Codex thread/read query',
  'src/send/push-adapters/relay-runtime.ts#resolveSocketInboundProbe relay.capabilities': 'relay capabilities: a pure table lookup',
  'src/send/push-adapters/relay-runtime.ts#runtimeRelayCapabilities relay.capabilities': 'relay capabilities: a pure table lookup',
  'src/send/session-cli.ts#originRepoOf node:child_process.spawnSync': 'git remote read',
  // The host's and the client's own bookkeeping, not a hosted line's effect.
  'src/host/client.ts#tryHost node:net.connect': 'runs in the client process, never in a hosted line',
  'src/host/run.ts#runHostedLine process.chdir': "the host sets the client's cwd for the line and restores its own",
  'src/host/server.ts#liveListener node:net.connect': "the host's own stale-socket probe, before any request",
  'src/host/server.ts#startSendHost node:net.createServer': "the host's own socket, before any request",
  'src/host/supervise.ts#probeSendHost node:net.connect': 'daemon side: the watchdog probe',
  'src/host/supervise.ts#start node:child_process.spawn': 'daemon side: starts the host',
};

/** Raw file-changing `node:fs` imports allowed in the closure, with the reason. */
export const RAW_FS: Record<string, string> = {
  'src/host/main.ts: appendFileSync from node:fs': "the host's own log, outside the line's effects",
  'src/host/server.ts: chmodSync from node:fs': "the host's own socket mode, before any request",
  'src/host/server.ts: unlinkSync from node:fs': "the host's own stale socket, before any request or at close",
  'packages/relay/index.js: chmodSync from node:fs': 'package internal; entered only through the guarded relayStage/relayDeliver/sendFrame',
  'packages/relay/index.js: linkSync from node:fs': 'package internal; entered only through the guarded relayStage/relayDeliver/sendFrame',
  'packages/relay/index.js: mkdirSync from node:fs': 'package internal; entered only through the guarded relayStage/relayDeliver/sendFrame',
  'packages/relay/index.js: openSync from node:fs': 'package internal; entered only through the guarded relayStage/relayDeliver/sendFrame',
  'packages/relay/index.js: unlinkSync from node:fs': 'package internal; entered only through the guarded relayStage/relayDeliver/sendFrame',
  'packages/relay/index.js: writeFileSync from node:fs': 'package internal; entered only through the guarded relayStage/relayDeliver/sendFrame',
};

/** Namespace imports of the raw modules: only the guarded modules themselves. */
export const NAMESPACE: Record<string, string> = {
  'src/host/guarded-fs.ts: namespace import of node:fs': 'the guarded wrappers',
  'src/host/guarded-fs-promises.ts: namespace import of node:fs/promises': 'the guarded wrappers',
};

/** Non-literal dynamic imports. */
export const DYNAMIC: Record<string, string> = {
  'src/profiles/module-loader.ts#loadProfileModule': 'loads a profile module a profile names; every module named in src/profiles/*.yaml is walked as an inventory entry of its own',
};

/** Closure modules that bind C functions through FFI, with what they bind and why it is safe. */
export const FFI: Record<string, string> = {
  'src/process-kernel.ts': 'proc_pidinfo/sysctl/sandbox_check: kernel process reads',
  'src/host/peer.ts': 'getsockopt/proc_pidinfo/sandbox_check: socket peer and process reads',
  'src/herdr-direct.ts': 'socket/connect/write/read to herdr for the read methods directRequestOf admits only (agent list, workspace list, pane process-info, pane get, pane list)',
  'src/bus/relative-read.ts': 'openat with O_RDONLY only: a link-free read walk',
  'src/lock/flock.ts': 'flock on a descriptor its caller opened; a lock file opened for writing passes the guard at its open',
  'src/send/drop-retention.ts': 'openat/mkdirat/renameat/unlinkat: every changing call and every writing openat passes hostedCommit in guardedDirOps',
};

/** Packages the closure imports. */
export const PACKAGES: Record<string, string> = {};

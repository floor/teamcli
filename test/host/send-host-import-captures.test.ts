// The warm send host keeps the modules of the send path loaded across requests, so anything those
// modules read from the environment or the folder while they load is the host's, not the
// request's (rfc-bus-send-server §2.4). This audit walks the import closure of `send`, `reply` and
// `ack` with the TypeScript parser and lists every read of `homedir()`, `tmpdir()`,
// `process.cwd()`, `userInfo()` or `process.env` that runs at module load: in a top-level
// initializer, outside any function, arrow or method body. Each one must be listed below with the
// variable it depends on, and every such variable must be one the host compares before it serves a
// line (`IMPORT_TIME_ENV`). A new capture fails here until someone classifies it.
//
// It also lists every module-level mutable binding (`let`, `var`, or a `const` holding a `Map`,
// `Set` or `WeakMap`) in that closure, each with the class that makes it safe to keep between
// requests. A new one fails here until it is classified.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { IMPORT_TIME_ENV } from '../../src/host/run.ts';

const ROOT = resolve(import.meta.dir, '..', '..');
const ENTRIES = ['src/commands/send.ts', 'src/commands/reply.ts', 'src/commands/ack.ts', 'src/host/run.ts'];

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}/index.ts`, `${base}.js`, `${base}/index.js`]) {
    if (existsSync(candidate) && !candidate.endsWith('/')) {
      try { if (readFileSync(candidate)) return candidate; } catch { /* a folder */ }
    }
  }
  return null;
}

/** Static imports only: a dynamic `import()` inside a function loads when it runs, and what it
 *  loads is then in the closure through its own static imports, which the walk reaches from it. */
function closure(): string[] {
  const seen = new Set<string>();
  const stack = ENTRIES.map((entry) => resolve(ROOT, entry));
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
        const next = resolveImport(file, node.moduleSpecifier.text);
        if (next !== null) stack.push(next);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [arg] = node.arguments;
        if (arg !== undefined && ts.isStringLiteral(arg)) {
          const next = resolveImport(file, arg.text);
          if (next !== null) stack.push(next);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...seen].sort();
}

const isBody = (node: ts.Node): boolean =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
  || ts.isGetAccessor(node) || ts.isSetAccessor(node) || ts.isConstructorDeclaration(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node);

function captureName(node: ts.Node): string | null {
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
    if (name === 'homedir' || name === 'tmpdir' || name === 'userInfo') return `${name}()`;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'cwd' && ts.isIdentifier(callee.expression) && callee.expression.text === 'process') return 'process.cwd()';
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'env' && ts.isIdentifier(node.expression) && node.expression.text === 'process') return 'process.env';
  return null;
}

function scan(file: string): { captures: string[]; mutable: string[] } {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const rel = relative(ROOT, file);
  const captures: string[] = [];
  const mutable: string[] = [];
  const walk = (node: ts.Node): void => {
    if (isBody(node)) return;
    const name = captureName(node);
    if (name !== null) captures.push(`${rel}: ${name}`);
    ts.forEachChild(node, walk);
  };
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      const flags = statement.declarationList.flags;
      for (const decl of statement.declarationList.declarations) {
        const id = decl.name.getText(source);
        const isConst = (flags & ts.NodeFlags.Const) !== 0;
        const init = decl.initializer;
        const collection = init !== undefined && ts.isNewExpression(init) && ts.isIdentifier(init.expression) && ['Map', 'Set', 'WeakMap', 'WeakSet'].includes(init.expression.text);
        if (!isConst || collection) mutable.push(`${rel}: ${id}`);
      }
    }
    if (ts.isImportDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
    walk(statement);
  }
  return { captures, mutable };
}

/** Each module-load read of the environment, and the variable it depends on. */
const CAPTURES: Record<string, string> = {
  'src/commands/ack.ts: homedir()': 'HOME',
  'src/commands/messages.ts: homedir()': 'HOME',
  'src/commands/reply.ts: homedir()': 'HOME',
  'src/commands/send.ts: tmpdir()': 'TMPDIR',
  'src/commands/send.ts: homedir()': 'HOME',
  'src/send/daemon.ts: tmpdir()': 'TMPDIR',
  'src/send/daemon.ts: homedir()': 'HOME',
};

/** Each module-level mutable binding of the closure, and why keeping it between requests is safe:
 *  `constant` (filled once at load, never written after), `content` (keyed and checked by file
 *  content, stamp or identity), `reset` (cleared by the host around each request), `test` (a test
 *  seam, never set in production), `process` (about this process itself: the host's own binding,
 *  counters, locks it holds), `request` (the request scope itself). */
const MUTABLE: Record<string, string> = {
  'src/approve/fingerprint.ts: SEAT_FREE_FIELDS': 'constant',
  'src/approve/fingerprint.ts: LEGACY_SEAT_FREE_FIELDS': 'constant',
  'src/bus/kinds.ts: EVENT_KIND_SET': 'constant',
  'src/bus/kinds.ts: OWNER_PROMPT_SET': 'constant',
  'src/bus/kinds.ts: OWNER_AT_ONCE_SET': 'constant',
  'src/bus/log-settings.ts: settingsCache': 'content',
  'src/bus/log.ts: ALLOWED_PAYLOAD_KEYS': 'constant',
  'src/bus/log.ts: readCheckpoints': 'content',
  'src/bus/log.ts: readIndexes': 'content',
  'src/bus/log.ts: sealSetChecks': 'content',
  'src/bus/log.ts: hydratedStores': 'content',
  'src/bus/log.ts: appendIndexes': 'content',
  'src/bus/log.ts: appendIndexFileReads': 'process',
  'src/bus/log.ts: appendIndexLineReads': 'process',
  'src/bus/log.ts: appendIndexBytesRead': 'process',
  'src/bus/log.ts: heldEventLocks': 'process',
  'src/bus/log.ts: eventLockYielding': 'process',
  'src/bus/log.ts: sealAppendChecks': 'content',
  'src/bus/reconcile.ts: activeAsyncPasses': 'process',
  'src/bus/refusals.ts: fallbackLogged': 'process',
  'src/bus/relative-read.ts: ffi': 'process',
  'src/bus/server.ts: SOCKET_PUBLISH_KINDS': 'constant',
  'src/bus/webhook.ts: UNSENT_CODES': 'constant',
  'src/caller.ts: cachedAncestorsSnapshotId': 'reset',
  'src/caller.ts: cachedDefaultAncestors': 'reset',
  'src/caller.ts: cachedCallerSnapshotId': 'reset',
  'src/caller.ts: cachedCallerSourcesRef': 'reset',
  'src/caller.ts: cachedCurrentCallers': 'reset',
  'src/client/approval-card.ts: CHANGED': 'constant',
  'src/client/grant-prompt.ts: SEAT_OPS': 'constant',
  'src/client/inbox.ts: DELIVERED_OUTCOMES': 'constant',
  'src/client/owner-action.ts: EXACT_ANSWER_ACTIONS': 'constant',
  'src/client/send.ts: CLIENT_VALUE_OPTIONS': 'constant',
  'src/client/send.ts: CLIENT_FLAG_OPTIONS': 'constant',
  'src/commands/messages.ts: unackedStampCache': 'content',
  'src/config/team-record.ts: RESERVED_SEGMENTS': 'constant',
  'src/diagnostics/beat-work.ts: observers': 'process',
  'src/diagnostics/child-steps.ts: observers': 'process',
  'src/file/load.ts: gitRootHold': 'content',
  'src/file/load.ts: gitAnsweredHook': 'test',
  'src/file/load.ts: gitRootReads': 'process',
  'src/herdr-direct.ts: bound': 'process',
  'src/herdr-direct.ts: nextId': 'process',
  'src/herdr.ts: customRun': 'test',
  'src/herdr.ts: runGeneration': 'process',
  'src/herdr.ts: activeSnapshot': 'reset',
  'src/herdr.ts: nextSnapshotId': 'process',
  'src/herdr.ts: customCapture': 'test',
  'src/herdr.ts: syncReadLimitMs': 'test',
  'src/herdr.ts: captureExec': 'test',
  'src/herdr.ts: paneExec': 'test',
  'src/herdr.ts: waitExec': 'test',
  'src/host/request-scope.ts: active': 'request',
  'src/host/request-scope.ts: guard': 'request',
  // The deferred work a hosted line left running: drained (bounded) by the host after each request,
  // and a host whose set is not empty recycles.
  'src/host/request-scope.ts: deferred': 'request',
  'src/host/run.ts: SEND_FLAGS_WITH_VALUE': 'constant',
  'src/host/run.ts: SEND_FLAGS': 'constant',
  'src/host/run.ts: REPLY_FLAGS': 'constant',
  'src/host/run.ts: ACK_FLAGS': 'constant',
  'src/launch/cli-scope.ts: SHELLS': 'constant',
  'src/launch/cli-scope.ts: POSIX_SHELLS': 'constant',
  'src/launch/command-guard.ts: LAUNCHCTL_READ': 'constant',
  'src/launch/command-guard.ts: SYSTEMCTL_READ': 'constant',
  'src/launch/command-guard.ts: LOGINCTL_READ': 'constant',
  'src/launch/command-guard.ts: GH_TAKES_VALUE': 'constant',
  'src/launch/command-guard.ts: GH_WRITE_METHODS': 'constant',
  'src/launch/command-guard.ts: GH_READ_RUN': 'constant',
  'src/launch/command-guard.ts: GH_READ_WORKFLOW': 'constant',
  'src/launch/deliver.ts: DIALOGS': 'constant',
  'src/launch/line.ts: SHELLS': 'constant',
  'src/launch/restore-proof.ts: RESTORE_DIALOGS': 'constant',
  'src/launchers/shipped.ts: READ_ONLY_ROLES': 'constant',
  'src/leads-authority.ts: LEADS_AUTHORITY_EXCLUDED': 'constant',
  'src/lock/flock.ts: flockImpl': 'process',
  'src/log.ts: reported': 'process',
  'src/mcp/channel.ts: heldClaims': 'process',
  'src/mcp/channel.ts: heldCommits': 'process',
  'src/mcp/inbox.ts: pendingMarkerCache': 'content',
  'src/mcp/inbox.ts: verifiedRecordCache': 'content',
  'src/output/text.ts: RESERVED_NOTE_PREFIXES': 'constant',
  'src/permissions/grants.ts: seatGrantTeamRevocations': 'content',
  'src/permissions/grants.ts: lockSequence': 'process',
  'src/process-kernel.ts: bound': 'process',
  'src/process-kernel.ts: override': 'test',
  'src/profiles/trust-answer.ts: captures': 'constant',
  'src/registry/agents.ts: parsedAgentFiles': 'content',
  'src/registry/locks.ts: held': 'process',
  'src/run-memo.ts: activeMemo': 'reset',
  'src/run-memo.ts: activeDepth': 'reset',
  'src/secrets/store-linux.ts: PAY_PER_USE': 'constant',
  'src/send/daemon.ts: DIALOG': 'constant',
  'src/send/deliver.ts: DIALOGS': 'constant',
  'src/send/delivery.ts: inboxLedChains': 'content',
  'src/send/fallback-events.ts: markerCache': 'content',
  'src/send/legacy-inbox-retention.ts: inProcess': 'process',
  'src/send/pending.ts: FALLBACK_LEGS': 'constant',
  'src/send/record.ts: receiptStampCache': 'content',
  'src/send/record.ts: keyPrintMemo': 'content',
  'src/send/record.ts: KNOWN_READER': 'constant',
  'src/send/record.ts: UNNAMED_READER': 'constant',
  'src/send/unread-hint.ts: reported': 'process',
  'src/session-names.ts: INHERITED_SESSION_NAMES': 'constant',
  'src/state.ts: readStateCalls': 'process',
  'src/watch/screen-core.ts: SCREEN_KINDS': 'constant',
};

describe('the send path at module load', () => {
  const files = closure();
  const found = files.map(scan);
  const captures = found.flatMap((one) => one.captures);
  const mutable = found.flatMap((one) => one.mutable);

  test('every module-load read of the environment is listed with its variable', () => {
    const unlisted = captures.filter((hit) => !(hit in CAPTURES));
    expect(unlisted).toEqual([]);
  });

  test('every listed variable is one the host compares before it serves a line', () => {
    for (const variable of new Set(Object.values(CAPTURES))) {
      expect(IMPORT_TIME_ENV as readonly string[]).toContain(variable);
    }
  });

  test('every module-level mutable binding is classified', () => {
    const unlisted = mutable.filter((hit) => !(hit in MUTABLE));
    expect(unlisted).toEqual([]);
  });

  test('the closure is the send path, not a stub', () => {
    expect(files.length).toBeGreaterThan(100);
  });
});

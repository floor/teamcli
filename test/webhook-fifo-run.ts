// A FIFO at either webhook path must be refused, not waited on. openSync without O_NONBLOCK
// blocks until a writer opens the FIFO, and it blocks before the descriptor's type is ever
// checked — so the route read never returns, and with it the bus's fanOut, which calls the
// delivery callback synchronously. This child is its own process so the pre-fix block cannot
// hang the suite: the scene in test/bus-webhook-adapter.test.ts kills the child at a short bound
// and asserts the facts it prints.
//
// Bun 1.4.2 on macOS, measured before the fix: a child that called
// openSync(fifo, O_RDONLY|O_NOFOLLOW) was still waiting when killed at 700 ms (SIGKILL, no
// output); the same child with O_RDONLY|O_NOFOLLOW|O_NONBLOCK returned a descriptor in ~50 ms
// (process start included), fstat said isFIFO true and isFile false, and a regular file read its
// bytes through the same flags.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishToBus, startBus } from '../src/bus/server.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { webhookRouteOf } from '../src/send/webhook.ts';

const SECRET = 'synthetic-fifo-secret';

function regular(path: string, text: string, mode: number): string {
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return path;
}

const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-webhook-fifo-')));
let bus: { close(): Promise<void> } | null = null;
try {
  const urlFifo = join(base, 'hook-url.fifo');
  const secretFifo = join(base, 'hook-secret.fifo');
  const made = spawnSync('mkfifo', [urlFifo, secretFifo], { encoding: 'utf8' });
  if (made.status !== 0) {
    console.log(JSON.stringify({ mkfifo: false, error: (made.stderr ?? '').trim() }));
    process.exit(1);
  }
  const goodUrl = regular(join(base, 'hook-url'), 'http://127.0.0.1:1/routine\n', 0o644);
  const goodSecret = regular(join(base, 'hook-secret'), `${SECRET}\n`, 0o600);

  const timedRoute = (webhook: { urlFile: string; secretFile: string }) => {
    const started = Date.now();
    const route = webhookRouteOf(webhook);
    const elapsedMs = Date.now() - started;
    const refused = route !== null && !route.ok;
    const reason = refused ? route.reason : '';
    return {
      refused,
      reason,
      elapsedMs,
      namesKind: reason.includes('not a regular file') && reason.includes('FIFO'),
      echoesSecret: reason.includes(SECRET),
    };
  };
  const urlFifoRead = timedRoute({ urlFile: urlFifo, secretFile: goodSecret });
  const secretFifoRead = timedRoute({ urlFile: goodUrl, secretFile: secretFifo });

  // The bus itself: a FIFO secret on the seat's adapter row, and one accepted arrival fanned
  // out to it. fanOut calls the delivery callback synchronously, so the publish answer can only
  // be written once that callback has returned.
  const text = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: remote
    name: iris
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
    webhook:
      url_file: ${JSON.stringify(goodUrl)}
      secret_file: ${JSON.stringify(secretFifo)}
`;
  const parsed = validateTeamFile(text);
  if (!parsed.ok) {
    console.log(JSON.stringify({ mkfifo: true, teamOk: false, errors: parsed.errors.map((problem) => problem.message) }));
    process.exit(1);
  }
  const root = join(base, 'acme');
  const lines: string[] = [];
  const started = await startBus({
    root,
    team: parsed.team,
    home: base,
    stderr: (line) => lines.push(line),
    reconcileIntervalMs: 0,
  });
  if (started.kind !== 'serving') {
    console.log(JSON.stringify({ mkfifo: true, teamOk: true, bus: started.kind }));
    process.exit(1);
  }
  bus = started.handle;
  const publishStarted = Date.now();
  const outcome = await publishToBus(
    root,
    { ts: '2026-11-01T00:00:00.000Z', kind: 'message.arrived', session: 'acme', record_id: 'msg-1', from: 'lead', to: 'iris' },
    { deadlineMs: 4000 },
  );
  const elapsedMs = Date.now() - publishStarted;
  const report = lines.join('\n');

  console.log(
    JSON.stringify({
      mkfifo: true,
      teamOk: true,
      urlFifoRead,
      secretFifoRead,
      fanOut: {
        outcome: outcome.kind,
        elapsedMs,
        refusedInPlainWords:
          report.includes('not posted') &&
          report.includes('not a regular file') &&
          report.includes('FIFO') &&
          report.includes('the drop file stays in place'),
        echoesSecret: report.includes(SECRET),
        lines,
      },
    }),
  );
} finally {
  if (bus !== null) await bus.close();
  rmSync(base, { recursive: true, force: true });
}

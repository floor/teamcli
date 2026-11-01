// Every command import follows the child-start synthetic HOME proof.
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spyOn } from 'bun:test';
import type { Caller } from '../../src/caller.ts';
import type { StatusSource, StatusWaitSeat } from '../../src/watch/status-events.ts';

type Input = { argv?: string[]; caller?: 'owner' | 'seat' | 'foreign' | 'unplaced' | 'owner-no-tty'; dev?: boolean;
  ops?: string[]; entities?: string[]; text?: string | null; missingMethod?: boolean; missingPane?: boolean;
  missingFile?: boolean; badFile?: boolean };
const [expectedHome, encoded] = process.argv.slice(2);
assert.equal(homedir(), realpathSync(expectedHome!));
const home = homedir();
const input = JSON.parse(encoded!) as Input;
const root = join(dirname(home), 'project');
const dir = join(root, '.agents');
mkdirSync(dir, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
const file = `format: 1
project: lens
session: lens-session
operator: watcher
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: watcher
    leads: true
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: fixture
  - role: worker
    name: subject
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: fixture
  - role: worker
    name: person
    human: true
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: fixture
`;
if (!input.missingFile) writeFileSync(join(dir, 'team.yaml'), input.badFile ? 'format: [broken\n' : file);
const { emptySession, updateState, STATE_FILE, LOG_FILE } = await import('../../src/state.ts');
updateState(dir, state => {
  const session = emptySession();
  session.seats.watcher = { stage: 'ready', pane: 'synthetic-watcher', workspace: 'synthetic-workspace' };
  session.seats.subject = { stage: 'ready', ...(!input.missingPane ? { pane: 'synthetic-subject' } : {}), workspace: 'synthetic-workspace' };
  session.seats.person = { stage: 'ready', pane: 'synthetic-human', workspace: 'synthetic-workspace' };
  state.sessions['lens-session'] = session;
});
const status = await import('../../src/watch/status-events.ts');
const reads: { seat: StatusWaitSeat; lines: number }[] = [];
const factories: unknown[] = [];
const source: StatusSource & { screenText?: (seat: StatusWaitSeat, lines: number) => string | null } = {
  waitStatus: async () => { throw new Error('waitStatus is outside the read-only scene'); },
  notify: () => { throw new Error('notify is outside the read-only scene'); },
  screenText: (seat, lines) => { reads.push({ seat, lines }); return input.text === undefined ? 'VISIBLE_ONLY_MARKER\n' : input.text; },
};
if (input.missingMethod) delete source.screenText;
const stub = spyOn(status, 'herdrStatusSource').mockImplementation(options => { factories.push(options); return source; });
const callers: Record<string, Caller> = {
  owner: { kind: 'owner' }, 'owner-no-tty': { kind: 'owner-no-tty' },
  seat: { kind: 'seat', name: 'watcher', pane: 'synthetic-watcher', session: 'lens-session' },
  foreign: { kind: 'seat', name: 'watcher', pane: 'some-other-pane', session: 'lens-session' },
  unplaced: { kind: 'unplaced', reason: 'synthetic external principal' },
};
const { testIo } = await import('../helpers.ts');
const io = testIo(root, callers[input.caller ?? 'owner']);
io.env = { HOME: home, ...(input.dev ? { TEAMCLI_DEV_MODE: '1' } : {}) };
let argv = input.argv ?? ['subject'];
if (input.ops !== undefined) {
  const { issueOwnerGeneralGrant } = await import('../../src/client/general-grant.ts');
  const { newClientKeyPair, clientKeyDir, writeClientKeyFiles } = await import('../../src/client/records.ts');
  const pair = newClientKeyPair();
  const key = writeClientKeyFiles(clientKeyDir(home, 'peek-fixture'), pair);
  assert.equal(key.ok, true); if (!key.ok) throw new Error(key.why);
  const issued = issueOwnerGeneralGrant(home, { clientId: 'peek-fixture', publicKey: pair.publicKey,
    entities: input.entities ?? ['*'], ops: input.ops as Parameters<typeof issueOwnerGeneralGrant>[1]['ops'], mayIssue: false,
    expires: new Date(Date.now() + 86_400_000) });
  assert.equal(issued.ok, true); if (!issued.ok) throw new Error(issued.why);
  argv = [...argv, '--general', issued.path, '--key', key.keyPath];
}
const beforeState = readFileSync(join(dir, STATE_FILE), 'utf8');
const beforeFiles = readdirSync(dir).sort();
const { main } = await import('../../src/cli.ts');
let code: number;
try { code = await main(['peek', ...argv], io); }
finally { stub.mockRestore(); }
const log = existsSync(join(dir, LOG_FILE)) ? readFileSync(join(dir, LOG_FILE), 'utf8') : '';
console.log(JSON.stringify({ code, out: io.out, err: io.err, home, log, reads, factories,
  stateUnchanged: beforeState === readFileSync(join(dir, STATE_FILE), 'utf8'),
  configUnchanged: input.missingFile || readFileSync(join(dir, 'team.yaml'), 'utf8') === (input.badFile ? 'format: [broken\n' : file),
  newFiles: readdirSync(dir).sort().filter(name => !beforeFiles.includes(name)),
}));

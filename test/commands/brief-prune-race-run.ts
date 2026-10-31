// `brief prune` lists the seat's retry markers and then re-reads the claim: a launch that
// publishes a newer claim and its marker between the two reads must leave the run retiring
// nothing. This run stands that launch in at the readPending seam — the first listing call
// writes the newer claim and its marker through the real state and marker code — so the
// window the recheck closes is the one the command actually walks. Run as its own process so
// the seam is in place before the command loads.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'bun:test';
import { GENERAL_BRIEF_FROM, GENERAL_BRIEF_SHA256, generalBriefBody, generalBriefId } from '../../src/launch/general-brief.ts';
import * as realPending from '../../src/send/pending.ts';
import { emptySession, updateState } from '../../src/state.ts';

// The mock below replaces the module's export, and the namespace's binding follows it: the real
// functions are taken by value first, so the seam delegates to the code the command would run.
const readPendingReal = realPending.readPending;
const markPendingReal = realPending.markPending;

const NOW = new Date('2026-10-19T09:00:00Z');
const NOW_ISO = NOW.toISOString();
const INC = 'inc_0123456789ab';
const INC_NEWER = 'inc_ba9876543210';
const EPOCH = 'run_0123456789ab';
const BODY = generalBriefBody();
const ID_OLD = generalBriefId(INC, BODY, 1);
const ID_NEWER = generalBriefId(INC_NEWER, BODY);

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-brief-prune-race-')));
const root = join(base, 'acme');
const dir = join(root, '.agents');
const home = join(base, 'home');
mkdirSync(dir, { recursive: true });
mkdirSync(home);
execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
writeFileSync(join(dir, 'team.yaml'), TEAM);

// The seat as its launch left it, holding one claim and one marker of an earlier delivery: the
// run has something to retire, which is when the second claim read matters.
updateState(dir, (state) => {
  const session = (state.sessions.acme ??= emptySession());
  session.seats = { ...(session.seats ?? {}), lead: { stage: 'ready' as const, pane: 'fixture-pane-1' } };
  session.briefs = {
    ...(session.briefs ?? {}),
    lead: {
      id: generalBriefId(INC, BODY),
      at: NOW_ISO,
      incarnation: INC,
      epoch: EPOCH,
      sha256: GENERAL_BRIEF_SHA256,
      attempt: 0,
      stage: 'ready' as const,
    },
  };
});
const dropDir = join(dir, 'send-drops', 'acme', 'lead');
mkdirSync(dropDir, { recursive: true });
markPendingReal(dropDir, {
  id: ID_OLD,
  from: GENERAL_BRIEF_FROM,
  to: 'lead',
  body: BODY,
  ts: new Date(NOW.getTime() - 60_000).toISOString(),
});

let published = false;
mock.module('../../src/send/pending.ts', () => ({
  ...realPending,
  // The first listing is the seam: a launch publishes its newer claim, then the marker its
  // delivery walks beside the record. Both writes are the real ones, made while the run reads.
  readPending: (folder: string) => {
    if (!published) {
      published = true;
      updateState(dir, (state) => {
        const session = (state.sessions.acme ??= emptySession());
        session.briefs = {
          ...(session.briefs ?? {}),
          lead: {
            id: ID_NEWER,
            at: NOW_ISO,
            incarnation: INC_NEWER,
            epoch: EPOCH,
            sha256: GENERAL_BRIEF_SHA256,
            attempt: 0,
            stage: 'ready' as const,
          },
        };
      });
      markPendingReal(folder, {
        id: ID_NEWER,
        from: GENERAL_BRIEF_FROM,
        to: 'lead',
        body: BODY,
        ts: NOW_ISO,
      });
    }
    return readPendingReal(folder);
  },
}));

const { runBrief } = await import('../../src/commands/brief.ts');
const { testIo } = await import('../helpers.ts');

const io = testIo(root, { kind: 'seat', name: 'lead', pane: 'fixture-pane-1', session: 'acme' });
const code = await runBrief(['prune', '--apply'], io, { home, now: () => NOW });
const oldMarkerRemains = existsSync(join(dropDir, `${ID_OLD}.pending`));
const newerMarkerRemains = existsSync(join(dropDir, `${ID_NEWER}.pending`));
console.log(JSON.stringify({ code, out: io.out, err: io.err, oldMarkerRemains, newerMarkerRemains }));
rmSync(base, { recursive: true, force: true });

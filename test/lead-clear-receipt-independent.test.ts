// An unsigned or forged read receipt raises no bus step. A receipt the checkout
// key signed, naming the team's lead, still settles as that clearance.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, test, afterEach } from 'bun:test';
import { createReconcileState, reconcilePass } from '../src/bus/reconcile.ts';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
import { receiptFile, signReceiptPayload, writeReceipt } from '../src/send/record.ts';
import { updateState } from '../src/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv } from './helpers.ts';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const SESSION = 'home-session';
const PROJECT = 'home-team';
const UNSIGNED_ID = '66666666-7777-4888-8999-000000000001';
const FORGED_ID = '77777777-8888-4999-8000-000000000002';
const EMPTY_ID = '88888888-9999-4000-8000-000000000003';
const SIGNED_ID = '99999999-0000-4000-8000-000000000004';
const BODY = 'fixture note for the seat\n\nthe second line';

const TEAM = `format: 1
project: ${PROJECT}
coordinator: keeper
operator: keeper
session: ${SESSION}
workspace:
  mode: shared
seats:
  - role: lead
    name: keeper
    label: keeper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
`;

let scratchParent: string | undefined;
const made: string[] = [];

afterEach(() => {
  discardFixtures(made.splice(0), { roots: scratchParent === undefined ? [] : [scratchParent] });
});

function world() {
  const base = fixtureBase('lead-receipt-');
  scratchParent ??= dirname(base);
  made.push(base);
  const root = join(base, PROJECT);
  const home = join(base, 'h');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), TEAM);
  updateState(dir, (state) => {
    state.sessions[SESSION] = {
      seats: { keeper: { stage: 'ready', pane: 'fixture-pane-one' } },
      worktrees: {},
    };
  });
  return { root, home };
}

function plant(home: string, root: string, id: string): string {
  plantRecord(home, root, SESSION, 'worker', id, BODY, { at: NOW.toISOString(), from: 'keeper' });
  return recordDir(root, SESSION, 'worker');
}

function readsOf(root: string, home: string, state = createReconcileState()) {
  const pass = reconcilePass({ project: PROJECT, root, session: SESSION, home, now: NOW, state });
  expect(pass.ok, pass.ok ? '' : pass.reason).toBe(true);
  if (!pass.ok) return [];
  return pass.raised.filter((event) => event.payload.kind === 'message.read');
}

describe('a read receipt the key did not sign', () => {
  test('an unsigned file naming the lead, and a forged signature, raise no read', () => {
    const { root, home } = world();
    const unsignedDir = plant(home, root, UNSIGNED_ID);
    const forgedDir = plant(home, root, FORGED_ID);
    const emptyDir = plant(home, root, EMPTY_ID);
    const signedDir = plant(home, root, SIGNED_ID);
    const payload = (id: string) => ({
      kind: 'receipt' as const, status: 'read' as const, id, to: 'worker', root, session: SESSION,
      at: NOW.toISOString(), read_by: 'lead-ack:keeper',
    });
    writeFileSync(receiptFile(unsignedDir, UNSIGNED_ID, 'read'), `${JSON.stringify({ payload: payload(UNSIGNED_ID) })}\n`);
    writeFileSync(receiptFile(forgedDir, FORGED_ID, 'read'), `${JSON.stringify({ payload: payload(FORGED_ID), signature: 'forged' })}\n`);
    writeFileSync(receiptFile(emptyDir, EMPTY_ID, 'read'), '{}\n');
    const signed = signReceiptPayload(payload(SIGNED_ID), home);
    expect(writeReceipt(signedDir, signed, home).ok).toBe(true);

    const state = createReconcileState();
    const first = readsOf(root, home, state);
    const second = readsOf(root, home, state);
    const text = JSON.stringify([...first, ...second]);
    expect(text).not.toContain(UNSIGNED_ID);
    expect(text).not.toContain(FORGED_ID);
    expect(text).not.toContain(EMPTY_ID);
    expect(text).not.toContain('delivered (read)');
    expect(JSON.stringify(first)).toContain('cleared by keeper');
    expect(second.filter((event) => JSON.stringify(event).includes(SIGNED_ID))).toEqual([]);
  });
});

// The CLI mailbox reader (`team drops --read`) writes the signed read receipt only after the
// body has been handed to stdout. A hand-over that throws leaves the message unread. Synthetic
// team, home and pane only.
import { expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDrops } from '../src/commands/drops.ts';
import { plantRecord } from '../src/commands/messages.ts';
import { receiptPath } from '../src/mcp/inbox.ts';
import { updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const ID = '4e9f1a5b-b263-4ea0-9a71-5c6d7e8f9a0b';

function scene(): { root: string; home: string; dropDir: string; cleanup(): void } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-drop-receipt-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  execSync('git init -q -b main', { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: codex
    vendor: test
    model: Grok
    version: "4.7"
    launch: codex
`);
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = { seats: { lead: { stage: 'ready', pane: 'pane-lead' } } } as never;
  });
  const dropDir = join(root, '.agents', 'send-drops', 'acme', 'lead');
  plantRecord(home, root, 'acme', 'lead', ID, 'hello from the mailbox');
  return { root, home, dropDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('the read receipt is absent while the body is handed over, and present after', async () => {
  const at = scene();
  try {
    const receipt = receiptPath(at.dropDir, ID);
    let existedDuringHandover = true;
    const io = testIo(at.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
    io.stdout = (text) => {
      existedDuringHandover = existsSync(receipt);
      io.out += text;
    };
    const code = await runDrops(['--read', '--seat', 'lead', '--session', 'acme'], io, { home: at.home });
    expect(code, io.err).toBe(0);
    expect(io.out).toContain('hello from the mailbox');
    expect(existedDuringHandover).toBe(false);
    expect(existsSync(receipt)).toBe(true);
  } finally {
    at.cleanup();
  }
});

test('a hand-over that throws leaves no read receipt', async () => {
  const at = scene();
  try {
    const receipt = receiptPath(at.dropDir, ID);
    const io = testIo(at.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
    io.stdout = () => {
      throw new Error('the seat did not receive the body');
    };
    await expect(runDrops(['--read', '--seat', 'lead', '--session', 'acme'], io, { home: at.home })).rejects.toThrow('the seat did not receive the body');
    expect(existsSync(receipt)).toBe(false);
  } finally {
    at.cleanup();
  }
});

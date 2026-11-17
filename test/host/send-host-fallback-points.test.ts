// The fallback points sit at the last instant before an effect the warm send host must not make
// (rfc-bus-send-server §2.5): the placement repair, a charter's admission, an owner-seat rule's
// claim and the owner as acting principal. The guard's own behaviour is pinned in
// send-host-guard.test.ts; this file pins where the points stand in the source, so a refactor that
// moves an effect ahead of its point, or a catch that swallows the hand-back, fails here.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const read = (file: string): string => readFileSync(resolve(ROOT, file), 'utf8');

/** The code lines (comments dropped) right before the first line matching `effect`. */
function before(file: string, effect: RegExp, count = 1): string[] {
  const lines = read(file).split('\n');
  const at = lines.findIndex((line) => effect.test(line));
  expect(at).toBeGreaterThan(0);
  const code: string[] = [];
  for (let i = at - 1; i >= 0 && code.length < count; i--) {
    const line = lines[i]!.trim();
    if (line === '' || line.startsWith('//')) continue;
    code.push(line);
  }
  return code;
}

describe('the fallback points stand right before their effects', () => {
  test('placement repair: the host hands back before the name is put back', () => {
    expect(before('src/caller.ts', /reapplyHerdrName\(\{ session, pane: agent\.pane/)[0]).toMatch(/^hostedFallbackPoint\(/);
  });

  test("a charter's admission is handed back before it is returned", () => {
    expect(before('src/client/owner-action-step.ts', /return \{ kind: 'admitted', admission: \{ ok: true, via: 'charter'/)[0]).toMatch(/^hostedFallbackPoint\(/);
  });

  test("an owner-seat rule is handed back before its claim, and the catch does not swallow it", () => {
    expect(before('src/client/owner-action-step.ts', /return admitOwnerActionByRule\(home, \{ action, root/)[0]).toMatch(/^hostedFallbackPoint\(/);
    const text = read('src/client/owner-action-step.ts');
    const claim = text.indexOf('return admitOwnerActionByRule(home, { action, root');
    const tail = text.slice(claim, claim + 400);
    expect(tail).toMatch(/catch \(error\) \{\s*if \(error instanceof HostedFallback \|\| error instanceof HostedStoppedAfterEffect\) throw error;/);
  });

  test('the owner as acting principal is handed back before it is chosen', () => {
    expect(before('src/commands/send.ts', /const acting: Caller = seatApproved && !leadsLift \? \{ kind: 'owner' \} : caller;/)[0])
      .toMatch(/^if \(seatApproved && !leadsLift\) hostedFallbackPoint\(/);
  });

  test('the herdr writes and the record writes are effect funnels', () => {
    const herdr = read('src/herdr.ts');
    for (const name of ['agentRename', 'paneRun', 'typeText', 'sendKey', 'reportDisplayAgent', 'workspaceCreate']) {
      expect(herdr).toMatch(new RegExp(`export (async )?function ${name}\\([^]*?\\{\\n  hostedCommit\\('herdr ${name}'\\);`));
    }
    const record = read('src/send/record.ts');
    for (const name of ['writeRecord', 'writeReceipt', 'writeClose']) {
      expect(record).toMatch(new RegExp(`export function ${name}\\([^]*?\\{\\n  hostedCommit\\('${name}'\\);`));
    }
    for (const [file, name] of [['src/log.ts', 'logLine'], ['src/send/history.ts', 'appendHistory'], ['src/state.ts', 'updateState'], ['src/send/uds.ts', 'sendFrame']] as const) {
      expect(read(file)).toMatch(new RegExp(`export function ${name}[^]*?\\{\\n  hostedCommit\\('${name}'\\);`));
    }
  });
});

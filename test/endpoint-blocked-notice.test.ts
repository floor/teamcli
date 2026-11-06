// A Codex endpoint that is not listening produces one signed runtime notice for the lead.
// A later send while it is still down does not write another. Once the endpoint is listening
// again, the next outage can write one more. The notice stays with the drop readers.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { TeamFile } from '../src/file/types.ts';
import { admitChannelDelivery } from '../src/mcp/channel-admit.ts';
import { clearEndpointBlocked, RUNTIME_RULE, writeEndpointBlockedNotice } from '../src/send/endpoint-notice.ts';

const AT = '2026-11-06T16:30:00.000Z';

function world() {
  const base = realpathSync(mkdtempSync('/tmp/endpoint-notice-'));
  const home = join(base, 'home');
  const root = join(base, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  return { base, home, root: realpathSync(root) };
}

const team = { seats: [{ name: 'lead', role: 'coordinator' }] } as TeamFile;

function notices(root: string): string[] {
  const dir = join(root, '.agents', 'send-drops', 'dispatch', 'lead');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => !name.startsWith('.'));
}

describe('a blocked Codex endpoint', () => {
  test('writes one notice until the endpoint is listening again', () => {
    const dir = world();
    try {
      const input = {
        home: dir.home,
        root: dir.root,
        session: 'dispatch',
        lead: 'lead',
        seat: 'worker',
        reason: 'the socket is not listening',
        at: AT,
      };
      expect(writeEndpointBlockedNotice(input)).toBe(true);
      expect(writeEndpointBlockedNotice(input)).toBe(false);
      expect(notices(dir.root)).toHaveLength(1);
      expect(existsSync(join(dir.root, '.agents', 'endpoint-blocked', 'dispatch', 'worker'))).toBe(true);
      clearEndpointBlocked(dir.root, 'dispatch', 'worker');
      expect(writeEndpointBlockedNotice({ ...input, at: '2026-11-06T17:00:00.000Z' })).toBe(true);
      expect(notices(dir.root)).toHaveLength(2);
    } finally {
      rmSync(dir.base, { recursive: true, force: true });
    }
  });

  test('channel admission refuses a runtime notice', () => {
    const dir = world();
    try {
      const refused = admitChannelDelivery({
        payload: { from: 'runtime', from_id: null, to: 'lead', to_id: null, rule: RUNTIME_RULE },
        home: dir.home,
        root: dir.root,
        session: 'dispatch',
        seat: 'lead',
        team,
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.why).toContain('must name its recipient agent id');
    } finally {
      rmSync(dir.base, { recursive: true, force: true });
    }
  });
});

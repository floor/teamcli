// The spike branch's channel push, tested over the server's own streams and a synthetic inbox.
// The push is off unless TEAM_SPIKE_CHANNEL=1; when on, one signed record that arrives after
// startup produces one `notifications/claude/channel`, the record stays for `inbox_read`, and a
// `<id>.channel-push.json` receipt records the unconfirmed write. No herdr, no live team.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenerPath, receiptPath } from '../src/mcp/inbox.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { signRecord } from '../src/send/record.ts';
import { testIo } from './helpers.ts';

const SESSION = 'acme';
const LEAD_ID = '5a1c9e93-819f-4eb3-8f70-1a6db12e4f56';

type Place = { root: string; home: string; dropDir: string; cleanup(): void };

function place(): Place {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-channel-')));
  mkdirSync(join(root, '.agents'));
  mkdirSync(join(root, 'home'), { mode: 0o700 });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
coordinator: lead
operator: lead
session: ${SESSION}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Grok
    version: "4.7"
    launch: claude
`);
  return {
    root,
    home: join(root, 'home'),
    dropDir: join(root, '.agents', 'send-drops', SESSION, 'lead'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function signed(at: Place, id: string, body: string): string {
  mkdirSync(at.dropDir, { recursive: true, mode: 0o700 });
  const record = signRecord({
    kind: 'message',
    id,
    to: 'lead',
    to_id: null,
    root: at.root,
    session: SESSION,
    at: '2026-10-22T12:00:00.000Z',
    body,
    from: 'orchestrator',
    from_id: null,
    rule: 'the coordinator writes to a seat of its team',
    thread: id,
  }, at.home);
  const path = join(at.dropDir, id);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/** A stream the test feeds: `push` one line, `end` closes it, `replies` collects what was written. */
function queue(): {
  lines: AsyncIterable<string>;
  write(line: string): void;
  end(): void;
  replies: string[];
} {
  const pending: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const replies: string[] = [];
  const lines = (async function* () {
    for (;;) {
      if (pending.length > 0) {
        yield pending.shift()!;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();
  const bump = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  return {
    lines,
    write: (line) => replies.push(line),
    end: () => {
      ended = true;
      bump();
    },
    replies,
  };
}

async function waitFor(when: () => boolean): Promise<void> {
  for (let at = 0; at < 60 && !when(); at++) await new Promise((resolve) => setTimeout(resolve, 50));
}

async function withSpike<T>(run: () => Promise<T>): Promise<T> {
  const channel = process.env.TEAM_SPIKE_CHANNEL;
  const frames = process.env.TEAM_SPIKE_FRAMES;
  process.env.TEAM_SPIKE_CHANNEL = '1';
  delete process.env.TEAM_SPIKE_FRAMES;
  try {
    return await run();
  } finally {
    if (channel === undefined) delete process.env.TEAM_SPIKE_CHANNEL;
    else process.env.TEAM_SPIKE_CHANNEL = channel;
    if (frames !== undefined) process.env.TEAM_SPIKE_FRAMES = frames;
  }
}

describe('the spike channel push', () => {
  test('initialize declares claude/channel and never the permission relay', async () => {
    const at = place();
    try {
      const replies: string[] = [];
      const code = await runMcpServe({ seat: 'lead', session: SESSION }, testIo(at.root), {
        lines: (async function* () {
          yield JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
        })(),
        write: (line) => replies.push(line),
      }, { home: at.home });
      expect(code).toBe(0);
      const answer = JSON.parse(replies[0]!) as Record<string, any>;
      expect(answer.result.capabilities).toEqual({ tools: {}, experimental: { 'claude/channel': {} } });
      expect(answer.result.capabilities.experimental['claude/channel/permission']).toBeUndefined();
    } finally {
      at.cleanup();
    }
  });

  test('a signed record that arrives after startup is pushed once, kept, and receipted unconfirmed', async () => {
    await withSpike(async () => {
      const at = place();
      const feed = queue();
      try {
        const running = runMcpServe({ seat: 'lead', session: SESSION }, testIo(at.root), feed, { home: at.home });
        await waitFor(() => existsSync(listenerPath(at.dropDir)));
        expect(feed.replies).toHaveLength(0);
        const body = 'Message from Agamemnon (orchestrator@teamcli): the probe';
        const path = signed(at, LEAD_ID, body);
        await waitFor(() => feed.replies.length > 0);
        expect(feed.replies).toHaveLength(1);
        const push = JSON.parse(feed.replies[0]!) as Record<string, any>;
        expect(push).toMatchObject({
          jsonrpc: '2.0',
          method: 'notifications/claude/channel',
          params: {
            content: body,
            meta: { from: 'orchestrator', seat: 'lead', team: 'acme', id: LEAD_ID },
          },
        });
        // The signed record is untouched and still waiting; only `inbox_read` writes the read receipt.
        expect(readFileSync(path, 'utf8')).toContain('"signature"');
        expect(existsSync(receiptPath(at.dropDir, LEAD_ID))).toBe(false);
        const receiptPathAt = join(at.dropDir, `${LEAD_ID}.channel-push.json`);
        const receipt = JSON.parse(readFileSync(receiptPathAt, 'utf8')) as Record<string, any>;
        expect(receipt).toMatchObject({
          kind: 'channel-push',
          id: LEAD_ID,
          seat: 'lead',
          session: SESSION,
          status: 'sent (unconfirmed)',
        });
        expect(receipt.meta).toEqual({ from: 'orchestrator', seat: 'lead', team: 'acme', id: LEAD_ID });
        expect(statSync(receiptPathAt).mode & 0o777).toBe(0o600);
        // One record, one push: a later tick does not repeat it.
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(feed.replies).toHaveLength(1);
        feed.end();
        expect(await running).toBe(0);
      } finally {
        at.cleanup();
      }
    });
  });

  test('without TEAM_SPIKE_CHANNEL a new record is not pushed', async () => {
    const at = place();
    const feed = queue();
    try {
      const running = runMcpServe({ seat: 'lead', session: SESSION }, testIo(at.root), feed, { home: at.home });
      await waitFor(() => existsSync(listenerPath(at.dropDir)));
      signed(at, LEAD_ID, 'quiet');
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(feed.replies).toHaveLength(0);
      feed.end();
      expect(await running).toBe(0);
    } finally {
      at.cleanup();
    }
  });
});

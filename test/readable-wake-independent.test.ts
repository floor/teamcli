import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stripSgr } from '../src/ansi.ts';
import { runApprove } from '../src/approve/command.ts';
import { runSend } from '../src/commands/send.ts';
import { serveWakeChild } from '../src/daemon/wake/child.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { boxHoldsText } from '../src/launch/deliver.ts';
import { listUnread } from '../src/mcp/inbox.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { socketMessageFrame } from '../src/send/frame.ts';
import { codexPushAdapter } from '../src/send/push-adapters/codex.ts';
import { probeHeadlessResumeRoute } from '../src/send/push-adapters/headless-resume.ts';
import {
  inlineWake,
  oversizedWake,
  recordDeliveredBody,
  RUNTIME_WAKE_MAX,
  TYPED_WAKE_MAX,
} from '../src/send/readable-wake.ts';
import { verifiedRecordAt } from '../src/send/record.ts';
import { deliverTypedWake } from '../src/send/typed-wake.ts';
import { reserveWake, wakePath } from '../src/send/wake-marker.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { dropDir, fake, NOW, owner, world, type World } from './send-native-fixtures.ts';

const idle = stripSgr(
  readFileSync(new URL('./fixtures/codex/0.167.0/idle.txt', import.meta.url), 'utf8'),
);
const working = stripSgr(
  readFileSync(new URL('./fixtures/codex/0.167.0/working.txt', import.meta.url), 'utf8'),
);
const draw = (text: string): string =>
  idle.replace('› Ask Codex to do anything', `› ${text.replaceAll('\n', '\n  ')}`);

function cleanupWorld(w: World): void {
  discardFixtures([dirname(w.root)]);
}

function recordIdsIn(folder: string): string[] {
  return readdirSync(folder).filter((name) => !name.includes('.'));
}

describe('readable message wakes and post-delivery receipt settlement', () => {
  test('Scene 1: socket leg delivers full multiline body and writes no .read.json (a taken frame is not the seat\'s read), and sends explicit read-hint without .read.json when oversized', async () => {
    const w = world(['socket', 'drop']);
    try {
      const settingsPath = cliHookSettingsPath(w.dir, 'acme', 'lead')!;
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ crossSessionInbound: 'accept' }));
      const socketFile = join(w.sockets, '222.sock');
      writeFileSync(socketFile, '');
      const io = owner(w.root);
      const host = fake(w);

      const multilineBody = 'Socket line alpha\nSocket line beta\nSocket line gamma';
      const codeInline = await runSend(['lead', multilineBody], io, host);
      expect(codeInline, io.err + io.out).toBe(0);
      expect(host.frames).toHaveLength(1);

      const parsedInline = JSON.parse(host.frames[0]!) as {
        message: { content: string };
      };
      expect(parsedInline.message.content).toContain('\n\nSocket line alpha\nSocket line beta\nSocket line gamma');
      expect(parsedInline.message.content).not.toContain('Message too long for this wake.');
      // The whole body still ends with the reader line: the id the seat answers it by.
      const inlineId = recordIdsIn(dropDir(w.dir, 'lead'))[0]!;
      expect(parsedInline.message.content.endsWith(`\n\n↩ team reply ${inlineId.slice(0, 8)} "…" · team ack ${inlineId.slice(0, 8)}`)).toBe(true);

      const leadDrops = dropDir(w.dir, 'lead');
      expect(readdirSync(leadDrops).some((name) => name.endsWith('.read.json'))).toBe(false);
      expect(listUnread(leadDrops, { root: w.root, session: 'acme', to: 'lead' }, w.home)).toHaveLength(1);

      // Compact socket frame formatting preserves multiline body breaks rather than collapsing whitespace.
      const compactFrame = JSON.parse(
        socketMessageFrame('acme', 'lead', 'Row 1\nRow 2\nRow 3', 'synthetic-id', {
          from: 'owner',
          compact: true,
        }),
      ) as { message: { content: string } };
      expect(compactFrame.message.content).toContain('Row 1\nRow 2\nRow 3');
    } finally {
      cleanupWorld(w);
    }

    const wOver = world(['socket', 'drop']);
    try {
      const settingsPath = cliHookSettingsPath(wOver.dir, 'acme', 'lead')!;
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ crossSessionInbound: 'accept' }));
      const socketFile = join(wOver.sockets, '222.sock');
      writeFileSync(socketFile, '');
      const io = owner(wOver.root);
      const host = fake(wOver);

      const hugeBody = 's'.repeat(RUNTIME_WAKE_MAX + 64);
      const codeOver = await runSend(['lead', hugeBody], io, host);
      expect(codeOver, io.err + io.out).toBe(0);
      expect(host.frames).toHaveLength(1);

      const leadDrops = dropDir(wOver.dir, 'lead');
      const ids = recordIdsIn(leadDrops);
      expect(ids).toHaveLength(1);
      const msgId = ids[0]!;

      const parsedOver = JSON.parse(host.frames[0]!) as {
        message: { content: string };
      };
      expect(parsedOver.message.content).toContain(
        `\n\nMessage too long for this wake. Read it with: team drops --read --id ${msgId} --seat lead`,
      );
      expect(parsedOver.message.content).not.toContain(hugeBody);
      expect(readdirSync(leadDrops).some((name) => name.endsWith('.read.json'))).toBe(false);

      const unread = listUnread(leadDrops, { root: wOver.root, session: 'acme', to: 'lead' }, wOver.home);
      expect(unread).toHaveLength(1);
      expect(unread[0]?.id).toBe(msgId);
    } finally {
      cleanupWorld(wOver);
    }
  });

  test('Scene 2: runtime push legs forward multiline wake and write no .read.json on enqueue (a queue accept is not the seat\'s read), and forward oversizedWake without .read.json above 64 KiB', async () => {
    const setupHeadlessWorld = async (): Promise<World> => {
      const w = world(['headless-resume', 'drop'], [{ name: 'gem', role: 'reviewer', cli: 'gemini', launch: 'gemini' }]);
      await runApprove(['--file', join(w.dir, 'team.yaml')], owner(w.root), {
        ask: async () => '5',
        waiting: () => 'empty',
        now: () => NOW,
        home: w.home,
      });
      const loaded = readTeamConfig(w.root, { home: w.home });
      if (!loaded.ok) throw new Error('failed to load team config');
      const gemSeat = loaded.team.seats.find((s) => s.name === 'gem')!;
      registerLaunch(
        { home: w.home, team: loaded.team, root: w.root, by: 'owner', owner: true, rebindSeatHandle: true },
        gemSeat,
        'synthetic-pane',
        'seat_000000000001',
        '11111111-2222-4333-8444-555555555555',
      );
      writeFileSync(
        join(w.dir, 'team.state.json'),
        JSON.stringify({
          format: 1,
          sessions: {
            acme: {
              seats: {
                gem: {
                  id: 'seat_000000000001',
                  stage: 'ready',
                  pane: 'synthetic-pane',
                  workspace: 'ws-gem',
                  agent_session: '11111111-2222-4333-8444-555555555555',
                },
              },
              worktrees: {},
            },
          },
        }),
      );
      return w;
    };

    const w = await setupHeadlessWorld();
    try {
      const spawnedPrompts: string[] = [];
      const io = owner(w.root);
      const host = fake(w, {
        agents: () => [{ name: 'gem', pane: 'synthetic-pane', cli: 'gemini' }],
        inboxGraceMs: 5,
        headlessResumeSpawn: (_binary, args) => {
          spawnedPrompts.push(args[args.indexOf('-p') + 1] ?? '');
          return { status: 0, stdout: '', stderr: '', timedOut: false };
        },
      });

      const body = 'Runtime line 1\nRuntime line 2\n' + 'detail '.repeat(45);
      const code = await runSend(['gem', body], io, host);
      expect(code, io.err + io.out).toBe(0);
      expect(spawnedPrompts).toHaveLength(1);
      expect(spawnedPrompts[0]).toContain('\n\nRuntime line 1\nRuntime line 2\n');
      expect(spawnedPrompts[0]).not.toContain('body too long for this wake');

      const gemDrops = dropDir(w.dir, 'gem');
      expect(readdirSync(gemDrops).some((name) => name.endsWith('.read.json'))).toBe(false);
      expect(listUnread(gemDrops, { root: w.root, session: 'acme', to: 'gem' }, w.home)).toHaveLength(1);
    } finally {
      cleanupWorld(w);
    }

    const wOver = await setupHeadlessWorld();
    try {
      const spawnedPrompts: string[] = [];
      const io = owner(wOver.root);
      const host = fake(wOver, {
        agents: () => [{ name: 'gem', pane: 'synthetic-pane', cli: 'gemini' }],
        inboxGraceMs: 5,
        headlessResumeSpawn: (_binary, args) => {
          spawnedPrompts.push(args[args.indexOf('-p') + 1] ?? '');
          return { status: 0, stdout: '', stderr: '', timedOut: false };
        },
      });

      const hugeBody = 'r'.repeat(RUNTIME_WAKE_MAX + 32);
      const code = await runSend(['gem', hugeBody], io, host);
      expect(code, io.err + io.out).toBe(0);
      expect(spawnedPrompts).toHaveLength(1);

      const gemDrops = dropDir(wOver.dir, 'gem');
      const ids = recordIdsIn(gemDrops);
      expect(ids).toHaveLength(1);
      const msgId = ids[0]!;

      expect(spawnedPrompts[0]).toBe(
        `Message from owner: body too long for this wake. Read it with: team drops --read --id ${msgId} --seat gem`,
      );
      expect(readdirSync(gemDrops).some((name) => name.endsWith('.read.json'))).toBe(false);
      expect(listUnread(gemDrops, { root: wOver.root, session: 'acme', to: 'gem' }, wOver.home)).toHaveLength(1);
    } finally {
      cleanupWorld(wOver);
    }

    // Direct Codex push adapter multiline acceptance + boundary refusals.
    const queuedCodex: string[] = [];
    const adapter = codexPushAdapter({
      codexDaemon: 'on',
      resolveSession: () => ({
        kind: 'bound',
        recorded: {
          agentId: 'synthetic-agent',
          seatHandle: null,
          sessionId: 'synthetic-thread',
          team: 'acme',
          seat: 'native',
          cli: 'codex',
          herdrSession: 'acme',
          pane: null,
          address: null,
        },
      }),
      spawn: (_binary, args) => {
        queuedCodex.push(args[args.indexOf('--message') + 1] ?? '');
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const baseReq = {
      root: '/synthetic-root',
      home: '/synthetic-home',
      session: 'acme',
      seat: 'native',
      id: 'synthetic-id',
      sender: { seat: 'lead', team: 'acme' },
      agentSession: 'synthetic-thread',
    };
    const multilinePointer = 'Header\n\n' + 'line '.repeat(80);
    const okOut = await adapter.push({ ...baseReq, pointer: multilinePointer });
    expect(okOut).toEqual({ kind: 'enqueue' });
    expect(queuedCodex).toEqual([multilinePointer]);

    const crOut = await adapter.push({ ...baseReq, pointer: 'line1\r\nline2' });
    expect(crOut).toEqual({
      kind: 'unsupported',
      reason: 'the runtime message is empty or contains a carriage return or NUL byte',
    });
    const overOut = await adapter.push({ ...baseReq, pointer: 'x'.repeat(RUNTIME_WAKE_MAX + 1) });
    expect(overOut).toEqual({
      kind: 'unsupported',
      reason: 'the runtime message is empty or contains a carriage return or NUL byte',
    });

    const overProbe = probeHeadlessResumeRoute({
      cli: 'gemini',
      root: '/synthetic-root',
      home: '/synthetic-home',
      session: 'acme',
      seat: 'native',
      id: 'synthetic-id',
      sender: { seat: 'lead', team: 'acme' },
      pointer: 'x'.repeat(RUNTIME_WAKE_MAX + 1),
    });
    expect(overProbe).toEqual({
      status: 'refused',
      reason: `the runtime message would exceed ${String(RUNTIME_WAKE_MAX)} bytes`,
    });
  });

  test('Scene 3: typed wake leg carries full multiline body within TYPED_WAKE_MAX (200 bytes) and settles .read.json, and falls back to read trigger without .read.json above 200 bytes', async () => {
    const w = world(['typed']);
    try {
      let typed = '';
      let enters = 0;
      const io = owner(w.root);
      const host = fake(w, {
        agents: () => [{ name: 'native', pane: 'synthetic-pane', cli: 'codex' }],
        typedWake: () => ({
          read: () => (enters > 0 ? working : typed ? draw(typed) : idle),
          type: (_pane, text) => {
            typed = text;
            return true;
          },
          enter: () => {
            enters += 1;
            return true;
          },
          wait: async () => {},
        }),
        wakeVerifyMs: 1,
        wakePollMs: 1,
      });

      const shortMultiline = 'Check alpha.\nCheck beta.';
      const code = await runSend(['native', shortMultiline], io, host);
      expect(code, io.err + io.out).toBe(0);
      expect(Buffer.byteLength(typed, 'utf8')).toBeLessThanOrEqual(TYPED_WAKE_MAX);
      expect(typed).toContain('\n\nCheck alpha.\nCheck beta.');
      expect(typed).not.toContain('drops --read');
      expect(enters).toBe(1);

      const nativeDrops = dropDir(w.dir, 'native');
      expect(readdirSync(nativeDrops).some((name) => name.endsWith('.read.json'))).toBe(true);
      expect(listUnread(nativeDrops, { root: w.root, session: 'acme', to: 'native' }, w.home)).toHaveLength(0);
    } finally {
      cleanupWorld(w);
    }

    const wOver = world(['typed']);
    try {
      let typed = '';
      let enters = 0;
      const io = owner(wOver.root);
      const host = fake(wOver, {
        agents: () => [{ name: 'native', pane: 'synthetic-pane', cli: 'codex' }],
        typedWake: () => ({
          read: () => (enters > 0 ? working : typed ? draw(typed) : idle),
          type: (_pane, text) => {
            typed = text;
            return true;
          },
          enter: () => {
            enters += 1;
            return true;
          },
          wait: async () => {},
        }),
        wakeVerifyMs: 1,
        wakePollMs: 1,
      });

      const mediumBody = 'm'.repeat(1200); // over the Codex seat's 1000-byte wake
      const code = await runSend(['native', mediumBody], io, host);
      expect(code, io.err + io.out).toBe(0);
      expect(typed).toContain('Body too long; read it with: team drops --read.');
      expect(typed).not.toContain(mediumBody);
      expect(enters).toBe(1);

      const nativeDrops = dropDir(wOver.dir, 'native');
      expect(readdirSync(nativeDrops).some((name) => name.endsWith('.read.json'))).toBe(false);
      expect(listUnread(nativeDrops, { root: wOver.root, session: 'acme', to: 'native' }, wOver.home)).toHaveLength(1);
    } finally {
      cleanupWorld(wOver);
    }

    // Direct deliverTypedWake byte-bound and control-char refusals.
    const noopHost = {
      read: async () => idle,
      type: async () => true,
      enter: async () => true,
      wait: async () => {},
    };
    const overTyped = await deliverTypedWake(noopHost, 'synthetic-pane', 'a'.repeat(1001), 'codex');
    expect(overTyped).toEqual({
      delivered: false,
      typed: false,
      tries: 0,
      reason: "the wake does not fit 1000 bytes; nothing was typed",
    });
    const ctrlTyped = await deliverTypedWake(noopHost, 'synthetic-pane', 'Header\r\nBody', 'codex');
    expect(ctrlTyped).toEqual({
      delivered: false,
      typed: false,
      tries: 0,
      reason: "the wake does not fit 1000 bytes; nothing was typed",
    });
  });

  test('Scene 4: composer draft protection and multiline boxHoldsText row-by-row verification', async () => {
    const w = world(['typed']);
    try {
      let typedCalls = 0;
      let enterCalls = 0;
      const io = owner(w.root);
      const host = fake(w, {
        agents: () => [{ name: 'native', pane: 'synthetic-pane', cli: 'codex' }],
        typedWake: () => ({
          read: () => draw('unsent operator draft\nsecond draft line'),
          type: () => {
            typedCalls += 1;
            return true;
          },
          enter: () => {
            enterCalls += 1;
            return true;
          },
          wait: async () => {},
        }),
        wakeVerifyMs: 1,
        wakePollMs: 1,
      });

      await runSend(['native', 'Short wake'], io, host);
      expect(typedCalls).toBe(0);
      expect(enterCalls).toBe(0);

      const nativeDrops = dropDir(w.dir, 'native');
      expect(readdirSync(nativeDrops).some((name) => name.endsWith('.read.json'))).toBe(false);
      expect(listUnread(nativeDrops, { root: w.root, session: 'acme', to: 'native' }, w.home)).toHaveLength(1);
    } finally {
      cleanupWorld(w);
    }

    const expected = 'From owner\n\nFirst body row\nSecond body row';
    expect(boxHoldsText('codex', expected, draw(expected))).toBe(true);
    expect(boxHoldsText('codex', expected, draw('From owner\nFirst body row\nSecond body row'))).toBe(false);
    expect(boxHoldsText('codex', expected, draw('From owner\n\nFirst body row\nSecond body'))).toBe(false);
    expect(boxHoldsText('codex', expected, draw(`${expected}\nUnexpected row`))).toBe(false);
  });

  test('Scene 5: recordDeliveredBody enforces seat, session, message key, and exact inlineWake match before writing .read.json', async () => {
    const w = world(['drop']);
    try {
      const io = owner(w.root);
      const host = fake(w);
      const body = 'Signed body row 1\nSigned body row 2';
      const code = await runSend(['native', body], io, host);
      expect(code, io.err + io.out).toBe(1);

      const nativeDrops = dropDir(w.dir, 'native');
      const ids = recordIdsIn(nativeDrops);
      expect(ids).toHaveLength(1);
      const msgId = ids[0]!;

      const key = messageKeyOf(w.home);
      const payload = verifiedRecordAt(join(nativeDrops, msgId), msgId, key);
      expect(payload).not.toBeNull();
      const exactWake = inlineWake(payload!, w.home);
      expect(exactWake).not.toBeNull();
      expect(exactWake).toContain('Signed body row 1\nSigned body row 2');
      expect(oversizedWake(payload!)).toBe(
        `Message from owner: body too long for this wake. Read it with: team drops --read --id ${msgId} --seat native`,
      );

      // Refuses wrong seat
      expect(
        recordDeliveredBody({
          dropDir: nativeDrops,
          id: msgId,
          root: w.root,
          session: 'acme',
          seat: 'lead',
          home: w.home,
          wake: exactWake!,
        }),
      ).toBe(false);

      // Refuses wrong session
      expect(
        recordDeliveredBody({
          dropDir: nativeDrops,
          id: msgId,
          root: w.root,
          session: 'other-session',
          seat: 'native',
          home: w.home,
          wake: exactWake!,
        }),
      ).toBe(false);

      // Refuses mismatched wake string (such as a fallback pointer or truncated text)
      expect(
        recordDeliveredBody({
          dropDir: nativeDrops,
          id: msgId,
          root: w.root,
          session: 'acme',
          seat: 'native',
          home: w.home,
          wake: 'From owner — Body too long; read it with: team drops --read.',
        }),
      ).toBe(false);

      // Refuses home without the signing key
      const emptyHome = join(dirname(w.root), 'uninitialized-home');
      mkdirSync(emptyHome, { recursive: true });
      expect(
        recordDeliveredBody({
          dropDir: nativeDrops,
          id: msgId,
          root: w.root,
          session: 'acme',
          seat: 'native',
          home: emptyHome,
          wake: exactWake!,
        }),
      ).toBe(false);

      expect(readdirSync(nativeDrops).some((name) => name.endsWith('.read.json'))).toBe(false);
      expect(listUnread(nativeDrops, { root: w.root, session: 'acme', to: 'native' }, w.home)).toHaveLength(1);

      // Succeeds when seat, session, key, and wake match
      expect(
        recordDeliveredBody({
          dropDir: nativeDrops,
          id: msgId,
          root: w.root,
          session: 'acme',
          seat: 'native',
          home: w.home,
          wake: exactWake!,
        }),
      ).toBe(true);
      expect(readdirSync(nativeDrops).some((name) => name.endsWith('.read.json'))).toBe(true);
      expect(listUnread(nativeDrops, { root: w.root, session: 'acme', to: 'native' }, w.home)).toHaveLength(0);

      // Idempotent on subsequent call ('already-served')
      expect(
        recordDeliveredBody({
          dropDir: nativeDrops,
          id: msgId,
          root: w.root,
          session: 'acme',
          seat: 'native',
          home: w.home,
          wake: exactWake!,
        }),
      ).toBe(true);
    } finally {
      cleanupWorld(w);
    }
  });

  test('Scene 6: serveWakeChild settles .read.json when the delivered wake carries the full body, and leaves the drop unread when carrying a pointer', async () => {
    const w = world(['drop']);
    try {
      const io = owner(w.root);
      const host = fake(w);
      expect(await runSend(['native', 'Child wake line 1\nChild wake line 2'], io, host)).toBe(1);
      expect(await runSend(['native', 'y'.repeat(240)], io, host)).toBe(1);

      const nativeDrops = dropDir(w.dir, 'native');
      const unreadBefore = listUnread(nativeDrops, { root: w.root, session: 'acme', to: 'native' }, w.home);
      expect(unreadBefore).toHaveLength(2);

      const key = messageKeyOf(w.home);
      const payloads = unreadBefore.map((item) => verifiedRecordAt(join(nativeDrops, item.id), item.id, key)!);
      const shortPayload = payloads.find((p) => p.body.includes('Child wake line 1'))!;
      const longPayload = payloads.find((p) => !p.body.includes('Child wake line 1'))!;

      const stagedDir = join(dirname(w.root), 'staged');
      mkdirSync(stagedDir, { recursive: true });

      const deps = {
        agents: () => [{ name: 'native', pane: 'synthetic-pane', cli: 'codex' }],
        processes: () => ({ shell: 100, foreground: [200] }),
        wakeHost: () => ({
          read: async () => idle,
          type: async () => true,
          enter: async () => true,
          wait: async () => {},
        }),
        walk: async () => ({
          delivered: true as const,
          typed: true,
          tries: 1,
          reason: 'working seen after Enter',
        }),
        now: () => NOW,
      };

      // 1) Pointer-only wake for the oversized message: delivered, but drop stays unread.
      const longDropPath = join(stagedDir, longPayload.id);
      writeFileSync(longDropPath, 'staged');
      reserveWake(wakePath(stagedDir, longPayload.id), {
        id: longPayload.id,
        at: NOW.toISOString(),
        state: 'reserved',
      });
      const outPointer = await serveWakeChild(
        {
          version: 1,
          id: longPayload.id,
          seat: 'native',
          session: 'acme',
          cli: 'codex',
          line: 'From owner — Body too long; read it with: team drops --read.',
          dropPath: longDropPath,
          dir: w.dir,
          root: w.root,
          project: 'acme',
          home: w.home,
          from: 'owner',
          body: longPayload.body,
          stagedAt: NOW.getTime(),
        },
        deps,
      );
      expect(outPointer.outcome).toBe('delivered');
      expect(readdirSync(nativeDrops).some((name) => name === `${longPayload.id}.read.json`)).toBe(false);

      // 2) Full inlineWake for the short multiline message: delivered, and .read.json is written.
      const shortDropPath = join(stagedDir, shortPayload.id);
      writeFileSync(shortDropPath, 'staged');
      reserveWake(wakePath(stagedDir, shortPayload.id), {
        id: shortPayload.id,
        at: NOW.toISOString(),
        state: 'reserved',
      });
      const shortWake = inlineWake(shortPayload, w.home, TYPED_WAKE_MAX, 'typed')!;
      expect(shortWake).toContain('Child wake line 1\nChild wake line 2');

      const outInline = await serveWakeChild(
        {
          version: 1,
          id: shortPayload.id,
          seat: 'native',
          session: 'acme',
          cli: 'codex',
          line: shortWake,
          dropPath: shortDropPath,
          dir: w.dir,
          root: w.root,
          project: 'acme',
          home: w.home,
          from: 'owner',
          body: shortPayload.body,
          stagedAt: NOW.getTime(),
        },
        deps,
      );
      expect(outInline.outcome).toBe('delivered');
      expect(readdirSync(nativeDrops).some((name) => name === `${shortPayload.id}.read.json`)).toBe(true);

      const unreadAfter = listUnread(nativeDrops, { root: w.root, session: 'acme', to: 'native' }, w.home);
      expect(unreadAfter.map((item) => item.id)).toEqual([longPayload.id]);
    } finally {
      cleanupWorld(w);
    }
  });
});

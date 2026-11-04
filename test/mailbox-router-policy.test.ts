import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAILBOX_ROUTER_DEFAULTS,
  mailboxRouterPolicyProblem,
  mailboxRouterPolicyProblems,
  readMailboxRouterPolicy,
  resolveMailboxRouterPolicy,
} from '../src/daemon/mailbox/policy.ts';

describe('the mailbox router policy', () => {
  test('an empty chain is the release map, and the reply bound is unset', () => {
    const read = resolveMailboxRouterPolicy();
    expect(read).toEqual({ ok: true, policy: MAILBOX_ROUTER_DEFAULTS });
    expect(mailboxRouterPolicyProblem(MAILBOX_ROUTER_DEFAULTS)).toBeNull();
  });

  test('an unreadable team refuses the read, and the check path names no problem for it', () => {
    const root = mkdtempSync(join(tmpdir(), 'mailbox-policy-root-'));
    const home = mkdtempSync(join(tmpdir(), 'mailbox-policy-home-'));
    const now = new Date('2026-11-04T00:00:00Z');
    const read = readMailboxRouterPolicy(root, home, now);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.why.startsWith('the team file cannot be read (')).toBe(true);
    expect(mailboxRouterPolicyProblems(root, home, now, null)).toEqual([]);
  });

  test('the entity level may retarget an alias and clear its fallback', () => {
    const read = resolveMailboxRouterPolicy({
      aliases: [
        { level: 'entity', alias: 'iris', address: 'iris@floor', fallback: 'orchestrator@floor' },
        { level: 'entity', alias: 'atlas', address: 'orchestrator@floor', fallback: null },
      ],
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.policy.routes.find((route) => route.alias === 'iris')).toEqual({
      alias: 'iris',
      address: 'iris@floor',
      fallback: 'orchestrator@floor',
    });
    expect(read.policy.routes.find((route) => route.alias === 'atlas')?.fallback).toBeNull();
  });

  test('a team may add an alias, and the nearest add wins', () => {
    const read = resolveMailboxRouterPolicy({
      aliases: [
        { level: 'team', alias: 'helper', address: 'helper@floor', fallback: null },
        { level: 'seat', alias: 'helper', address: 'helper-seat@floor', fallback: null },
      ],
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.policy.routes.find((route) => route.alias === 'helper')).toEqual({
      alias: 'helper',
      address: 'helper-seat@floor',
      fallback: null,
    });
    expect(read.policy.routes.map((route) => route.alias)).toEqual(['iris', 'atlas', 'zeus', 'helper']);
  });

  test('a team cannot retarget an entity alias or its fallback', () => {
    const address = resolveMailboxRouterPolicy({
      aliases: [{ level: 'team', alias: 'iris', address: 'other@floor' }],
    });
    expect(address).toEqual({
      ok: false,
      why: 'the team level cannot retarget the entity alias iris',
    });
    const fallback = resolveMailboxRouterPolicy({
      aliases: [{ level: 'project', alias: 'atlas', address: 'orchestrator@floor', fallback: 'zeus@floor' }],
    });
    expect(fallback).toEqual({
      ok: false,
      why: 'the project level cannot change the fallback of the entity alias atlas',
    });
  });

  test('a missing address, a self-fallback, and a desk target are load refusals', () => {
    const missing = resolveMailboxRouterPolicy({
      aliases: [{ level: 'team', alias: 'helper', address: '' }],
    });
    expect(missing).toEqual({ ok: false, why: 'helper has no address' });
    const self = mailboxRouterPolicyProblem({
      routes: [{ alias: 'helper', address: 'helper@floor', fallback: 'helper' }],
      replyBoundSeconds: null,
    });
    expect(self).toBe('the fallback for helper names the alias itself');
    const own = mailboxRouterPolicyProblem({
      routes: [{ alias: 'helper', address: 'helper@floor', fallback: 'helper@floor' }],
      replyBoundSeconds: null,
    });
    expect(own).toBe('the fallback for helper names that alias\'s own address');
    const desk = mailboxRouterPolicyProblem({
      routes: [{ alias: 'iris', address: 'desk@floor', fallback: null }],
      replyBoundSeconds: null,
    });
    expect(desk).toBe('iris names the desk seat, which is not a route');
    const deskFallback = mailboxRouterPolicyProblem({
      routes: [{ alias: 'atlas', address: 'orchestrator@floor', fallback: 'desk@floor' }],
      replyBoundSeconds: null,
    });
    expect(deskFallback).toBe('the fallback for atlas names the desk seat, which is not a route');
  });

  test('the nearest reply bound wins, and a non-positive bound is refused', () => {
    const read = resolveMailboxRouterPolicy({
      replyBounds: [
        { level: 'entity', seconds: 10 },
        { level: 'team', seconds: 40 },
      ],
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.policy.replyBoundSeconds).toBe(40);
    expect(resolveMailboxRouterPolicy({
      replyBounds: [{ level: 'seat', seconds: 0 }],
    })).toEqual({ ok: false, why: 'the reply bound must be a positive number of seconds' });
  });
});

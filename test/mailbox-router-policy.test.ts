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
import { ROUTER_ALIAS_DEFAULTS, ROUTER_FALLBACK_DEFAULTS } from '../src/policy/types.ts';

describe('the mailbox router policy', () => {
  test('a fresh install ships no alias, and the reply bound is unset', () => {
    expect(ROUTER_ALIAS_DEFAULTS).toEqual({});
    expect(ROUTER_FALLBACK_DEFAULTS).toEqual({});
    expect(MAILBOX_ROUTER_DEFAULTS).toEqual({ routes: [], replyBoundSeconds: null });
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

  test('the entity level places an alias and its fallback', () => {
    const read = resolveMailboxRouterPolicy({
      aliases: [
        { level: 'entity', alias: 'lead', address: 'lead@acme', fallback: 'helper@acme' },
        { level: 'entity', alias: 'helper', address: 'helper@acme', fallback: null },
      ],
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.policy.routes.find((route) => route.alias === 'lead')).toEqual({
      alias: 'lead',
      address: 'lead@acme',
      fallback: 'helper@acme',
    });
    expect(read.policy.routes.find((route) => route.alias === 'helper')).toEqual({
      alias: 'helper',
      address: 'helper@acme',
      fallback: null,
    });
  });

  test('a team may add an alias, and the nearest add wins', () => {
    const read = resolveMailboxRouterPolicy({
      aliases: [
        { level: 'team', alias: 'helper', address: 'helper@acme', fallback: null },
        { level: 'seat', alias: 'helper', address: 'helper-seat@acme', fallback: null },
      ],
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.policy.routes.find((route) => route.alias === 'helper')).toEqual({
      alias: 'helper',
      address: 'helper-seat@acme',
      fallback: null,
    });
    expect(read.policy.routes.map((route) => route.alias)).toEqual(['helper']);
  });

  test('a team cannot retarget an entity alias or its fallback', () => {
    const address = resolveMailboxRouterPolicy({
      aliases: [
        { level: 'entity', alias: 'lead', address: 'lead@acme', fallback: null },
        { level: 'team', alias: 'lead', address: 'other@acme' },
      ],
    });
    expect(address).toEqual({
      ok: false,
      why: 'the team level cannot retarget the entity alias lead',
    });
    const fallback = resolveMailboxRouterPolicy({
      aliases: [
        { level: 'entity', alias: 'helper', address: 'helper@acme', fallback: null },
        { level: 'project', alias: 'helper', address: 'helper@acme', fallback: 'lead@acme' },
      ],
    });
    expect(fallback).toEqual({
      ok: false,
      why: 'the project level cannot change the fallback of the entity alias helper',
    });
  });

  test('a missing address, a self-fallback, and a desk target are load refusals', () => {
    const missing = resolveMailboxRouterPolicy({
      aliases: [{ level: 'team', alias: 'helper', address: '' }],
    });
    expect(missing).toEqual({ ok: false, why: 'helper has no address' });
    const self = mailboxRouterPolicyProblem({
      routes: [{ alias: 'helper', address: 'helper@acme', fallback: 'helper' }],
      replyBoundSeconds: null,
    });
    expect(self).toBe('the fallback for helper names the alias itself');
    const own = mailboxRouterPolicyProblem({
      routes: [{ alias: 'helper', address: 'helper@acme', fallback: 'helper@acme' }],
      replyBoundSeconds: null,
    });
    expect(own).toBe('the fallback for helper names that alias\'s own address');
    const desk = mailboxRouterPolicyProblem({
      routes: [{ alias: 'lead', address: 'desk@acme', fallback: null }],
      replyBoundSeconds: null,
    });
    expect(desk).toBe('lead names the desk seat, which is not a route');
    const deskFallback = mailboxRouterPolicyProblem({
      routes: [{ alias: 'lead', address: 'lead@acme', fallback: 'desk@acme' }],
      replyBoundSeconds: null,
    });
    expect(deskFallback).toBe('the fallback for lead names the desk seat, which is not a route');
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

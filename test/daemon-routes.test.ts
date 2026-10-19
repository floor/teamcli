import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalRoot,
  duplicateRoute,
  resolveScope,
  routeId,
  routeOf,
  type HostedRoute,
} from '../src/daemon/routes.ts';

const bases: string[] = [];

function scratch(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-daemon-routes-')));
  bases.push(base);
  return base;
}

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function route(root: string, team = 'acme', session = 'acme'): HostedRoute {
  return routeOf(root, team, session, ['op-1', 'clerk']);
}

describe('the machine daemon route table', () => {
  test('a root is canonicalized through a link, and a file or a missing path names no checkout', () => {
    const base = scratch();
    const root = join(base, 'repo');
    mkdirSync(root);
    const link = join(base, 'repo-link');
    symlinkSync(root, link);
    const file = join(base, 'plain.txt');
    writeFileSync(file, 'x\n');

    expect(canonicalRoot(root)).toBe(root);
    expect(canonicalRoot(link)).toBe(root);
    expect(canonicalRoot(file)).toBeNull();
    expect(canonicalRoot(join(base, 'absent'))).toBeNull();
  });

  test('a route copies and sorts its seats, and a duplicate root is one route', () => {
    const base = scratch();
    const root = join(base, 'repo');
    mkdirSync(root);
    const seats = ['zeta', 'alpha'];
    const made = routeOf(root, 'acme', 'acme', seats);
    seats.push('late');

    expect(made.seats).toEqual(['alpha', 'zeta']);
    expect(duplicateRoute([made], root)?.root).toBe(root);
    expect(duplicateRoute([made], join(base, 'other'))).toBeNull();
  });

  test('the route id is a digest of the root, never the path itself', () => {
    const base = scratch();
    const one = route(join(base, 'one'));
    const two = route(join(base, 'two'));

    expect(routeId(one)).toMatch(/^[0-9a-f]{32}$/);
    expect(routeId(one)).toBe(routeId(route(one.root)));
    expect(routeId(one)).not.toBe(routeId(two));
    expect(routeId(one)).not.toContain(base);
  });

  test('a root resolves its checkout, even when the claim spells it as a link', () => {
    const base = scratch();
    const root = join(base, 'repo');
    mkdirSync(root);
    const link = join(base, 'repo-link');
    symlinkSync(root, link);
    const routes = [route(root)];

    expect(resolveScope(routes, { root: link })).toEqual({ kind: 'one', route: routes[0] as HostedRoute });
    expect(resolveScope(routes, { root, team: 'acme', session: 'acme', seat: 'clerk' }).kind).toBe('one');
  });

  test('a claim that contradicts its root is a mismatch, not another checkout', () => {
    const base = scratch();
    const root = join(base, 'repo');
    mkdirSync(root);
    const routes = [route(root)];

    const team = resolveScope(routes, { root: routes[0]!.root, team: 'other' });
    expect(team).toEqual({ kind: 'mismatch', why: `the scope team "other" is not this checkout's acme` });

    const session = resolveScope(routes, { root: routes[0]!.root, session: 'elsewhere' });
    expect(session.kind).toBe('mismatch');
  });

  test('a root the daemon does not host, or a claim with no routing key, is refused', () => {
    const base = scratch();
    const root = join(base, 'repo');
    const absent = join(base, 'absent');
    mkdirSync(absent);
    const routes = [route(root)];

    expect(resolveScope(routes, { root: absent })).toEqual({
      kind: 'refused',
      why: 'the scope root is not a checkout this daemon hosts',
    });
    expect(resolveScope(routes, { seat: 'clerk' })).toEqual({
      kind: 'refused',
      why: 'the scope names no checkout: it needs root, team or session',
    });
    expect(resolveScope(routes, { root: join(base, 'missing') }).kind).toBe('refused');
  });

  test('team and session resolve a checkout only when they name exactly one hosted route', () => {
    const base = scratch();
    const one = route(join(base, 'one'), 'acme', 'acme');
    const two = route(join(base, 'two'), 'acme', 'acme');
    const other = route(join(base, 'three'), 'beacon', 'beacon');

    expect(resolveScope([one, two], { team: 'acme' })).toEqual({
      kind: 'refused',
      why: 'the scope names 2 hosted checkouts; name its root',
    });
    expect(resolveScope([one, two, other], { team: 'beacon' }).kind).toBe('one');
    expect(resolveScope([one, two, other], { session: 'beacon' }).kind).toBe('one');
    expect(resolveScope([one, other], { team: 'acme', session: 'beacon' }).kind).toBe('refused');
  });

  test('seat is checked against the resolved route and agent never selects one', () => {
    const base = scratch();
    const root = join(base, 'repo');
    mkdirSync(root);
    const routes = [route(root)];

    expect(resolveScope(routes, { root: routes[0]!.root, seat: 'nobody' })).toEqual({
      kind: 'mismatch',
      why: `the scope seat "nobody" is not a declared seat of ${routes[0]!.root}`,
    });
    const withAgent = resolveScope(routes, { root: routes[0]!.root, seat: 'clerk', agent: 'any-id' });
    expect(withAgent.kind).toBe('one');
  });
});

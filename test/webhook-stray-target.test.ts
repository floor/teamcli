// A webhook row counts as a seat's delivery only when its routine runs as the seat's own CLI.
// On 2026-11-16 a Grok seat's row posted to a Cursor automation: the send said "delivered
// (webhook)" and the Grok pane never saw the message. Synthetic URL and secret files only.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webhookRoutesOf } from '../src/bus/webhook.ts';
import type { SeatWebhook, TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { strayWebhookOf, webhookHostTarget, webhookRefusal, webhookRouteOf } from '../src/send/webhook.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const bases: string[] = [];
afterEach(() => {
  const owned = bases.splice(0);
  if (owned.length) discardFixtures(owned);
});

function row(url: string, extra: Partial<SeatWebhook> = {}): SeatWebhook {
  const base = mkdtempSync(join(tmpdir(), 'stray-hook-'));
  bases.push(base);
  const urlFile = join(base, 'url');
  const secretFile = join(base, 'secret');
  writeFileSync(urlFile, `${url}\n`);
  writeFileSync(secretFile, 'synthetic-secret\n');
  chmodSync(secretFile, 0o600);
  return { urlFile, secretFile, ...extra };
}

test('the URL host names the routine\'s CLI where it is a vendor service, and nothing elsewhere', () => {
  expect(webhookHostTarget('https://api2.cursor.sh/automations/webhook/x')).toBe('cursor');
  expect(webhookHostTarget('https://api.anthropic.com/v1/routines/x')).toBe('claude-code');
  expect(webhookHostTarget('https://hooks.example.test/x')).toBeNull();
  expect(webhookHostTarget('not a url')).toBeNull();
});

test('a Cursor routine on a Grok seat is stray: refused for the seat, never posted, flagged', () => {
  const hook = row('https://api2.cursor.sh/automations/webhook/synthetic');
  const route = webhookRouteOf(hook, 'grok');
  expect(route).toMatchObject({ ok: false, stray: { target: 'cursor', cli: 'grok' } });
  expect(webhookRefusal(hook, 'grok')).toContain("the webhook runs as cursor, not as this seat's grok");
  expect(strayWebhookOf(hook, 'grok')).toEqual({ target: 'cursor', cli: 'grok' });
  // The same row on a Cursor seat is that seat's route.
  expect(webhookRouteOf(hook, 'cursor')).toMatchObject({ ok: true });
  expect(strayWebhookOf(hook, 'cursor')).toBeNull();
  // A caller that names no CLI reads the row as before.
  expect(webhookRouteOf(hook)).toMatchObject({ ok: true });
});

test('the row\'s own target wins over the host, and an open target counts as before', () => {
  const declared = row('https://hooks.example.test/x', { target: 'claude-code' });
  expect(strayWebhookOf(declared, 'grok')).toEqual({ target: 'claude-code', cli: 'grok' });
  expect(strayWebhookOf(declared, 'claude-code')).toBeNull();
  const open = row('https://hooks.example.test/x');
  expect(strayWebhookOf(open, 'grok')).toBeNull();
  expect(webhookRouteOf(open, 'grok')).toMatchObject({ ok: true });
});

test('the bus builds no route for a stray row, and keeps the seat\'s own', () => {
  const stray = row('https://api2.cursor.sh/automations/webhook/synthetic');
  const own = row('https://api2.cursor.sh/automations/webhook/other');
  const team = { seats: [
    { name: 'iris', cli: 'grok', webhook: stray },
    { name: 'builder', cli: 'cursor', webhook: own },
  ] } as unknown as TeamFile;
  const routes = webhookRoutesOf(team);
  expect([...routes.keys()]).toEqual(['builder']);
});

test('the team file takes webhook.target and refuses a word that is no CLI name', () => {
  const text = (target: string) => `format: 1
project: hook-scene
session: hooks
operator: lead
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: lead
    leads: true
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: fixture
  - role: worker
    name: routine
    cli: grok
    vendor: test
    model: Test
    version: "1"
    launch: fixture
    webhook:
      url_file: /tmp/hook-url
      secret_file: /tmp/hook-secret
      target: ${target}
`;
  const good = validateTeamFile(text('cursor'));
  expect(good.ok).toBe(true);
  if (good.ok) expect(good.team.seats.find((seat) => seat.name === 'routine')?.webhook?.target).toBe('cursor');
  const bad = validateTeamFile(text('"Not A CLI"'));
  expect(bad.ok).toBe(false);
});

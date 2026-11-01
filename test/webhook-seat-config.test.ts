// The seat's webhook adapter declaration: the team-file field, what it refuses, and the way
// `team config set` writes it through the generic record editor. The URL and the secret are the
// contents of two files outside the record; neither value is ever written into the team file.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfig } from '../src/commands/config.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { testIo } from './helpers.ts';
import { realRegistryTouched } from './helpers/registry-team.ts';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  expect(realRegistryTouched()).toBe(false);
});

function scratch(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-webhook-config-')));
  made.push(base);
  return base;
}

/** A team with a plain lead and a remote seat, and whatever webhook lines the scene writes on
 *  the remote one. */
function teamText(webhook: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: remote
    name: iris
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
${webhook}`;
}

test('a seat webhook reads as two absolute file paths', () => {
  const base = scratch();
  const urlFile = join(base, 'hook-url');
  const secretFile = join(base, 'hook-secret');
  const parsed = validateTeamFile(teamText(`    webhook:
      url_file: ${JSON.stringify(urlFile)}
      secret_file: ${JSON.stringify(secretFile)}
`));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const iris = parsed.team.seats.find((seat) => seat.name === 'iris');
  expect(iris?.webhook).toEqual({ urlFile, secretFile });
  // A seat with no webhook keeps no field at all, so its digest is the one it had.
  expect(parsed.team.seats.find((seat) => seat.name === 'lead')?.webhook).toBeUndefined();
});

test('a seat row may name the header its secret authenticates and the body its routine reads', () => {
  const base = scratch();
  const urlFile = join(base, 'hook-url');
  const secretFile = join(base, 'hook-secret');
  const parsed = validateTeamFile(teamText(`    webhook:
      url_file: ${JSON.stringify(urlFile)}
      secret_file: ${JSON.stringify(secretFile)}
      header: x-synthetic-auth
      body: inbox
`));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const iris = parsed.team.seats.find((seat) => seat.name === 'iris');
  expect(iris?.webhook).toEqual({ urlFile, secretFile, header: 'x-synthetic-auth', body: 'inbox' });
});

test('a header that is not an HTTP field name is refused, and content-type stays the adapter\'s', () => {
  const base = scratch();
  const urlFile = join(base, 'hook-url');
  const secretFile = join(base, 'hook-secret');
  const row = (header: string): string => `    webhook:
      url_file: ${JSON.stringify(urlFile)}
      secret_file: ${JSON.stringify(secretFile)}
      header: ${JSON.stringify(header)}
`;
  const spaces = validateTeamFile(teamText(row('not a header')));
  expect(spaces.ok).toBe(false);
  if (!spaces.ok) {
    expect(spaces.errors.map((problem) => problem.message).join('; ')).toContain('webhook.header must be an HTTP field name');
  }
  const contentType = validateTeamFile(teamText(row('Content-Type')));
  expect(contentType.ok).toBe(false);
  if (!contentType.ok) {
    expect(contentType.errors.map((problem) => problem.message).join('; ')).toContain('cannot be content-type');
  }
});

test('a body word the adapter does not read is refused', () => {
  const base = scratch();
  const urlFile = join(base, 'hook-url');
  const secretFile = join(base, 'hook-secret');
  const parsed = validateTeamFile(teamText(`    webhook:
      url_file: ${JSON.stringify(urlFile)}
      secret_file: ${JSON.stringify(secretFile)}
      body: signed
`));
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) {
    expect(parsed.errors.map((problem) => problem.message).join('; ')).toContain('webhook.body must be one of: event, inbox');
  }
});

test('a relative path is refused: the two files are named absolutely', () => {
  const parsed = validateTeamFile(teamText(`    webhook:
      url_file: hook-url
      secret_file: hook-secret
`));
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  const text = parsed.errors.map((problem) => problem.message).join('; ');
  expect(text).toContain('webhook.url_file must be an absolute path');
});

test('both paths are required, and no other key is taken', () => {
  const missing = validateTeamFile(teamText(`    webhook:
      url_file: /run/team/hook-url
`));
  expect(missing.ok).toBe(false);
  if (!missing.ok) {
    expect(missing.errors.map((problem) => problem.message).join('; ')).toContain('webhook.secret_file is required');
  }
  const extra = validateTeamFile(teamText(`    webhook:
      url_file: /run/team/hook-url
      secret_file: /run/team/hook-secret
      token_file: /run/team/hook-token
`));
  expect(extra.ok).toBe(false);
  if (!extra.ok) {
    expect(extra.errors.map((problem) => problem.message).join('; ')).toContain('token_file');
  }
});

test('team config set writes the webhook map into the seat, and the record still validates', async () => {
  const base = scratch();
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  const file = join(root, '.agents', 'team.yaml');
  writeFileSync(file, teamText(''));
  const urlFile = join(base, 'hook-url');
  const secretFile = join(base, 'hook-secret');
  const io = testIo(root, { kind: 'owner' });
  const env = { ...process.env, TEAM_CONFIG_SOURCE: 'file' };

  const code = await runConfig(
    ['set', 'seats.iris.webhook', `{url_file: ${urlFile}, secret_file: ${secretFile}}`, '--json'],
    io,
    { home, env, now: () => new Date('2026-11-01T00:00:00Z') },
  );

  expect(code, io.out + io.err).toBe(0);
  const after = validateTeamFile(readFileSync(file, 'utf8'));
  expect(after.ok).toBe(true);
  if (!after.ok) return;
  expect(after.team.seats.find((seat) => seat.name === 'iris')?.webhook).toEqual({ urlFile, secretFile });
  // The record holds the two paths and nothing that authenticates.
  expect(readFileSync(file, 'utf8')).toContain(secretFile);
});

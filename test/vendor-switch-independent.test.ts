// Vendor metadata and queue behavior, with injected presence results only.
// Generated launch strings are DATA: never execute them or query any credential store.
import { afterAll, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Io } from '../src/io.ts';
import type { Seat } from '../src/file/types.ts';
import type { CredentialProbe } from '../src/profiles/credentials.ts';

const realFs = { ...fs };
const base = fs.mkdtempSync(join(tmpdir(), 'vendor-switch-independent-'));
const priorHome = process.env.HOME;
const priorSource = process.env.TEAM_CONFIG_SOURCE;
process.env.HOME = join(base, 'startup-home');
process.env.TEAM_CONFIG_SOURCE = 'file';
fs.mkdirSync(process.env.HOME);
let descriptorReads = 0, defaultProbeSelections = 0;
mock.module('node:fs', () => ({ ...realFs,
  readFileSync: ((path: unknown, ...args: unknown[]) => {
    if (path === 0 || path === '/dev/stdin') { descriptorReads++; throw new Error('stdin is forbidden in these scenes'); }
    return (realFs.readFileSync as (...args: unknown[]) => unknown)(path, ...args);
  }) as typeof fs.readFileSync,
}));
const credentialApi = { ...await import('../src/profiles/credentials.ts') };
mock.module('../src/profiles/credentials.ts', () => ({ ...credentialApi,
  credentialProbeFor: () => { defaultProbeSelections++; throw new Error('real credential lookup is forbidden; inject the probe'); },
}));
const { runSwap } = await import('../src/commands/swap.ts');
const { profileFor } = await import('../src/profiles/index.ts');
const { planVendorSwap } = await import('../src/swap/vendor.ts');
const { recipeOf } = await import('../src/swap/run.ts');
const { rewriteSeatModel } = await import('../src/file/lines.ts');
const { validateTeamFile } = await import('../src/file/validate.ts');
const { readState } = await import('../src/state.ts');
const { writePolicySet } = await import('../src/policy/index.ts');
const profile = profileFor('claude-code')!;
const NOW = new Date('2026-11-02T12:00:00Z');

afterAll(() => {
  mock.module('node:fs', () => realFs);
  mock.module('../src/profiles/credentials.ts', () => credentialApi);
  if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
  if (priorSource === undefined) delete process.env.TEAM_CONFIG_SOURCE; else process.env.TEAM_CONFIG_SOURCE = priorSource;
  execFileSync('/usr/bin/trash', [base]);
  expect(defaultProbeSelections).toBe(0);
  expect(descriptorReads).toBe(0);
});

const models = [
  { vendor: 'deepseek', id: 'deepseek-flash', model: 'DeepSeek Flash', version: '4.0', display: 'DeepSeek Flash 4.0', item: 'deepseek-api-key', url: 'https://api.deepseek.com/anthropic' },
  { vendor: 'zai', id: 'glm-5.3', model: 'GLM', version: '5.3', display: 'GLM 5.3', item: 'glm-api-key', url: 'https://api.z.ai/api/anthropic' },
  { vendor: 'moonshot', id: 'kimi-k2.5', model: 'Kimi K2.5', version: '2.5', display: 'Kimi K2.5', item: 'kimi-api-key', url: 'https://api.kimi.ai/coding/' },
] as const;
type Model = typeof models[number];
// This is inert expected source text, not a shell command this test runs.
const expectedLaunch = (m: Model, prefix = '') => `${prefix}ANTHROPIC_BASE_URL=${m.url} ANTHROPIC_AUTH_TOKEN=$(/usr/bin/security find-generic-password -s ${m.item} -a "$USER" -w) ANTHROPIC_MODEL=${m.id} claude --model ${m.id}`;
let sequence = 0;
function world(m: Model = models[1], launch = 'claude --model old-model', quoteTarget = false) {
  const root = join(base, String(sequence++)), home = join(root, 'home'), dir = join(root, '.agents');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(home);
  const yaml = `format: 1
project: independent
session: independent
entity: fixture-lab
coordinator: subject
operator: subject
workspace:
  mode: shared
seats:
  - name: subject
    role: coordinator
    cli: claude-code
    vendor: anthropic
    model: Old Model
    version: "1"
    display: Old Model 1
    launch: ${quoteTarget ? JSON.stringify(launch) : launch}
  - name: donor
    role: worker
    cli: claude-code
    vendor: ${m.vendor}
    model: ${m.model}
    version: "${m.version}"
    display: ${m.vendor === 'moonshot' ? `${m.display} ${m.version}` : m.display}
    launch: ${JSON.stringify(expectedLaunch(m))}
  - name: alternate
    role: worker
    cli: codex
    vendor: openai
    model: Synthetic Sol
    version: "6"
    display: Synthetic Sol 6
    launch: codex --model synthetic-sol
`;
  fs.writeFileSync(join(dir, 'team.yaml'), yaml);
  // Policy signing uses a fresh fixture-local key; no vendor credential is created or read.
  const written = writePolicySet(home, { level: 'entity', target: 'fixture-lab', name: 'model-rule', value: '*=!anthropic' }, { now: NOW });
  if (!written.ok) throw new Error(written.why);
  return { root, home, dir, yaml };
}
type World = ReturnType<typeof world>;
async function queue(w: World, to: string, probe: CredentialProbe, json = true) {
  let out = '', err = '', stdinReads = 0;
  const io: Io = { cwd: w.root, env: {}, stdinIsTTY: false, caller: { kind: 'owner' },
    stdout: text => { out += text; }, stderr: text => { err += text; },
    stdin: () => { stdinReads++; throw new Error('no stdin permitted'); },
  };
  const code = await runSwap(['queue', 'subject', '--to', to, ...(json ? ['--json'] : [])], io,
    { home: w.home, now: NOW, credentialProbe: probe });
  return { code, out, err, stdinReads, record: readState(w.dir).swaps?.subject };
}
function parsedSeats(text: string, w: World): Seat[] {
  const parsed = validateTeamFile(text, { home: w.home, root: w.root });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.team.seats;
}
const row = (s: Seat) => ({ cli: s.cli, vendor: s.vendor, model: s.model, version: s.version, display: s.display, launch: s.launch });

for (const m of models) {
  test(`${m.vendor}: profile queue writes the same model row as a real donor recipe`, async () => {
    const w = world(m); const probes: string[] = [];
    const vendor = await queue(w, `${m.vendor}:${m.id}`, item => { probes.push(item); return 'present'; });
    expect(vendor.code, vendor.err + vendor.out).toBe(0);
    expect(probes).toEqual([m.item]); expect(vendor.stdinReads).toBe(0);
    expect(JSON.parse(vendor.out).donor).toBeUndefined();
    const viaVendor = parsedSeats(rewriteSeatModel(w.yaml, 'subject', recipeOf(vendor.record!)), w);
    const donor = await queue(w, `claude-code:${m.model}`, () => { throw new Error('donor route must not probe'); });
    expect(donor.code, donor.err + donor.out).toBe(0);
    expect(JSON.parse(donor.out).donor.seat).toBe('donor');
    expect(vendor.record!.to).toEqual(donor.record!.to);
    const viaDonor = parsedSeats(rewriteSeatModel(w.yaml, 'subject', recipeOf(donor.record!)), w);
    expect(row(viaVendor[0]!)).toEqual(row(viaDonor[0]!));
    expect(row(viaVendor[0]!)).toEqual(row(viaVendor.find(seat => seat.name === 'donor')!));
    expect(viaVendor[0]!.name).toBe('subject'); expect(viaVendor[0]!.role).toBe('coordinator');
  });
}

test('a valid double-quoted launch remains valid when vendor words are written into its row', async () => {
  const w = world(models[0], 'claude --model old-model', true);
  expect(parsedSeats(w.yaml, w)).toHaveLength(3);
  const r = await queue(w, 'deepseek:deepseek-flash', () => 'present');
  expect(r.code, r.err + r.out).toBe(0);
  const rewritten = rewriteSeatModel(w.yaml, 'subject', recipeOf(r.record!));
  const checked = validateTeamFile(rewritten, { home: w.home, root: w.root });
  expect(checked.ok, checked.ok ? '' : JSON.stringify(checked.errors)).toBe(true);
});

test('quoted leading assignments and the complete wrapper prefix survive a vendor switch', async () => {
  const prefix = 'KEEP="two words" FLAG=1';
  const wrapper = 'zsh "/synthetic/tool folder/run.sh"';
  const old = `${prefix} ANTHROPIC_BASE_URL=https://old.invalid ANTHROPIC_MODEL=old ${wrapper} claude --model old --verbose`;
  const w = world(models[1], old);
  const r = await queue(w, 'zai:glm-5.3', () => 'present');
  expect(r.code, r.err + r.out).toBe(0);
  expect(r.record!.to.launch).toBe(expectedLaunch(models[1], `${prefix} `).replace('claude --model', `${wrapper} claude --model`));
  expect(r.record!.to.launch).not.toContain('old.invalid'); expect(r.record!.to.launch).not.toContain('--verbose');
});

test('an unknown vendor name that names a donor CLI uses that donor without probing', async () => {
  const w = world(); let probes = 0;
  const r = await queue(w, 'codex:Synthetic Sol', () => { probes++; throw new Error('must not probe'); });
  expect(r.code, r.err + r.out).toBe(0); expect(probes).toBe(0);
  expect(JSON.parse(r.out).donor.seat).toBe('alternate');
  expect(r.record!.to).toMatchObject({ cli: 'codex', vendor: 'openai', model: 'Synthetic Sol', launch: 'codex --model synthetic-sol' });
});
test('an unknown vendor with no matching donor refuses on the donor route without probing', async () => {
  const w = world(); let probes = 0;
  const r = await queue(w, 'unlisted:missing', () => { probes++; throw new Error('must not probe'); });
  expect(r.code).toBe(1); expect(probes).toBe(0); expect(r.record).toBeUndefined();
  expect(r.out).toContain('no seat of the entity'); expect(r.out).toContain('unlisted:missing');
});

for (const json of [false, true]) {
  test(`a missing item refuses with its add command and no stdin read (${json ? 'json' : 'text'})`, async () => {
    const w = world(); const asked: string[] = [];
    const r = await queue(w, 'zai:glm-5.3', item => { asked.push(item); return 'absent'; }, json);
    expect(r.code).toBe(1); expect(asked).toEqual(['glm-api-key']); expect(r.stdinReads).toBe(0);
    expect(r.record).toBeUndefined(); expect(fs.readFileSync(join(w.dir, 'team.yaml'), 'utf8')).toBe(w.yaml);
    const expected = '/usr/bin/security add-generic-password -s glm-api-key -a "$USER" -w';
    if (json) {
      const doc = JSON.parse(r.out); expect(doc.error.id).toBe('swap.target');
      expect(doc.error.repair).toBe(expected); expect(doc.error.message).toContain('"glm-api-key"');
    } else { expect(r.err).toContain('"glm-api-key"'); expect(r.err.trimEnd().endsWith(expected)).toBe(true); }
  });
}
test('an unavailable injected lookup refuses without an add command', async () => {
  const w = world(); const r = await queue(w, 'moonshot:kimi-k2.5', () => 'unavailable');
  expect(r.code).toBe(1); expect(r.record).toBeUndefined();
  const doc = JSON.parse(r.out); expect(doc.error.message).toContain('kimi-api-key'); expect(doc.error.repair).toBeNull();
});
test('an unknown vendor model refuses before asking for credential presence', async () => {
  const w = world(); let probes = 0;
  const r = await queue(w, 'zai:not-offered', () => { probes++; throw new Error('must not probe'); });
  expect(r.code).toBe(1); expect(probes).toBe(0); expect(r.record).toBeUndefined(); expect(r.out).toContain('offers no model');
});

for (const word of ['SYNTHETIC_VALUE=one two', 'SYNTHETIC_VALUE=one\ttwo', 'SYNTHETIC_VALUE=one\ntwo']) {
  test(`a vendor env entry containing unquoted whitespace refuses: ${JSON.stringify(word)}`, () => {
    const mutated = { ...profile, vendors: profile.vendors.map(v => v.name === 'zai' ? { ...v, env: [word] } : v) };
    let probes = 0;
    const plan = planVendorSwap(mutated, { name: 'subject', cli: 'claude-code', vendor: 'anthropic', launch: 'claude --model old' },
      'zai', 'glm-5.3', () => { probes++; throw new Error('invalid words must refuse before lookup'); });
    expect(plan.ok).toBe(false); expect(probes).toBe(0);
    if (!plan.ok) expect(plan.why).toContain('one assignment word');
  });
}
test('quoted whitespace inside one assignment word remains valid', () => {
  const mutated = { ...profile, vendors: profile.vendors.map(v => v.name === 'zai' ? { ...v, env: ['SYNTHETIC_VALUE="one two"'] } : v) };
  const plan = planVendorSwap(mutated, { name: 'subject', cli: 'claude-code', vendor: 'anthropic', launch: 'claude --model old' }, 'zai', 'glm-5.3', () => 'present');
  expect(plan.ok).toBe(true); if (plan.ok) expect(plan.recipe.launch).toBe('SYNTHETIC_VALUE="one two" claude --model glm-5.3');
});

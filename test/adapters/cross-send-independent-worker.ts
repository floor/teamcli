// Command modules are loaded only after proving this is a child-start synthetic HOME.
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const [scene, expectedHome, encodedPair] = process.argv.slice(2);
if (scene === undefined || expectedHome === undefined || homedir() !== realpathSync(expectedHome)) throw new Error('child-start synthetic HOME required');
const home = homedir();
const base = dirname(home);
const { runSend } = await import('../../src/commands/send.ts');
const { runGrant } = await import('../../src/commands/grant.ts');
const { testIo } = await import('../helpers.ts');
const { teamIdOf, upsertTeam } = await import('../../src/registry/teams.ts');
const { updateState } = await import('../../src/state.ts');
const { lobbyDir, lobbyTrustEntry, resolveLobby } = await import('../../src/lobby/gate.ts');
const { keyOf, signDomain } = await import('../../src/store/keys.ts');
const { readSendGrants } = await import('../../src/send/grants.ts');
const now = new Date();
const future = new Date(now.getTime() + 7 * 86_400_000).toISOString();
const roots: Record<string, string> = {};
const panes: { name: string; pane: string }[] = [];
const teams = [
  { name: 'design', entity: 'studio', lead: 'chief', seats: ['chief', 'architect'] },
  { name: 'product', entity: 'studio', lead: 'coordinator', seats: ['coordinator', 'worker'] },
  { name: 'foreign', entity: 'foreign', lead: 'orchestrator', seats: ['orchestrator'] },
];
mkdirSync(lobbyDir(home), { recursive: true });
for (const team of teams) {
  const root = join(base, team.name);
  roots[team.name] = root;
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  // The send loads the design root. Only that team's reach and registry key are teamIdOf(root).
  // The other teams stay addressable by their project name. Every team keeps its entity.
  const sender = team.name === 'design';
  const registryId = sender ? teamIdOf(root) : team.name;
  const roster = team.seats.map((name) => {
    const pane = `pane-${name}`;
    panes.push({ name, pane });
    const id = `agt_${createHash('sha256').update(`${team.name}:${name}`).digest('hex').slice(0, 12)}`;
    const folder = join(home, '.config', 'team', 'agents');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${id}.yaml`), [
      `id: ${id}`, `name: ${name}`, 'signing:', '  model: Test', '  version: "1"', `  role: ${name === 'architect' ? 'architect' : 'worker'}`,
      'lab: independent', 'cli: codex', 'launcher: null', 'launch: codex',
      'reach:', `  team: ${JSON.stringify(registryId)}`, `  session: ${JSON.stringify(team.name)}`, `  seat: ${JSON.stringify(name)}`, `  pane: ${pane}`, '  address: null',
      'mcp: []', 'skills: []', 'lifecycle: running', 'provenance:', '  registered_by: team up',
      `  registered_at: "${now.toISOString()}"`, `  updated_at: "${now.toISOString()}"`, '',
    ].join('\n'));
    return { agent: id, seat: name, role: name === 'architect' ? 'architect' : 'worker', ...(name === team.lead ? { leads: true as const } : {}) };
  });
  const seatLines = team.seats.map((name) => `  - role: ${name === 'architect' ? 'architect' : 'worker'}\n    name: ${name}\n    cli: codex\n    vendor: test\n    model: Test\n    version: "1"\n    launch: codex${name === team.lead ? '\n    leads: true' : ''}`).join('\n');
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1\nproject: ${team.name}\nentity: ${team.entity}\ncoordinator: ${team.lead}\noperator: ${team.lead}\nsession: ${team.name}\nworkspace:\n  mode: shared\ntrust:\n  - ${root}\n  - ${lobbyTrustEntry(home, { entity: team.entity })}\nseats:\n${seatLines}\ndelivery_order: [drop]\n`);
  upsertTeam(home, registryId, {
    project: team.name, entity: team.entity, root, session: team.name,
    lobby: sender ? resolveLobby(home, { entity: team.entity }) : lobbyDir(home),
    lifecycle: 'running', by: 'independent', roster,
  });
  updateState(join(root, '.agents'), (state) => {
    state.sessions[team.name] = { seats: Object.fromEntries(team.seats.map((name) => [name, { stage: 'launched' as const, pane: `pane-${name}`, workspace: 'fixture' }])), worktrees: {} };
  });
}
const source = roots.design!;
const grants = join(home, '.config', 'team', 'grants');
const grantName = 'architect-outbound';
const grantFile = join(grants, `${grantName}.json`);
const from = 'architect@design';
let to = 'orchestrator@studio';
let expires = future;
if (['unsigned', 'bad-signature', 'wrong-key', 'dry-unsigned', 'reissue'].includes(scene)) to = 'coordinator@product';
if (scene === 'other-entity') to = 'orchestrator@foreign';
if (scene === 'expired') expires = new Date(now.getTime() - 86_400_000).toISOString();
if (scene !== 'seat-issue' && scene !== 'general-pair') {
  mkdirSync(grants, { recursive: true });
  keyOf(home);
  const keyHome = scene === 'wrong-key' ? join(base, 'different-home') : home;
  const payload = { name: grantName, send: { from, to }, expires };
  const signature = signDomain('team-send-grant-v1\n', payload, keyOf(keyHome));
  const wire: Record<string, unknown> = { send: payload.send, expires };
  if (!['unsigned', 'dry-unsigned', 'reissue'].includes(scene)) wire.signature = scene === 'bad-signature' ? (signature[0] === '0' ? '1' : '0') + signature.slice(1) : signature;
  writeFileSync(grantFile, JSON.stringify(wire));
}
const caller = { kind: 'seat' as const, name: 'architect', pane: 'pane-architect', session: 'design' };
let paneWrites = 0;
const host = {
  agents: () => panes,
  processInfo: () => ({ shell: 700, foreground: [701] }),
  socketsDir: join(base, 'sockets'), home, now: () => now,
  deliver: async () => ({ ok: true as const }),
  native: { typeText: () => { paneWrites++; return false; }, pressEnter: () => { paneWrites++; return false; }, status: () => 'idle', wait: async () => {} },
};
mkdirSync(host.socketsDir);
const send = async (extra: string[] = []) => {
  const io = testIo(source, caller);
  const target = scene === 'non-lead' ? 'worker@product' : scene === 'other-entity' ? 'orchestrator@foreign' : 'coordinator@product';
  const code = await runSend([target, 'independent synthetic message', ...extra], io, host);
  return { code, out: io.out, err: io.err };
};
function records() {
  const found: { team: string; file: string; body: string }[] = [];
  for (const team of teams) {
    const dir = join(roots[team.name]!, '.agents', 'send-drops', team.name);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        const value = JSON.parse(readFileSync(join(entry.parentPath, entry.name), 'utf8'));
        if (typeof value.payload?.body === 'string') found.push({ team: team.name, file: entry.name, body: value.payload.body });
      } catch {}
    }
  }
  return found;
}
if (scene === 'general-pair') {
  const input = JSON.parse(encodedPair!) as { words: string[]; entities: string[]; expectedPair: { from: string; to: string } };
  const { main } = await import('../../src/cli.ts');
  const { newClientKeyPair, clientKeyDir, writeClientKeyFiles } = await import('../../src/client/records.ts');
  const { issueOwnerGeneralGrant } = await import('../../src/client/general-grant.ts');
  const id = (team: string, seat: string) => `agt_${createHash('sha256').update(`${team}:${seat}`).digest('hex').slice(0, 12)}`;
  const substitutions: Record<string, string> = { INSIDE_FROM: id('design', 'architect'), INSIDE_TO: id('product', 'coordinator'), OUTSIDE: id('foreign', 'orchestrator') };
  const substitute = (word: string) => word.replace(/\$([A-Z_]+)/g, (_match, key: string) => substitutions[key] ?? key);
  const pair = newClientKeyPair();
  const keys = writeClientKeyFiles(clientKeyDir(home, 'independent-pair'), pair);
  if (!keys.ok) throw new Error(keys.why);
  const general = issueOwnerGeneralGrant(home, { clientId: 'independent-pair', publicKey: pair.publicKey, entities: input.entities, ops: ['grant'], mayIssue: false, expires: new Date(future) });
  if (!general.ok) throw new Error(general.why);
  const io = testIo(source, { kind: 'unplaced', reason: 'synthetic external principal' });
  io.env = { HOME: home };
  const code = await main(['grant', '--send', ...input.words.map(substitute), '--expires', future, '--name', 'independent-pair', '--json', '--general', general.path, '--key', keys.keyPath], io);
  console.log(JSON.stringify({ code, out: io.out, err: io.err, home, verified: readSendGrants(home), grantFiles: existsSync(grants) ? readdirSync(grants) : [], expectedPair: { from: substitute(input.expectedPair.from), to: substitute(input.expectedPair.to) }, records: records(), paneWrites }));
} else if (scene === 'seat-issue') {
  const io = testIo(source, caller);
  const code = await runGrant(['--send', '--from', from, '--to', to, '--expires', future, '--name', grantName], io, { home });
  console.log(JSON.stringify({ code, out: io.out, err: io.err, issued: existsSync(grantFile), home }));
} else if (scene === 'reissue') {
  const before = await send();
  const line = before.err.split('\n').find((value) => value.startsWith('team grant --send'));
  // All fixture values are single shell words without embedded quote characters.
  const words = line === undefined ? [] : [...line.matchAll(/'([^']*)'|([^\s]+)/g)].map((match) => match[1] ?? match[2]!);
  let repair = { code: -1, out: '', err: '' };
  if (words[0] === 'team' && words[1] === 'grant') {
    const owner = testIo(source, { kind: 'owner' });
    const code = await runGrant(words.slice(2), owner, { home });
    repair = { code, out: owner.out, err: owner.err };
  }
  const after = await send();
  console.log(JSON.stringify({ before, line, words, repair, after, verified: readSendGrants(home), records: records(), paneWrites, home }));
} else {
  const result = await send(scene === 'dry-unsigned' ? ['--dry-run', '--json'] : ['--json']);
  console.log(JSON.stringify({ ...result, records: records(), paneWrites, home }));
}

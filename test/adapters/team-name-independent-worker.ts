// All stores and command logic run only in a child whose HOME was set at process start.
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const [scene, expectedHome] = process.argv.slice(2);
if (scene === undefined || expectedHome === undefined || homedir() !== realpathSync(expectedHome)) throw new Error('child-start synthetic HOME required');
const home = homedir();
const base = dirname(home);
const { runSend } = await import('../../src/commands/send.ts');
const { testIo } = await import('../helpers.ts');
const { registerAgent } = await import('../../src/registry/agents.ts');
const { teamIdOf, upsertTeam } = await import('../../src/registry/teams.ts');
const { upsertProject } = await import('../../src/registry/projects.ts');
const { updateState } = await import('../../src/state.ts');
const { lobbyDir, lobbyTrustEntry } = await import('../../src/lobby/gate.ts');
const { newClientKeyPair, clientKeyDir, writeClientKeyFiles, writeClientGrant } = await import('../../src/client/records.ts');
const roots: Record<string, string> = {};
const ids: Record<string, string> = {};
const agentIds: Record<string, string> = {};
const now = new Date();
mkdirSync(join(home, '.config', 'team'), { recursive: true });
writeFileSync(join(home, '.config', 'team', 'entities.yaml'), 'studio:\n  clients:\n    probe-bot:\n      seats: [orchestrator]\n');
mkdirSync(lobbyDir(home), { recursive: true });
const world = [
  { key: 'first', name: 'alpha', session: 'summer' },
  { key: 'second', name: 'beta', session: 'alpha' },
];
for (const team of world) {
  const root = join(base, team.key);
  const id = teamIdOf(root);
  roots[team.key] = root;
  ids[team.key] = id;
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const seats = ['orchestrator', 'op'];
  const roster = seats.map((name) => {
    const agent = registerAgent(home, {
      name, signing: { model: 'Test', version: '1', role: name }, lab: 'independent', cli: 'codex', launcher: null, launch: 'codex',
      reach: { team: id, seat: name, session: team.session, pane: `pane-${team.key}-${name}`, address: null },
      mcp: [], skills: [], lifecycle: 'running', by: 'independent',
    });
    if (name === 'orchestrator') agentIds[team.key] = agent.id;
    return { agent: agent.id, seat: name, role: name, ...(name === 'orchestrator' ? { leads: true as const } : {}) };
  });
  const seatText = seats.map((name) => `  - role: ${name}\n    name: ${name}\n    cli: codex\n    vendor: test\n    model: Test\n    version: "1"\n    launch: codex${name === 'orchestrator' ? '\n    leads: true' : ''}`).join('\n');
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1\nproject: ${team.name}\nentity: studio\nin_project: portfolio\ncoordinator: orchestrator\noperator: op\nsession: ${team.session}\nworkspace:\n  mode: shared\ntrust:\n  - ${root}\n  - ${lobbyDir(home)}\n  - ${lobbyTrustEntry(home, { entity: 'studio' })}\nclients:\n  probe-bot:\n    seats: [orchestrator]\nseats:\n${seatText}\ndelivery_order: [drop]\n`);
  upsertTeam(home, id, { project: team.name, projectId: 'portfolio', entity: 'studio', root, session: team.session, lobby: lobbyDir(home), lifecycle: 'running', by: 'independent', roster });
  updateState(join(root, '.agents'), (state) => {
    state.sessions[team.session] = { seats: Object.fromEntries(seats.map((name) => [name, { stage: 'launched' as const, pane: `pane-${team.key}-${name}`, workspace: `space-${team.key}`, start_cwd: root }])), worktrees: {} };
  });
}
upsertProject(home, 'portfolio', { name: 'portfolio', entity: 'studio', lead: agentIds.first!, teams: Object.values(ids), by: 'independent' });
if (['ambiguous-name', 'client-ambiguous'].includes(scene)) upsertTeam(home, ids.second!, { project: 'alpha' });
if (scene === 'ambiguous-session') upsertTeam(home, ids.second!, { session: 'summer' });
let paneWrites = 0;
const host = {
  agents: () => world.flatMap((team) => ['orchestrator', 'op'].map((name) => ({ name, pane: `pane-${team.key}-${name}` }))),
  processInfo: () => ({ shell: 800, foreground: [801] }),
  socketsDir: join(base, 'sockets'), home, now: () => now,
  deliver: async () => ({ ok: true as const }),
  native: { typeText: () => { paneWrites++; return false; }, pressEnter: () => { paneWrites++; return false; }, status: () => 'idle', wait: async () => {} },
};
mkdirSync(host.socketsDir);
function records() {
  const found: { team: string; body: string; toId: string }[] = [];
  for (const [key, root] of Object.entries(roots)) {
    const dir = join(root, '.agents', 'send-drops');
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        const value = JSON.parse(readFileSync(join(entry.parentPath, entry.name), 'utf8'));
        if (typeof value.payload?.body === 'string') found.push({ team: key, body: value.payload.body, toId: value.payload.to_id });
      } catch {}
    }
  }
  return found;
}
const io = testIo(roots.first!, { kind: 'owner' });
let code: number;
let grantResult: { ok: boolean; why?: string } | undefined;
let grantTarget: string | undefined;
if (scene.startsWith('client-')) {
  const pair = newClientKeyPair();
  const dir = clientKeyDir(home, 'probe-bot');
  const files = writeClientKeyFiles(dir, pair);
  if (!files.ok) throw new Error(files.why);
  const team = scene === 'client-session' ? 'summer' : scene === 'client-project-only' ? 'portfolio' : 'alpha';
  const issued = writeClientGrant(home, { clientId: 'probe-bot', entity: 'studio', team, publicKey: pair.publicKey, keyId: pair.keyId, keyDir: dir }, { now });
  grantResult = issued.ok ? { ok: true } : { ok: false, why: issued.why };
  if (!issued.ok) {
    code = 1;
    io.stderr(issued.why);
  } else {
    grantTarget = issued.grant.teamId;
    if (scene === 'client-pinned') upsertTeam(home, ids.second!, { project: 'alpha' });
    const client = { ...io, caller: { kind: 'unplaced' as const, reason: 'synthetic external client' } };
    code = await runSend(['--client', issued.path, '--key', files.keyPath, `orchestrator@${team}`, 'independent client routing probe'], client, host);
  }
} else {
  let address = 'orchestrator@alpha';
  if (scene === 'by-session' || scene === 'ambiguous-session') address = 'orchestrator@summer';
  if (scene === 'by-team-id') address = `orchestrator@${ids.first!}`;
  if (scene === 'by-agent-id') address = agentIds.first!;
  if (scene === 'project-only') address = 'orchestrator@portfolio';
  code = await runSend([address, 'independent plain routing probe'], io, host);
}
console.log(JSON.stringify({ code, out: io.out, err: io.err, ids, agentIds, records: records(), paneWrites, grantResult, grantTarget, home }));

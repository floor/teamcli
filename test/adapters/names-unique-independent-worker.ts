// Every import that can open a store follows this child-start HOME check.
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const [expectedHome, encoded] = process.argv.slice(2);
if (!expectedHome || !encoded || homedir() !== realpathSync(expectedHome)) throw new Error('child-start synthetic HOME required');
const input = JSON.parse(encoded) as { action: string; scope?: string; relation?: string; map?: boolean; word?: string; actor?: string; json?: boolean };
const home = homedir();
const base = dirname(home);
const now = new Date();
const { testIo, CLAUDE_IDLE, deliverBriefs } = await import('../helpers.ts');
const { runConfig } = await import('../../src/commands/config.ts');
const { importTeamFile } = await import('../../src/file/team-import.ts');
const { readStoredTeamConfig } = await import('../../src/registry/team-config-store.ts');
const { teamIdOf, upsertTeam, getTeam } = await import('../../src/registry/teams.ts');
const { registerLaunch, registerEnd } = await import('../../src/registry/sync.ts');
const { readAgents } = await import('../../src/registry/agents.ts');
const { validateTeamFile } = await import('../../src/file/validate.ts');
const { newClientKeyPair, clientKeyDir, writeClientKeyFiles } = await import('../../src/client/records.ts');
const { issueOwnerGeneralGrant } = await import('../../src/client/general-grant.ts');
const { lobbyDir, lobbyTrustEntry } = await import('../../src/lobby/gate.ts');
const entityFile = join(home, '.config', 'team', 'entities.yaml');
mkdirSync(dirname(entityFile), { recursive: true });
writeFileSync(entityFile, `# independent entity words\natelier:\n  roots: [${base}]\n${input.scope === undefined ? '' : `  names:\n    unique: "${input.scope}"\n`}other:\n  roots: [${base}]\n  names:\n    unique: team\n`);
const seatText = (name: string, role: string, persona: string, nickname = persona) => `  - name: ${name}\n    role: ${role}\n    label: ${persona} · ${role}\n    nickname: ${nickname}\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n${name === 'chief' ? '    leads: true\n' : ''}`;
function teamText(name: string, project: string, entity: string, persona: string, nickname = persona) {
  return `format: 1\nproject: ${name}\nin_project: ${project}\nentity: ${entity}\noperator: chief\nsession: ${name}\ntrust:\n  - ${join(base, name)}\n  - ${lobbyDir(home)}\n  - ${lobbyTrustEntry(home, { entity })}\nworkspace:\n  mode: shared\ndelivery_order: [drop]\nsender_name: nickname\nseats:\n${seatText('chief', 'orchestrator', `${name}-chief`)}${seatText('reviewer', 'reviewer', persona, nickname)}`;
}
const roots: Record<string, string> = {};
const texts: Record<string, string> = {};
for (const [name, project, entity, persona] of [
  ['consumer', 'web', 'atelier', input.action === 'check' ? 'Cobalt' : 'Lyra'],
  ['producer', 'web', input.relation === 'other-entity' ? 'other' : 'atelier', 'Cobalt'],
  ['api', 'edge', 'atelier', 'Orion'],
]) {
  const root = join(base, name!);
  roots[name!] = root;
  const text = teamText(name!, project!, entity!, persona!, input.action === 'launch' || input.action === 'retired' ? 'OldEcho' : persona!);
  texts[name!] = text;
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  const imported = importTeamFile({ cwd: root, home, mode: 'migrate' });
  if (!imported.ok) throw new Error(JSON.stringify(imported.errors));
  upsertTeam(home, teamIdOf(root), { project: name!, entity, root, session: name!, lifecycle: 'running', roster: [], by: 'independent' });
}
const root = roots.consumer!;
const stored = () => readStoredTeamConfig(home, teamIdOf(root))?.text ?? '';
const parsed = (text: string) => {
  const loaded = validateTeamFile(text);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return loaded.team;
};
const sources = { home, env: { TEAM_CONFIG_SOURCE: 'registry' }, now: () => now };
function grant(entities: string[] = ['*'], ops: ('config' | '*')[] = ['config']) {
  const pair = newClientKeyPair();
  const key = writeClientKeyFiles(clientKeyDir(home, 'independent-names'), pair);
  if (!key.ok) throw new Error(key.why);
  const made = issueOwnerGeneralGrant(home, { clientId: 'independent-names', publicKey: pair.publicKey, entities, ops, mayIssue: false, expires: new Date(now.getTime() + 86_400_000) });
  if (!made.ok) throw new Error(made.why);
  return ['--general', made.path, '--key', key.keyPath];
}
function result(code: number, io: ReturnType<typeof testIo>) { return { code, out: io.out, err: io.err }; }
const finish = (data: unknown) => console.log(JSON.stringify({ home, ...data as object }));
if (input.action === 'config') {
  const before = stored();
  const io = testIo(root, { kind: 'unplaced', reason: 'synthetic grant principal' });
  const persona = input.relation === 'other-project' ? 'oRiOn' : 'cObAlT';
  const value = input.map ? `{name: reviewer, role: reviewer, label: "${persona} · reviewer", nickname: ${persona}, cli: claude-code, vendor: anthropic, model: Claude Opus, version: "5.5", launch: claude --model claude-opus-5-5}` : `${persona} · reviewer`;
  const code = await runConfig(['set', input.map ? 'seats.reviewer' : 'seats.reviewer.label', value, '--json', ...grant()], io, sources);
  finish({ ...result(code, io), before, after: stored() });
} else if (input.action === 'entity') {
  const before = readFileSync(entityFile, 'utf8');
  const io = testIo(base, input.actor === 'owner' ? { kind: 'owner' } : { kind: 'seat', name: 'reviewer', pane: 'synthetic-reviewer-pane' });
  const options = input.actor === 'wildcard' ? grant() : input.actor === 'scoped' ? grant(['atelier']) : [];
  const flags = input.json ? ['--json'] : [];
  const code = await runConfig(['set', 'atelier.names.unique', input.word!, ...flags, ...options], io, sources);
  const getIo = testIo(base, { kind: 'seat', name: 'reviewer', pane: 'synthetic-reviewer-pane' });
  const got = await runConfig(['get', 'atelier.names.unique', ...flags], getIo, sources);
  finish({ ...result(code, io), get: result(got, getIo), before, after: readFileSync(entityFile, 'utf8') });
} else if (input.action === 'init') {
  const { writeArchive } = await import('../../src/commands/archive.ts');
  const { runInit } = await import('../../src/commands/init.ts');
  const target = join(base, 'newteam');
  const archived = join(base, 'archived');
  mkdirSync(join(archived, '.agents'), { recursive: true });
  mkdirSync(target);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: target, stdio: 'ignore' });
  const text = teamText('newteam', 'web', 'atelier', 'cObAlT');
  const file = join(archived, '.agents', 'team.yaml');
  writeFileSync(file, text);
  const archive = writeArchive({ file, root: archived, project: 'newteam', session: 'newteam', home, out: join(base, 'archive'), caller: 'owner', now, dry: false });
  if (!archive.ok) throw new Error(archive.reason);
  const io = testIo(target, { kind: 'owner' });
  const code = await runInit(['--from-archive', archive.dir, '--json'], io, home, undefined, { loggedIn: () => false, registryHome: home, now: () => now });
  finish({ ...result(code, io), created: readStoredTeamConfig(home, teamIdOf(target))?.text ?? '', fileWritten: existsSync(join(target, '.agents', 'team.yaml')) });
} else if (input.action === 'check') {
  const { runTeamCheck } = await import('../../src/check/team.ts');
  const { emptySession, updateState } = await import('../../src/state.ts');
  const { displayAgent, workspaceLabel } = await import('../../src/file/sections/seats.ts');
  const { approvalStanding } = await import('../../src/store/store.ts');
  const team = parsed(stored());
  team.seats.forEach((seat, index) => {
    const registered = registerLaunch({ home, root, team, by: 'independent', owner: true }, seat, `synthetic-pane-${index}`);
    if (!('id' in registered)) throw new Error(registered.note);
  });
  updateState(join(root, '.agents'), (state) => {
    const session = state.sessions[team.session] ??= emptySession();
    session.watch = { pid: process.pid, heartbeat: now.toISOString() };
    team.seats.forEach((seat, index) => { session.seats[seat.name] = { stage: 'ready', pane: `synthetic-pane-${index}`, workspace: `synthetic-workspace-${index}` }; });
  });
  deliverBriefs({ dir: join(root, '.agents'), root, session: team.session, seats: team.seats.map((seat) => seat.name), home, at: now.toISOString() });
  const io = testIo(root, { kind: 'owner' });
  const code = runTeamCheck({}, io, {
    home, branch: () => 'main', now: () => now, standing: (at) => approvalStanding(at, join(root, 'no-store')),
    live: () => ({ running: true, agents: team.seats.map((seat, index) => ({ name: seat.name, agent: 'claude', pane: `synthetic-pane-${index}`, workspace: `synthetic-workspace-${index}`, status: 'idle', cwd: null, displayAgent: displayAgent(seat) })), workspaces: team.seats.map((seat, index) => ({ id: `synthetic-workspace-${index}`, label: workspaceLabel(seat) })), screens: Object.fromEntries(team.seats.map((_, index) => [`synthetic-pane-${index}`, CLAUDE_IDLE])) }),
  });
  finish(result(code, io));
} else {
  const { runUp } = await import('../../src/commands/up.ts');
  const { runSend } = await import('../../src/commands/send.ts');
  let team = parsed(stored());
  const registry = () => ({ home, root, team, by: 'independent', owner: true });
  let oldId: string | undefined;
  if (input.action === 'retired') {
    const oldTeam = { ...team, seats: team.seats.map((seat) => seat.name === 'reviewer' ? { ...seat, label: 'OldEcho · reviewer', nickname: 'OldEcho' } : seat) };
    const old = registerLaunch({ ...registry(), team: oldTeam }, oldTeam.seats[1]!, 'synthetic-retired-pane');
    if (!('id' in old)) throw new Error(old.note);
    oldId = old.id;
    registerEnd({ ...registry(), team: oldTeam }, 'reviewer', 'retired');
  }
  const launched = team.seats.map((seat, index) => registerLaunch(registry(), seat, `synthetic-pane-${index}`));
  const ids = launched.map((value) => { if (!('id' in value)) throw new Error(value.note); return value.id; });
  const { emptySession, updateState } = await import('../../src/state.ts');
  updateState(join(root, '.agents'), (state) => {
    const session = state.sessions[team.session] ??= emptySession();
    team.seats.forEach((seat, index) => { session.seats[seat.name] = { stage: 'launched', pane: `synthetic-pane-${index}`, workspace: `synthetic-workspace-${index}` }; });
  });
  const beforeAgent = readAgents(home).find((agent) => agent.id === ids[1]);
  const planIo = testIo(root, { kind: 'owner' });
  const planCode = await runUp(['--dry-run', '--json'], planIo, { home, sessionRunning: () => false, agents: () => [], now: () => now });
  let paneWrites = 0;
  const send = async () => {
    const io = testIo(root, { kind: 'seat', name: 'reviewer', pane: 'synthetic-pane-1', session: team.session });
    const code = await runSend(['chief', 'independent persona message', '--json'], io, {
      home, socketsDir: join(base, 'sockets'), now: () => now,
      agents: () => team.seats.map((seat, index) => ({ name: seat.name, pane: `synthetic-pane-${index}` })),
      processInfo: () => ({ shell: 700, foreground: [701] }), deliver: async () => ({ ok: true as const }),
      native: { typeText: () => { paneWrites++; return false; }, pressEnter: () => { paneWrites++; return false; }, status: () => 'idle', wait: async () => {} },
    });
    const folder = join(root, '.agents', 'send-drops', team.session);
    const bodies: string[] = [];
    if (existsSync(folder)) for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try { const wire = JSON.parse(readFileSync(join(entry.parentPath, entry.name), 'utf8')); if (typeof wire.payload?.body === 'string') bodies.push(wire.payload.body); } catch {}
    }
    return { ...result(code, io), bodies };
  };
  mkdirSync(join(base, 'sockets'));
  const before = await send();
  let edit: ReturnType<typeof result> | undefined;
  if (input.action === 'rename') {
    const io = testIo(root, { kind: 'unplaced', reason: 'synthetic grant principal' });
    const code = await runConfig(['set', 'seats.reviewer.label', 'Kestrel · reviewer', ...grant()], io, sources);
    edit = result(code, io);
    team = parsed(stored());
  }
  const after = await send();
  const afterAgent = readAgents(home).find((agent) => agent.id === ids[1]);
  finish({ plan: result(planCode, planIo), before, edit, after, paneWrites, oldId, id: ids[1], beforeAgent, afterAgent, roster: getTeam(home, teamIdOf(root))?.roster });
}

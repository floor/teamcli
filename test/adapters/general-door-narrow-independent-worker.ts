// This worker loads command and store modules only after checking its child-start HOME.
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Io } from '../../src/io.ts';
import type { GrantOp } from '../../src/client/general-grant.ts';
const [expectedHome, encoded] = process.argv.slice(2);
if (expectedHome === undefined || encoded === undefined || homedir() !== realpathSync(expectedHome)) throw new Error('child-start synthetic HOME required');
const input = JSON.parse(encoded) as { command: string; words: string[]; entities: string[]; ops: GrantOp[]; mode?: 'daemon' | 'config' | 'up' };
const home = homedir();
const base = dirname(home);
const { main, commands } = await import('../../src/cli.ts');
const { generalDoor } = await import('../../src/client/general-door.ts');
const { issueOwnerGeneralGrant } = await import('../../src/client/general-grant.ts');
const { newClientKeyPair, clientKeyDir, writeClientKeyFiles } = await import('../../src/client/records.ts');
const { importTeamFile } = await import('../../src/file/team-import.ts');
const { teamIdOf, upsertTeam } = await import('../../src/registry/teams.ts');
const { upsertProject } = await import('../../src/registry/projects.ts');
const { registerAgent } = await import('../../src/registry/agents.ts');
const { readStoredTeamConfig } = await import('../../src/registry/team-config-store.ts');
const { lobbyDir, lobbyTrustEntry } = await import('../../src/lobby/gate.ts');
const { testIo } = await import('../helpers.ts');
const roots: Record<string, string> = {};
const files: Record<string, string> = {};
const ids: Record<string, string> = {};
mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
for (const entity of ['alpha', 'beta']) {
  const root = join(base, entity);
  roots[entity] = root;
  ids[entity] = teamIdOf(root);
  files[entity] = join(root, '.agents', 'team.yaml');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const text = `format: 1\nproject: ${entity}\nentity: ${entity}\ncoordinator: chief\noperator: chief\nsession: ${entity}\nworkspace:\n  mode: shared\ntrust:\n  - ${root}\n  - ${lobbyDir(home)}\n  - ${lobbyTrustEntry(home, { entity })}\nseats:\n  - role: coordinator\n    name: chief\n    cli: codex\n    vendor: test\n    model: Test\n    version: "1"\n    launch: codex\n    leads: true\n  - role: worker\n    name: worker\n    cli: codex\n    vendor: test\n    model: Test\n    version: "1"\n    launch: codex\n`;
  writeFileSync(files[entity]!, text);
  const imported = importTeamFile({ cwd: root, home, mode: 'migrate' });
  if (!imported.ok) throw new Error(JSON.stringify(imported.errors));
  upsertTeam(home, ids[entity]!, { project: entity, entity, root, session: entity, lobby: lobbyDir(home), lifecycle: 'running', roster: [], by: 'independent' });
  upsertProject(home, `${entity}-project`, { name: `${entity}-project`, entity, teams: [ids[entity]!], by: 'independent' });
}
const betaAgent = registerAgent(home, {
  name: 'worker', signing: { model: 'Test', version: '1', role: 'worker' }, lab: 'synthetic', cli: 'codex', launcher: null, launch: 'codex',
  reach: { team: ids.beta!, session: 'beta', seat: 'worker', pane: 'synthetic-beta-pane', address: null },
  mcp: [], skills: [], lifecycle: 'running', by: 'independent',
});
upsertTeam(home, ids.beta!, { roster: [{ agent: betaAgent.id, seat: 'worker', role: 'worker' }] });
const pair = newClientKeyPair();
const keyFiles = writeClientKeyFiles(clientKeyDir(home, 'scope-probe'), pair);
if (!keyFiles.ok) throw new Error(keyFiles.why);
const grant = issueOwnerGeneralGrant(home, { clientId: 'scope-probe', publicKey: pair.publicKey, entities: input.entities, ops: input.ops, mayIssue: false, expires: new Date(Date.now() + 86_400_000) });
if (!grant.ok) throw new Error(grant.why);
const substitutions: Record<string, string> = {
  A_FILE: files.alpha!, B_FILE: files.beta!, A_ROOT: roots.alpha!, B_ROOT: roots.beta!, B_ID: ids.beta!, B_AGENT: betaAgent.id, MISSING_FILE: join(base, 'absent', 'team.yaml'),
};
const words = input.words.map((word) => word.replace(/\$([A-Z_]+)/g, (_match, key: string) => substitutions[key] ?? key));
const io = testIo(roots.alpha!, { kind: 'unplaced', reason: 'synthetic external principal' });
io.env = { HOME: home, TEAM_CONFIG_SOURCE: 'registry' };
const options = ['--general', grant.path, '--key', keyFiles.keyPath];
const marker = join(base, 'command-called');
const storeRoot = join(home, '.config', 'team');
function storeSnapshot() {
  return new Map(readdirSync(storeRoot, { recursive: true, withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile()) return [];
    const path = join(entry.parentPath, entry.name);
    return [[path, readFileSync(path).toString('base64')] as const];
  }));
}
const storeBefore = storeSnapshot();
let calls = 0;
let calledAs: Io['caller'];
let received: string[] = [];
let servicePlans = 0;
let serviceInstalls = 0;
let code: number;
let storedModel: string | undefined;
let upReads = 0;
if (input.mode === 'daemon') {
  const { runDaemon } = await import('../../src/commands/daemon.ts');
  const door = generalDoor('daemon', [...words, ...options], io);
  if (door.kind !== 'admitted') {
    code = 1;
    io.stderr('door result: ' + door.kind);
  } else {
    calledAs = door.io.caller;
    code = await runDaemon(door.argv, door.io, {
      home, program: { execPath: '/synthetic/runtime', entry: '/synthetic/entry.js' },
      service: {
        kind: 'system-service-manager',
        unitPath: () => join(base, 'synthetic-unit'),
        plan: (_home, program) => { servicePlans++; return { unitPath: join(base, 'synthetic-unit'), program: [program.execPath, program.entry] }; },
        install: () => { serviceInstalls++; return { ok: true, unitPath: join(base, 'synthetic-unit') }; },
        uninstall: () => ({ ok: true, unitPath: join(base, 'synthetic-unit'), removed: false }),
      },
    });
  }
} else if (input.mode === 'up') {
  const { runUp } = await import('../../src/commands/up.ts');
  code = await runUp([...words, ...options], io, {
    home,
    sessionRunning: () => { upReads++; return false; },
    agents: () => { upReads++; return []; },
  });
} else if (input.mode === 'config') {
  const { runConfig } = await import('../../src/commands/config.ts');
  code = await runConfig([...words, ...options], io, { home, env: { TEAM_CONFIG_SOURCE: 'registry' } });
  const stored = readStoredTeamConfig(home, ids.alpha!);
  storedModel = stored?.text;
} else {
  commands[input.command] = async () => ({
    USAGE: 'synthetic command surface',
    default: async (argv, commandIo) => {
      calls++;
      calledAs = commandIo.caller;
      received = argv;
      writeFileSync(marker, 'synthetic command reached\n');
      return 0;
    },
  });
  code = await main([input.command, ...words, '--json', ...options], io);
}
const storeAfter = storeSnapshot();
const storeChanges = [...new Set([...storeBefore.keys(), ...storeAfter.keys()])].filter((path) => storeBefore.get(path) !== storeAfter.get(path));
console.log(JSON.stringify({ storeChanges, home, code, out: io.out, err: io.err, calls, calledAs, received, marker: existsSync(marker), servicePlans, serviceInstalls, storedModel, upReads, originalFile: readFileSync(files.alpha!, 'utf8') }));

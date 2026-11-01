import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const [scene, expectedHome] = process.argv.slice(2);
if (scene === undefined || expectedHome === undefined || homedir() !== realpathSync(expectedHome)) throw new Error('child-start synthetic HOME required');
const home = homedir();
const base = dirname(home);
const { testIo } = await import('../helpers.ts');
if (scene === 'help') {
  const { main } = await import('../../src/cli.ts');
  const io = testIo(base, { kind: 'owner' });
  const code = await main(['config', '--help'], io);
  console.log(JSON.stringify({ home, code, out: io.out, err: io.err }));
} else if (scene.startsWith('roster-')) {
  const rosterModule = await import('../../src/client/client-form.ts') as unknown as Record<string, unknown>;
  const renderRoster = rosterModule.clientRosterText ?? rosterModule.rosterApprovalText;
  if (typeof renderRoster !== 'function') throw new Error('no roster formatter is exported');
  const [, op, bundle] = scene.split('-');
  // A formatter fixture, not an authority fixture: these are the fields its text contract reads.
  const run = { grant: { grantId: 'cg_0123456789abcdef01234567', clientId: 'fixture-client', bundle, up: { project: 'sample' } }, root: join(base, 'repo') };
  const text = renderRoster(op, 'worker-two', run);
  console.log(JSON.stringify({ home, text }));
} else {
  const { runConfig } = await import('../../src/commands/config.ts');
  const { runMigrate } = await import('../../src/commands/migrate.ts');
  const { validateTeamFile } = await import('../../src/file/validate.ts');
  const { importTeamFile } = await import('../../src/file/team-import.ts');
  const { readStoredTeamConfig } = await import('../../src/registry/team-config-store.ts');
  const { teamIdOf } = await import('../../src/registry/teams.ts');
  const { approvalOf } = await import('../../src/approve/approval.ts');
  const { writeApproval, storePath, approvalStanding } = await import('../../src/store/store.ts');
  const { bumpGeneration } = await import('../../src/store/keys.ts');
  const { lobbyDir, lobbyTrustEntry } = await import('../../src/lobby/gate.ts');
  const root = join(base, 'repo');
  const file = join(root, '.agents', 'team.yaml');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const seats = ['chief', 'worker'].map((name) => `  - role: ${name === 'chief' ? 'coordinator' : 'worker'}\n    name: ${name}\n    label: ${name}\n    cli: codex\n    vendor: test\n    model: Test\n    version: "1"\n    launch: codex${name === 'chief' ? '\n    leads: true' : ''}`).join('\n');
  const text = `format: 1\nproject: sample\ncoordinator: chief\noperator: chief\nsession: sample\nworkspace:\n  mode: shared\ntrust:\n  - ${root}\n  - ${lobbyDir(home)}\n  - ${lobbyTrustEntry(home)}\nseats:\n${seats}\n`;
  writeFileSync(file, text);
  if (scene !== 'migrate') {
    const imported = importTeamFile({ cwd: root, home, mode: 'migrate' });
    if (!imported.ok) throw new Error(JSON.stringify(imported.errors));
  }
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const now = new Date();
  const store = storePath('sample', root, home);
  writeApproval(store, { approval: approvalOf(parsed.team, root, now), file: text }, [], home, now);
  const approvalFile = join(store, 'approval.json');
  const oldSnapshot = readFileSync(approvalFile);
  const before = approvalStanding(root, home).kind;
  const io = testIo(root, { kind: 'owner' });
  let code: number;
  let label: string | undefined;
  if (scene === 'migrate') {
    writeFileSync(file, text.replace('label: worker', 'label: revised-worker').replace('seats:\n', 'limits:\n  temporary: 1\nseats:\n'));
    let advanced = false;
    code = await runMigrate(['--keep-file'], io, { home, now: () => {
      // Simulate an independent key-generation advance during the move; the stored snapshot
      // stays byte-identical, and the historical report must describe its actual standing.
      if (!advanced) { advanced = true; bumpGeneration(root, home, now); }
      return now;
    } });
  } else {
    const whole = scene.startsWith('whole-');
    const unchanged = scene === 'unchanged-json';
    const value = whole ? JSON.stringify({ role: 'worker', name: 'worker', label: 'Revised Worker', cli: 'codex', vendor: 'test', model: 'Test', version: '1', launch: 'codex' }) : unchanged ? 'worker' : 'Revised Worker';
    code = await runConfig(['set', whole ? 'seats.worker' : 'seats.worker.label', value, ...(scene.endsWith('-json') ? ['--json'] : [])], io, { home, env: { TEAM_CONFIG_SOURCE: 'registry' } });
    const saved = readStoredTeamConfig(home, teamIdOf(root));
    if (saved !== null) {
      const checked = validateTeamFile(saved.text);
      if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
      label = checked.team.seats.find((seat) => seat.name === 'worker')?.label;
    }
  }
  console.log(JSON.stringify({ home, code, out: io.out, err: io.err, label, before, after: approvalStanding(root, home).kind, snapshotUnchanged: readFileSync(approvalFile).equals(oldSnapshot) }));
}

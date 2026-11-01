import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [scene, expectedHome, encodedRule = '[]'] = process.argv.slice(2);
if (scene === undefined || expectedHome === undefined || homedir() !== realpathSync(expectedHome)) throw new Error('child-start synthetic HOME required');
const home = homedir();
const base = dirname(home);
const { loadScreen } = await import('../../src/watch/screen-file.ts');
const fields = JSON.parse(encodedRule) as string[];
if (scene === 'load-rule') {
  const text = `format: 1\ncli: independent\nscreen:\n  rate_limit:\n    rules:\n      - ${fields.join('\n        ')}\n  composer:\n    mode: box-to-rule\n    prompt: '^>'\n    rule: '^-{8}'\n    placeholders:\n      - equals: ''\n`;
  try {
    const loaded = loadScreen(text);
    console.log(JSON.stringify({ home, accepted: true, withoutRule: loaded.rate_limit?.rules[0]?.withoutRule }));
  } catch (error) {
    const problem = error as Error & { line?: number };
    console.log(JSON.stringify({ home, accepted: false, line: problem.line, message: problem.message }));
  }
} else if (scene === 'shipped') {
  const { profileFor } = await import('../../src/profiles/profile.ts');
  const folder = fileURLToPath(new URL('../../src/profiles/', import.meta.url));
  const loaded = readdirSync(folder).filter((file) => file.endsWith('.yaml')).map((file) => {
    const path = join(folder, file);
    const profile = profileFor(file.slice(0, -5));
    const screen = loadScreen(readFileSync(path, 'utf8'), folder, path);
    return { name: file.slice(0, -5), profile: profile?.cli, composer: screen.composer !== undefined };
  });
  console.log(JSON.stringify({ home, loaded }));
} else {
  const { parseOverrides, overridesPath } = await import('../../src/profiles/overrides.ts');
  const override = `format: 1\nprofiles:\n  codex:\n    screen:\n      permission:\n        - on_footer: true\n`;
  if (scene === 'override') {
    console.log(JSON.stringify({ home, parsed: parseOverrides(override) }));
  } else {
    const { runDoctor } = await import('../../src/commands/doctor.ts');
    const { runStatus } = await import('../../src/commands/status.ts');
    const { verifiedOf } = await import('../../src/approve/approval.ts');
    const { validateTeamFile } = await import('../../src/file/validate.ts');
    const { lobbyDir, lobbyTrustEntry } = await import('../../src/lobby/gate.ts');
    const { testIo } = await import('../helpers.ts');
    const root = join(base, 'repo');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
    execFileSync('git', ['init', '-q'], { cwd: root });
    const text = `format: 1\nproject: sample\ncoordinator: chief\noperator: op\nsession: sample\nworkspace:\n  mode: shared\ntrust:\n  - ${root}\n  - ${lobbyDir(home)}\n  - ${lobbyTrustEntry(home)}\nseats:\n  - role: coordinator\n    name: chief\n    cli: codex\n    vendor: test\n    model: Test\n    version: "1"\n    launch: codex\n    leads: true\n  - role: operator\n    name: op\n    cli: codex\n    vendor: test\n    model: Test\n    version: "1"\n    launch: codex\n`;
    const file = join(root, '.agents', 'team.yaml');
    writeFileSync(file, text);
    const parsed = validateTeamFile(text);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const now = new Date();
    const standing = verifiedOf(parsed.team, text, root, now);
    const path = overridesPath('sample', root, home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, override);
    const io = testIo(root, { kind: 'owner' });
    const flags = ['--file', file, ...(scene.endsWith('-json') ? ['--json'] : [])];
    const code = scene.startsWith('doctor-')
      ? await runDoctor(flags, io, { version: () => '0.161.0', onPath: () => true, loggedIn: () => true, herdrVersion: () => '0.7.1', sessionRunning: () => false, now: () => now, home, standing: () => standing, command: () => null, runCheck: () => null })
      : await runStatus(flags, io, { live: () => ({ running: true, agents: [], workspaces: [], screens: {} }), branch: () => 'main', standing: () => standing, now: () => now, home, alive: () => false });
    console.log(JSON.stringify({ home, code, out: io.out, err: io.err, overridePath: path }));
  }
}

// The cleaning at its boundaries. The commands now wrap every printed finding and line in the
// plain-text cleaning, so a terminal never acts on bytes that came from a pane or the team file.
// The pins here are the three edges the unit tests leave open: a version read that carries a
// whole OSC payload (title-setting, not just a color), the promise that cleaning is presentation
// only — the exits do not move — and the `--json` line, where the bytes are data and must stay
// parseable while the raw escape never reaches the terminal.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { testIo } from './helpers.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const NOW = new Date('2026-10-12T20:00:00Z');

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'team-doctor-clean-bnd-'));
  mkdirSync(join(dir, '.agents'));
  return dir;
}

// A valid file whose one dirty field is a display label: every command accepts the file, and the
// label is the string the cleaning has to strip.
function dirtyFile(): string {
  const file = example.replace('display: DeepSeek V4.1 Flash', 'display: "DeepSeek\\u001b[31m V4.1 Flash"');
  const parsed = validateTeamFile(file);
  if (!parsed.ok) throw new Error(`the dirty fixture no longer validates: ${parsed.errors[0]?.message}`);
  return file;
}

const doctorSources: DoctorSources = {
  version: () => '2.1.288 (Claude Code)',
  onPath: () => true,
  loggedIn: () => true,
  herdrVersion: () => '0.7.1',
  sessionRunning: () => false,
  now: () => NOW,
  home: '',
};

const statusSources: StatusSources = {
  live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
  branch: () => 'main',
  standing: () => ({ kind: 'none' }),
  now: () => NOW,
  home: '',
};

test('a version read that carries a whole OSC payload is dropped, payload and all', async () => {
  const dir = project();
  try {
    writeFileSync(join(dir, '.agents', 'team.yaml'), example);
    const io = testIo(dir, { kind: 'owner' });
    await runDoctor(['--file', '.agents/team.yaml'], io, {
      ...doctorSources,
      home: dir,
      // A CLI that prints its version wrapped in a title-setting OSC sequence, and a herdr that
      // appends one: the payload is the attack, and none of it may survive the line.
      version: (binary) => (binary === 'claude' ? '9.9.9 (Claude Code)\x1b]0;pwned\x07' : '2.1.288 (Claude Code)'),
      herdrVersion: () => '0.13.0\x1b]0;evil\x07',
    });
    expect(io.out).toContain('9.9.9 (Claude Code)');
    expect(io.out).toContain('herdr 0.13.0');
    expect(io.out).not.toContain('pwned');
    expect(io.out).not.toContain('evil');
    expect(io.out.includes('\x1b') || io.out.includes('\x07'), 'a raw escape byte reached the terminal').toBe(false);
    expect(io.err.includes('\x1b') || io.err.includes('\x07'), 'a raw escape byte reached stderr').toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cleaning is presentation only: a dirty-but-valid file keeps every exit', async () => {
  const clean = project();
  const dirty = project();
  try {
    writeFileSync(join(clean, '.agents', 'team.yaml'), example);
    const dirtyYaml = dirtyFile();
    writeFileSync(join(dirty, '.agents', 'team.yaml'), dirtyYaml);

    const file = (dir: string) => ['--file', '.agents/team.yaml'];
    const doctorCode = async (dir: string, home: string) => {
      const io = testIo(dir, { kind: 'owner' });
      const standing = () => {
        const text = readFileSync(join(dir, '.agents', 'team.yaml'), 'utf8');
        const parsed = validateTeamFile(text);
        if (!parsed.ok) throw new Error(`the fixture in ${dir} no longer validates`);
        return verifiedOf(parsed.team, text, dir, NOW);
      };
      const code = await runDoctor(file(dir), io, { ...doctorSources, home, standing });
      return { code, io };
    };
    const statusCode = async (dir: string, home: string) => {
      const io = testIo(dir, { kind: 'owner' });
      const code = await runStatus(file(dir), io, { ...statusSources, home });
      return { code, io };
    };

    const cleanDoctor = await doctorCode(clean, clean);
    const dirtyDoctor = await doctorCode(dirty, dirty);
    expect(dirtyDoctor.code, 'the dirty file moved doctor exit').toBe(cleanDoctor.code);
    expect(dirtyDoctor.io.out.includes('\x1b') || dirtyDoctor.io.err.includes('\x1b'), 'a raw escape byte reached the terminal').toBe(false);

    const cleanStatus = await statusCode(clean, clean);
    const dirtyStatus = await statusCode(dirty, dirty);
    expect(dirtyStatus.code, 'the dirty file moved status exit').toBe(cleanStatus.code);
    expect(dirtyStatus.io.out.includes('\x1b') || dirtyStatus.io.err.includes('\x1b'), 'a raw escape byte reached the terminal').toBe(false);
  } finally {
    rmSync(clean, { recursive: true, force: true });
    rmSync(dirty, { recursive: true, force: true });
  }
});

test('a dirty label in --json keeps the line parseable and the raw byte off the terminal', async () => {
  const dir = project();
  try {
    writeFileSync(join(dir, '.agents', 'team.yaml'), dirtyFile());
    const io = testIo(dir, { kind: 'owner' });
    await runStatus(['--file', '.agents/team.yaml', '--json'], io, { ...statusSources, home: dir });
    const parsed = JSON.parse(io.out) as { seats?: { display?: string }[] };
    expect(parsed, 'the json line did not parse').not.toBeNull();
    // The escape never rides the line raw; a consumer that parses it gets the data, spells and all.
    expect(io.out.includes('\x1b'), 'a raw escape byte reached the terminal').toBe(false);
    const shown = JSON.stringify(parsed).includes('V4.1 Flash');
    expect(shown, 'the dirty label lost its clean spelling in the data').toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

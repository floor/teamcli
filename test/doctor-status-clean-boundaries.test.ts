// The doctor/status cleaning at its edges. The builder's own tests hold the common cases — a
// CSI in a name, a dirty branch, the pad computed on cleaned widths. These scenes hold the
// edges the common cases lean on: a string sequence's payload drops whole (an OSC-8 link's URL
// never prints, its label does), the one-byte C1 forms a terminal also honors are stripped with
// their mangled tails, an unterminated sequence costs the rest of its field, the line and
// paragraph separators fold to one line, the invocation errors clean argv this command did not
// ask for — and the JSON seam, which bypasses the cleaning on purpose, stays byte-honest in its
// values while its bytes stay terminal-safe by construction.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { emptySession, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const now = new Date('2026-10-03T14:10:00Z');

// An OSC-8 hyperlink: the introducer carries the URL, the label sits between it and the empty
// closing sequence. A terminal renders the label and hides the URL; the cleaning must print
// exactly that — the label kept, every byte of both sequences and the URL gone.
const LINK = '\x1b]8;;http://evil.example\x1b\\click-me\x1b]8;;\x1b\\';

// The world the render scenes run against: the file's own session with a live watch, the
// coordinator running in a pane, and whatever stray agent a scene adds. The agents are loose
// on purpose — a scene's dirt is the point — so the world is cast to the sources shape.
function statusSources(dir: string, agents: unknown[]): Omit<StatusSources, 'standing'> {
  return {
    live: () => ({
      running: true,
      agents,
      workspaces: [
        { id: 'w1', label: 'claude opus 5.5' },
        ...[...new Set(agents.map((agent) => String((agent as { workspace: string }).workspace)))]
          .filter((id) => id !== 'w1')
          .map((id) => ({ id, label: 'stray' })),
      ],
      screens: {},
    }),
    branch: () => 'main',
    now: () => now,
    home: dir,
  } as unknown as Omit<StatusSources, 'standing'>;
}

async function renderStatus(dir: string, agents: unknown[], extra: string[] = []): Promise<string> {
  const file = join(dir, '.agents', 'team.yaml');
  writeFileSync(file, example);
  const parsed = validateTeamFile(example);
  if (!parsed.ok) throw new Error('fixture failed validation');
  const standing = verifiedOf(parsed.team, example, dir, now);
  updateState(join(dir, '.agents'), (state) => {
    state.sessions['acme-web'] = { ...emptySession(), watch: { pid: 1, heartbeat: '2026-10-03T14:09:00Z' } };
  });
  const io = testIo(dir, { kind: 'owner' });
  const sources = statusSources(dir, agents);
  await runStatus([...['--file', file], ...extra], io, { ...sources, standing: () => standing });
  return io.out;
}

function statusDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'team-clean-edge-'));
  mkdirSync(join(dir, '.agents'));
  return dir;
}

function stray(name: string, pane: string) {
  return { name, agent: 'claude', pane, workspace: 'w9', status: 'idle', cwd: null };
}

describe('doctor and status cleaning at the edges', () => {
  test('an OSC-8 link prints its label and never its URL, in the render', async () => {
    const dir = statusDir();
    try {
      const out = await renderStatus(dir, [stray(LINK, 'pane-b')]);
      expect(out).toContain('click-me');
      expect(out).not.toContain('http://evil.example');
      expect(out).not.toContain('\x1b');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the JSON seam keeps the link byte-honest while its bytes stay terminal-safe', async () => {
    const dir = statusDir();
    try {
      const out = await renderStatus(dir, [stray(LINK, 'pane-b')], ['--json']);
      expect(out).not.toContain('\x1b');
      const doc = JSON.parse(out) as { differences: { what: string }[] };
      // The document is the record, not the terminal: the sequence's bytes survive a parse
      // (escaped, not literal) and the URL with them.
      const what = doc.differences.map((difference) => difference.what).join('\n');
      expect(what).toContain('click-me');
      expect(what).toContain('http://evil.example');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the one-byte C1 forms go with their mangled tails, BEL closes an OSC', async () => {
    const dir = statusDir();
    try {
      const agents = [
        // C1 CSI (\x9b) with the 7-bit tail: the '[' belongs to the sequence, not the text.
        // The status reaches the page only through a file seat's row, so the dirt rides the
        // coordinator's own live agent.
        {
          name: 'claude-coordinator-acme',
          agent: 'claude',
          pane: 'pane-a',
          workspace: 'w1',
          status: 'working\x9b[2Jx',
          cwd: null,
        },
        // C1 OSC (\x9d) closed by BEL: the title payload drops whole from the name.
        stray('b\x9d0;title\x07', 'pane-2'),
      ];
      const out = await renderStatus(dir, agents);
      expect(out).not.toContain('\x9b');
      expect(out).not.toContain('\x9d');
      expect(out).toContain('workingx');
      expect(out).not.toContain('title');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unterminated string sequence costs the rest of its field', async () => {
    const dir = statusDir();
    try {
      // DCS (\x90) never closed: everything after it, in that field, drops.
      const out = await renderStatus(dir, [stray('gone\x90tail-that-vanishes', 'pane-b')]);
      expect(out).toContain('gone');
      expect(out).not.toContain('tail-that-vanishes');
      expect(out).not.toContain('\x90');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the invisible folds: a paragraph separator never opens a second line, a bidi mark goes', async () => {
    const dir = statusDir();
    try {
      // U+2028 folds to a line feed and then to one space; U+202E (RLO, category Cf) is removed.
      const out = await renderStatus(dir, [stray('a b‮c', 'pane-b')]);
      const line = out.split('\n').find((part) => part.includes('(pane-b)')) ?? '';
      expect(line).toContain('a bc');
      expect(out).not.toContain(' ');
      expect(out).not.toContain('‮');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an invocation error cleans argv the command never asked for', async () => {
    const dir = statusDir();
    try {
      const io = testIo(dir, { kind: 'owner' });
      const exit = await runStatus([LINK], io, {
        live: () => ({ running: true, agents: [], workspaces: [], screens: {} }),
        branch: () => 'main',
        standing: () => ({ kind: 'none' }),
        now: () => now,
        home: dir,
      });
      expect(exit).toBe(2);
      expect(io.err).toContain('team status:');
      expect(io.err).not.toContain('\x1b');
      expect(io.err).not.toContain('http://evil.example');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('doctor drops an OSC payload from a version string it could not read', async () => {
    const dir = statusDir();
    try {
      const file = join(dir, '.agents', 'team.yaml');
      writeFileSync(file, example);
      const parsed = validateTeamFile(example);
      if (!parsed.ok) throw new Error('fixture failed validation');
      const standing = verifiedOf(parsed.team, example, dir, now);
      const sources: DoctorSources = {
        version: () => 'unreadable\x1b]8;;http://evil.example\x07-text',
        onPath: () => true,
        loggedIn: () => true,
        herdrVersion: () => '0.13.0',
        sessionRunning: () => true,
        now: () => now,
        home: dir,
      };
      const io = testIo(dir, { kind: 'owner' });
      await runDoctor(['--file', file], io, { ...sources, standing: () => standing });
      expect(io.out).toContain('its version can\'t be read from "unreadable-text"');
      expect(io.out).not.toContain('http://evil.example');
      expect(io.out).not.toContain('\x1b');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

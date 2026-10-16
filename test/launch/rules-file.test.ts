import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { validateTeamFile } from '../../src/file/validate.ts';
import { verifiedOf } from '../../src/approve/approval.ts';
import type { TeamFile } from '../../src/file/types.ts';
import {
  checkRulesFile, removeRulesFile, rulesDeliveryOf, rulesFileHash, rulesFilePath, rulesFilePathOf, rulesLine, typeablePath, writeRulesFile,
} from '../../src/launch/rules-file.ts';
import { rulesOf } from '../../src/launch/rules.ts';

// The builder under test returns null for a name its rule refuses; every fixture's name passes.
function pathOf(project: string, root: string, home: string, seat: string): string {
  const path = rulesFilePath(project, root, home, seat);
  if (path === null) throw new Error(`the fixture seat name "${seat}" must be typeable`);
  return path;
}

const EXAMPLE = readFileSync(new URL('../fixtures/example.yaml', import.meta.url), 'utf8');

function teamOf(text: string = EXAMPLE) {
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(`the fixture does not validate: ${JSON.stringify(parsed.errors)}`);
  return parsed.team;
}

// The example's codex seat: a message seat, with rules to deliver.
function codexSeat() {
  const team = teamOf();
  const seat = team.seats.find((item) => item.cli === 'codex');
  if (!seat) throw new Error('the example fixture has no codex seat');
  return { team, seat };
}


// A home, an approval in force, and the seat the file is for — with the write already going
// through the writer's own signature: the approval in force and the seat's name. No test hands
// the writer or the remover a path.
function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'team-rules-home-'));
  // `~/.config` is the user's own configuration folder, never team's to make: the writer's
  // ladder starts at team's state root inside it.
  mkdirSync(join(home, '.config'), { recursive: true });
  const { team, seat } = codexSeat();
  const standing = verifiedOf(team, EXAMPLE, '/nowhere');
  const write = (text: string, hash: string, random?: () => string) =>
    writeRulesFile(standing, seat.name, '/nowhere', home, text, hash, random);
  return { home, standing, seat, path: pathOf(team.project, '/nowhere', home, seat.name), text: rulesOf(team, seat, '/nowhere'), write };
}
describe('the line and its path', () => {
  test('a path of letters, digits and . _ / @ + - is typeable; anything else is not', () => {
    expect(typeablePath('/home/owner/.config/team/demo-3f9c2a8e1d7b/rules/implementer.md')).toBe(true);
    expect(typeablePath('/opt/team@v1.2/rules/a-b_c.md')).toBe(true);
    // A space, and a character outside the set: neither is quoted or escaped, both refused.
    expect(typeablePath('/home/owner/My Rules/implementer.md')).toBe(false);
    expect(typeablePath('/tmp/rules#1/implementer.md')).toBe(false);
    expect(typeablePath('/tmp/rules\t1/implementer.md')).toBe(false);
  });

  test('the line is the path, the hash, and the same words every time', () => {
    expect(rulesLine('/home/o/rules/a.md', '5e1d0a9c4b2f')).toBe(
      'Read /home/o/rules/a.md (sha256 5e1d0a9c4b2f): your standing rules for this session; reply ready and wait for your brief.',
    );
  });

  test('the hash is the first 12 hex digits of the text\'s SHA-256', () => {
    // printf 'Rules.' | shasum -a 256 | cut -c1-12
    expect(rulesFileHash('Rules.')).toBe('85372cb19aba');
    expect(rulesFileHash('Rules.')).toMatch(/^[0-9a-f]{12}$/);
  });

  test('the file lives in the project state folder, beside the approval store', () => {
    const root = mkdtempSync(join(tmpdir(), 'team-rules-file-'));
    const home = mkdtempSync(join(tmpdir(), 'team-rules-home-'));
    try {
      // The store folder is the approval store's own: `<home>/.config/team/<project>-<hash>`,
      // the project's state folder, with `rules/` and the seat's file inside it.
      const path = pathOf('acme-web', root, home, 'codex-acme');
      expect(path.startsWith(join(home, '.config', 'team'))).toBe(true);
      const parts = path.split('/');
      expect(parts.at(-2)).toBe('rules');
      expect(parts.at(-1)).toBe('codex-acme.md');
      expect(parts.at(-3)).toMatch(/^acme-web-[0-9a-f]+$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('writing the file', () => {

  // A ladder the writer accepts, for fixtures that plant something inside it: the store folder
  // and `rules/` exactly `0700` (mode 0700 has no bits a umask could clear).
  function mkLadder(path: string) {
    mkdirSync(dirname(dirname(dirname(path))), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(dirname(path)), { mode: 0o700 });
    mkdirSync(dirname(path), { mode: 0o700 });
  }

  test('the file is written 0600, and every folder of its ladder 0700, whatever the umask leaves in', () => {
    const { home, path, text, write } = fresh();
    const umask = process.umask(0o022);
    try {
      expect(write(text, rulesFileHash(text)).ok).toBe(true);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o700);
      expect(lstatSync(dirname(dirname(path))).mode & 0o777).toBe(0o700);
      expect(lstatSync(dirname(dirname(dirname(path)))).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(umask);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the file holds exactly the approved rules text, byte for byte', () => {
    const { home, path, text, write } = fresh();
    try {
      write(text, rulesFileHash(text));
      expect(readFileSync(path, 'utf8')).toBe(text);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a rewrite lands whole and leaves no temporary file behind', () => {
    const { home, path, text, write } = fresh();
    try {
      write(text, rulesFileHash(text));
      write(`${text}\nOne more rule.\n`, rulesFileHash(`${text}\nOne more rule.\n`));
      expect(readFileSync(path, 'utf8')).toBe(`${text}\nOne more rule.\n`);
      expect(readdirSync(dirname(path)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a hundred deliveries leave no descriptor behind', () => {
    const { home, path, text, write } = fresh();
    try {
      // The count of open descriptors, read from the folder the platform lists them in: a
      // descriptor the writer forgets to close is one more entry here, one per delivery.
      const listed = existsSync('/proc/self/fd') ? '/proc/self/fd' : '/dev/fd';
      const before = readdirSync(listed).length;
      for (let at = 0; at < 100; at++) expect(write(text, rulesFileHash(text)).ok).toBe(true);
      expect(readdirSync(listed).length).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a symbolic link at the file is refused, never written through', () => {
    const { home, path, text, write } = fresh();
    try {
      const victim = join(home, 'victim.md');
      writeFileSync(victim, 'do not touch\n');
      mkLadder(path);
      symlinkSync(victim, path);
      expect(write(text, rulesFileHash(text))).toEqual({ ok: false, why: 'place', what: 'a symbolic link' });
      expect(readFileSync(victim, 'utf8')).toBe('do not touch\n');
      expect(readlinkSync(path)).toBe(victim);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a symbolic link at the rules folder is refused, nothing written through it', () => {
    const { home, path, text, write } = fresh();
    try {
      const elsewhere = mkdtempSync(join(tmpdir(), 'team-rules-elsewhere-'));
      mkdirSync(dirname(dirname(dirname(path))), { recursive: true, mode: 0o700 });
      mkdirSync(dirname(dirname(path)), { recursive: true, mode: 0o700 });
      symlinkSync(elsewhere, dirname(path));
      expect(write(text, rulesFileHash(text))).toEqual({ ok: false, why: 'folder', what: 'a symbolic link' });
      expect(readdirSync(elsewhere)).toEqual([]);
      rmSync(elsewhere, { recursive: true, force: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a symbolic link at the project state folder is refused, nothing written through it', () => {
    const { home, path, text, write } = fresh();
    try {
      const elsewhere = mkdtempSync(join(tmpdir(), 'team-rules-elsewhere-'));
      mkdirSync(dirname(dirname(dirname(path))), { recursive: true, mode: 0o700 });
      symlinkSync(elsewhere, dirname(dirname(path)));
      expect(write(text, rulesFileHash(text))).toEqual({ ok: false, why: 'folder', what: 'a symbolic link' });
      expect(readdirSync(elsewhere)).toEqual([]);
      rmSync(elsewhere, { recursive: true, force: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a link pre-planted at the old process-id temporary name is ignored and untouched', () => {
    const { home, path, text, write } = fresh();
    try {
      write(text, rulesFileHash(text));
      const victim = join(home, 'pid-victim.md');
      writeFileSync(victim, 'do not touch\n');
      const old = `${path}.${process.pid}.tmp`;
      symlinkSync(victim, old);
      expect(write(`${text}\nAgain.\n`, rulesFileHash(`${text}\nAgain.\n`)).ok).toBe(true);
      expect(readFileSync(victim, 'utf8')).toBe('do not touch\n');
      expect(readlinkSync(old)).toBe(victim);
      expect(readdirSync(dirname(path)).filter((name) => name.endsWith('.tmp'))).toEqual([`${basename(path)}.${process.pid}.tmp`]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a link pre-planted at the temporary\'s own name is refused by the exclusive no-follow open', () => {
    const { home, path, text, write } = fresh();
    try {
      const victim = join(home, 'temp-victim.md');
      writeFileSync(victim, 'do not touch\n');
      const planted = join(dirname(path), `${basename(path)}.planted.tmp`);
      mkLadder(path);
      symlinkSync(victim, planted);
      const written = write(text, rulesFileHash(text), () => 'planted');
      expect(written).toEqual({ ok: false, why: 'not-written' });
      expect(readFileSync(victim, 'utf8')).toBe('do not touch\n');
      expect(readlinkSync(planted)).toBe(victim);
      expect(() => lstatSync(path)).toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a regular file pre-planted at the temporary\'s own name is refused and its bytes left alone', () => {
    // Without the exclusive flag the open would land in the planted file — overwriting its
    // head, keeping its tail — and the rename would move someone else's file into the final
    // name. With it, the name being taken is a refusal, nothing written.
    const { home, path, text, write } = fresh();
    try {
      const planted = join(dirname(path), `${basename(path)}.planted.tmp`);
      mkLadder(path);
      writeFileSync(planted, 'someone else\'s bytes, longer than any text the writer would put here\n');
      const written = write(text, rulesFileHash(text), () => 'planted');
      expect(written).toEqual({ ok: false, why: 'not-written' });
      expect(readFileSync(planted, 'utf8')).toBe('someone else\'s bytes, longer than any text the writer would put here\n');
      expect(() => lstatSync(path)).toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a wider mode at the final name is refused, not replaced or chmod\'d', () => {
    const { home, path, text, write } = fresh();
    try {
      write(text, rulesFileHash(text));
      chmodSync(path, 0o644);
      expect(write(`${text}\nNo.\n`, rulesFileHash(`${text}\nNo.\n`))).toEqual({
        ok: false, why: 'place', what: 'mode 0644, not 0600',
      });
      expect(readFileSync(path, 'utf8')).toBe(text);
      expect(readdirSync(dirname(path)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a FIFO and a directory at the final name are each refused and left alone', () => {
    const { home, path, text, write } = fresh();
    try {
      mkLadder(path);
      execFileSync('mkfifo', [path]);
      expect(write(text, rulesFileHash(text))).toEqual({ ok: false, why: 'place', what: 'a FIFO' });
      expect(lstatSync(path).isFIFO()).toBe(true);
      expect(readdirSync(dirname(path)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      rmSync(path);
      mkdirSync(path);
      expect(write(text, rulesFileHash(text))).toEqual({ ok: false, why: 'place', what: 'a directory' });
      expect(lstatSync(path).isDirectory()).toBe(true);
      expect(readdirSync(dirname(path)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a folder of the ladder team made, wider than 0700, is refused and never chmod\'d', () => {
    const { home, path, text, write } = fresh();
    try {
      write(text, rulesFileHash(text));
      chmodSync(dirname(path), 0o755);
      expect(write(text, rulesFileHash(text))).toEqual({ ok: false, why: 'folder', what: 'mode 0755, not 0700' });
      expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o755);
      chmodSync(dirname(path), 0o700);
      chmodSync(dirname(dirname(path)), 0o755);
      expect(write(text, rulesFileHash(text))).toEqual({ ok: false, why: 'folder', what: 'mode 0755, not 0700' });
      expect(lstatSync(dirname(dirname(path))).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a written file that does not read back as the line\'s hash is a changed refusal', () => {
    const { home, path, text, write } = fresh();
    try {
      // The hash the line would carry is of another text: the write lands, the read-back
      // refuses it, and nothing would be typed.
      expect(write(text, '000000000000')).toEqual({ ok: false, why: 'changed' });
      expect(readFileSync(path, 'utf8')).toBe(text);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('checking the file', () => {
  test('a file with the approved text, 0600 and this user\'s, is ok; a different text is not', () => {
    const { home, path, text, write } = (() => {
      const made = mkdtempSync(join(tmpdir(), 'team-rules-home-'));
      // The approval store always exists before a delivery: `~/.config` is there already.
      mkdirSync(join(made, '.config'), { recursive: true });
      const { team, seat } = codexSeat();
      const standing = verifiedOf(team, EXAMPLE, '/nowhere');
      const write = (body: string, hash: string) => writeRulesFile(standing, seat.name, '/nowhere', made, body, hash);
      return { home: made, path: pathOf(team.project, '/nowhere', made, seat.name), text: rulesOf(team, seat, '/nowhere'), write };
    })();
    try {
      write(text, rulesFileHash(text));
      expect(checkRulesFile(path, text)).toEqual({ ok: true });
      expect(checkRulesFile(path, 'other rules')).toEqual({ ok: false, what: "its rules file differs from the team file's rules" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a missing file, a symlink, a folder, and a mode wider than 0600 are each their own finding', () => {
    const home = mkdtempSync(join(tmpdir(), 'team-rules-home-'));
    mkdirSync(join(home, '.config'), { recursive: true });
    try {
      const { team, seat } = codexSeat();
      const standing = verifiedOf(team, EXAMPLE, '/nowhere');
      const path = pathOf(team.project, '/nowhere', home, seat.name);
      const text = rulesOf(team, seat, '/nowhere');
      const write = (body: string, hash: string) => writeRulesFile(standing, seat.name, '/nowhere', home, body, hash);
      expect(checkRulesFile(path, text)).toEqual({ ok: false, what: 'its rules file is missing' });
      write(text, rulesFileHash(text));
      const victim = join(home, 'victim.md');
      writeFileSync(victim, text);
      const link = `${path}.link`;
      symlinkSync(victim, link);
      expect(checkRulesFile(link, text)).toEqual({ ok: false, what: 'its rules file is a symbolic link' });
      expect(checkRulesFile(dirname(path), text)).toEqual({ ok: false, what: 'its rules file is not a regular file' });
      chmodSync(path, 0o644);
      expect(checkRulesFile(path, text)).toEqual({ ok: false, what: 'its rules file has mode 0644, not 0600' });
      chmodSync(path, 0o600);
      expect(checkRulesFile(path, text)).toEqual({ ok: true });
      removeRulesFile(standing, seat.name, '/nowhere', home);
      expect(checkRulesFile(path, text)).toEqual({ ok: false, what: 'its rules file is missing' });
      removeRulesFile(standing, seat.name, '/nowhere', home); // a second removal of nothing is nothing
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the seat name where the path is built', () => {
  // The names the team file's own rule refuses — plus the one length that makes a file name over
  // 255 bytes — checked where the path is built, not only by the parser: a corrupt state entry
  // must never become a path. `codex/acme` and `../victim` are refused names; as raw strings they
  // are also the corrupt entries the removal test feeds.
  const refused = ['codex/acme', '..', '../victim', '.hidden', 'codex acme', 'a'.repeat(253)];

  test('a name the team file refuses, and a file name over 255 bytes, get no path at all', () => {
    const home = mkdtempSync(join(tmpdir(), 'team-rules-home-'));
    try {
      for (const name of refused) expect(rulesFilePath('acme-web', '/nowhere', home, name)).toBeNull();
      // 252 characters make a 255-byte file name exactly: the boundary itself passes.
      expect(rulesFilePath('acme-web', '/nowhere', home, 'a'.repeat(252))).toContain(`${'a'.repeat(252)}.md`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('each refused name is refused in the delivery too — nothing written, nothing typed', () => {
    const home = mkdtempSync(join(tmpdir(), 'team-rules-home-'));
    try {
      const { team, seat } = codexSeat();
      const standing = verifiedOf(team, EXAMPLE, '/nowhere');
      for (const name of refused) {
        expect(rulesDeliveryOf(standing, team, { ...seat, name }, '/nowhere', home)).toEqual({
          refusal: "its rules file's path can't be typed safely: the read-back can't prove a path outside letters, digits and . _ / @ + -",
        });
      }
      expect(existsSync(join(home, '.config'))).toBe(false); // nothing was written anywhere
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a corrupt state entry never turns a removal into an unlink elsewhere', () => {
    const home = mkdtempSync(join(tmpdir(), 'team-rules-home-'));
    try {
      const { team } = codexSeat();
      const standing = verifiedOf(team, EXAMPLE, '/nowhere');
      // The store the standing resolves to: `<home>/.config/team/acme-web-<hash of the root>`.
      const store = join(home, '.config', 'team', 'acme-web-001471018cf6');
      mkdirSync(join(store, 'rules'), { recursive: true, mode: 0o700 });
      const victim = join(store, 'victim.md');
      writeFileSync(victim, 'do not touch\n');
      // The corrupt entries themselves, as the names a state entry could hold: a `..` that
      // would walk out of rules/ (the victim), a `/` into a folder of it, and the names the
      // file's own rule refuses. (The 253-character name has no decoy: the file system itself
      // refuses a 256-byte name, so nothing can be planted there for a removal to find.)
      removeRulesFile(standing, '..', '/nowhere', home);
      removeRulesFile(standing, 'codex/acme', '/nowhere', home);
      const planted = ['..', '.hidden', 'codex acme'];
      for (const name of planted) writeFileSync(join(store, 'rules', `${name}.md`), 'planted\n');
      for (const name of planted) removeRulesFile(standing, name, '/nowhere', home);
      expect(readFileSync(victim, 'utf8')).toBe('do not touch\n');
      for (const name of planted) {
        expect(readFileSync(join(store, 'rules', `${name}.md`), 'utf8')).toBe('planted\n');
      }
      // A name that passes is still taken with its seat — planted as the writer leaves files,
      // this user's `0600`.
      const kept = join(store, 'rules', 'codex-acme.md');
      writeFileSync(kept, 'rules\n', { mode: 0o600 });
      removeRulesFile(standing, 'codex-acme', '/nowhere', home);
      expect(existsSync(kept)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a `..` in a seat name reaches no file outside the rules folder, written or removed', () => {
    // The writer and the remover build the path themselves from a validated seat name, so a
    // `..` handed to either is refused before any file is touched: the file beside the store
    // that a `rules/../victim.md` path would name stays exactly as planted.
    const { home, path, standing, text, write } = fresh();
    try {
      // The store folder is planted as the writer would leave it, with the victim beside where
      // `rules/` would sit.
      mkdirSync(dirname(dirname(path)), { recursive: true, mode: 0o700 });
      const victim = join(dirname(dirname(path)), 'victim.md');
      writeFileSync(victim, 'do not touch\n');
      expect(writeRulesFile(standing, '..', '/nowhere', home, text, rulesFileHash(text))).toEqual({ ok: false, why: 'not-written' });
      removeRulesFile(standing, '..', '/nowhere', home);
      expect(readFileSync(victim, 'utf8')).toBe('do not touch\n');
      expect(existsSync(dirname(path))).toBe(false); // rules/ itself was never created either
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a rules folder swapped for a link is refused, nothing unlinked through it', () => {
    // After the write, `rules/` is swapped for a link into another folder that holds a file of
    // the same name and mode: the remover walks the writer's checked chain again, finds the
    // link, and leaves the target's file alone.
    const { home, path, standing, seat, text, write } = fresh();
    try {
      expect(write(text, rulesFileHash(text)).ok).toBe(true);
      const elsewhere = mkdtempSync(join(tmpdir(), 'team-rules-elsewhere-'));
      const target = join(elsewhere, basename(path));
      writeFileSync(target, 'someone else\'s rules\n', { mode: 0o600 });
      rmSync(dirname(path), { recursive: true, force: true });
      symlinkSync(elsewhere, dirname(path));
      removeRulesFile(standing, seat.name, '/nowhere', home);
      expect(readFileSync(target, 'utf8')).toBe('someone else\'s rules\n');
      expect(readlinkSync(dirname(path))).toBe(elsewhere); // the link itself stands
      rmSync(elsewhere, { recursive: true, force: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('one seat\'s delivery', () => {
  test('a standing that is not an approval in force still delivers the live file', () => {
    // The live file is the text a seat is told to obey. No record, a legacy one, a record the
    // verification refused: each still delivers, and nothing is written by the delivery itself.
    const home = mkdtempSync(join(tmpdir(), 'team-rules-home-'));
    try {
      const { team, seat } = codexSeat();
      const standings = [
        { kind: 'none' } as const,
        { kind: 'legacy' } as const,
        { kind: 'refused', why: 'the record was not signed by this machine' } as const,
      ];
      for (const standing of standings) {
        const delivery = rulesDeliveryOf(standing, team, seat, '/nowhere', home);
        if ('refusal' in delivery) throw new Error(delivery.refusal);
        expect(delivery.text).toBe(rulesOf(team, seat, '/nowhere'));
        const livePath = rulesFilePath(team.project, '/nowhere', home, seat.name);
        expect(livePath).toBe(delivery.path);
      }
      expect(existsSync(join(home, '.config'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a message seat gets the file\'s text, path and line; an option seat gets no file', () => {
    const { team, seat } = codexSeat();
    const standing = verifiedOf(team, EXAMPLE, '/nowhere');
    const claude = team.seats.find((item) => item.cli === 'claude-code');
    if (!claude) throw new Error('the example fixture has no claude-code seat');
    const delivery = rulesDeliveryOf(standing, team, seat, '/nowhere', '/home/owner');
    if ('refusal' in delivery) throw new Error(`unexpected refusal: ${delivery.refusal}`);
    expect(delivery.text).toBe(rulesOf(team, seat, '/nowhere'));
    expect(delivery.path.endsWith(join('rules', `${seat.name}.md`))).toBe(true);
    expect(delivery.line).toBe(rulesLine(delivery.path, rulesFileHash(delivery.text)));
    expect(rulesDeliveryOf(standing, team, claude, '/nowhere', '/home/owner')).toEqual({ refusal: 'its rules travel as a launch option' });
  });

  test('the text is the live file\'s, once it differs from the stored copy', () => {
    const { team, seat } = codexSeat();
    const standing = verifiedOf(team, EXAMPLE, '/nowhere');
    const edited: TeamFile = { ...team, rules: [...team.rules, 'A rule added after the approval.'] };
    const liveText = rulesOf(edited, seat, '/nowhere');
    const delivery = rulesDeliveryOf(standing, edited, seat, '/nowhere', '/home/owner');
    if ('refusal' in delivery) throw new Error(`unexpected refusal: ${delivery.refusal}`);
    expect(delivery.text).toBe(liveText);
    expect(delivery.text).not.toBe(rulesOf(team, seat, '/nowhere'));
    expect(delivery.line).toBe(rulesLine(delivery.path, rulesFileHash(liveText)));
    // A seat the stored copy does not hold is still delivered from the live file.
    const added = { ...seat, name: 'added-after-approval' };
    const withSeat: TeamFile = { ...edited, seats: [...edited.seats, added] };
    const addedDelivery = rulesDeliveryOf(standing, withSeat, added, '/nowhere', '/home/owner');
    if ('refusal' in addedDelivery) throw new Error(addedDelivery.refusal);
    expect(addedDelivery.text).toBe(rulesOf(withSeat, added, '/nowhere'));
    expect(addedDelivery.path.endsWith(join('rules', 'added-after-approval.md'))).toBe(true);
  });

  test('a seat whose path can\'t be typed is refused before anything is written or typed', () => {
    const home = mkdtempSync(join(tmpdir(), 'team-rules-home-'));
    try {
      const { team, seat } = codexSeat();
      const standing = verifiedOf(team, EXAMPLE, '/nowhere');
      const plain = rulesDeliveryOf(standing, team, seat, '/nowhere', home);
      if ('refusal' in plain) throw new Error('the plain path must be typeable here');
      // A seat name with a space makes the path untypeable: nothing is quoted, nothing typed.
      const spaced = { ...seat, name: 'codex acme' };
      expect(rulesDeliveryOf(standing, team, spaced, '/nowhere', home)).toEqual({
        refusal: "its rules file's path can't be typed safely: the read-back can't prove a path outside letters, digits and . _ / @ + -",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a renamed project keeps one path everywhere: the live file\'s', () => {
    // A project rename is not a refusal. The file, the line, the check and the removal name
    // one path: the live project's. The stored copy's folder is not written.
    const home = mkdtempSync(join(tmpdir(), 'team-rules-home-'));
    mkdirSync(join(home, '.config'), { recursive: true });
    try {
      const { team, seat } = codexSeat();
      const standing = verifiedOf(team, EXAMPLE, '/nowhere');
      const renamed: TeamFile = { ...team, project: 'acme-renamed' };
      const delivery = rulesDeliveryOf(standing, renamed, seat, '/nowhere', home);
      if ('refusal' in delivery) throw new Error(`unexpected refusal: ${delivery.refusal}`);
      const livePath = rulesFilePath('acme-renamed', '/nowhere', home, seat.name);
      expect(livePath).toBe(delivery.path);
      expect(basename(dirname(dirname(delivery.path)))).toMatch(/^acme-renamed-/);
      expect(writeRulesFile(standing, seat.name, '/nowhere', home, delivery.text, rulesFileHash(delivery.text), undefined, 'acme-renamed').ok).toBe(true);
      expect(checkRulesFile(delivery.path, delivery.text)).toEqual({ ok: true });
      removeRulesFile(standing, seat.name, '/nowhere', home, 'acme-renamed');
      expect(existsSync(delivery.path)).toBe(false);
      const stored = rulesFilePathOf(standing, seat.name, '/nowhere', home);
      expect(stored).not.toBe(delivery.path);
      if (stored !== null) expect(existsSync(dirname(stored))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

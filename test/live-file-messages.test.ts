// The live file is the record: no sentence in src/ sends a caller to the approval copy — not a
// refusal, not a note, not a comment. "approved one", "approved file" and "run `team approve`"
// are gone from every one of them, and this file fails the moment one comes back, naming the
// line. Strings and comments are read alike: a reader of the source is a reader of the tool.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const NEEDLES = ['approved one', 'approved file', 'run `team approve`'] as const;

/** One line's string literals: single-quoted, double-quoted and template, the three the sources
 *  use. A literal is read as written, escapes and all — the test names what the source says. */
const LITERAL = /'([^']*)'|"([^"]*)"|`([^`]*)`/g;

/** Every /approv/i string the commands and the watch can show a caller, with the reason it is
 *  still there. The list is the whole of them: a literal that matches no entry fails the test,
 *  and an entry that matches no literal fails it too — so the list can neither miss a new
 *  approval-era sentence nor keep a reason for a sentence that is gone. A comment is not a
 *  string a caller is shown, and is not read here. */
const ALLOWED: ReadonlyArray<{ literal: RegExp; why: string }> = [
  // A module path: the code's own file name.
  { literal: /^\.{1,2}\/.+\.ts$/, why: "a module path: another module's own file name, never shown to a caller" },
  // The check's own name in the watch's list, the key it reports under, and the key its one
  // sentence is held under: internal names, none of them printed as a sentence.
  { literal: /^approval$/, why: "the check's own name, and the key it reports under" },
  { literal: /^approval:\$\{approvalReason\}$/, why: 'a told-set key: the case is said once, and the key itself is never printed' },
  // The watch's drifting case: the file changed since the record was written. The note is the
  // watch's own, and the record it names is the one the live file is held against.
  { literal: /^the file has changed since the last approval: /, why: "the watch's note for a file edited since the record was written" },
  // The record's own budget checks: a check's file that no longer hashes to what was recorded,
  // or that changed after it. The watch runs the record's checks, so this is not the file's case.
  { literal: /^the check for .* is unapproved; that account reads unknown$/, why: "a check whose file no longer hashes to the record's digest" },
  { literal: /^the check for .* changed after approval and was not run; that account reads unknown$/, why: "a check whose file changed after the record was written: it is not run" },
  // The overrides are the owner's own file, held against the copy the record stored, by design.
  { literal: /^the overrides differ from the approved copy: /, why: "the owner's overrides, held against the copy the record stored" },
  // The record is written by the owner's own `team up`: this sentence asks for exactly that.
  { literal: /^ask the owner to approve this exact folder and answer through team up$/, why: "the record is written by the owner's own `team up`, which this asks for" },
  // A grant gate's refusal id (`a grant needs a verified approval: …`), compared by `up` and
  // `register` and never printed: a grant's own approval-state key, not an approved copy.
  // A grant's own word: a delegate the owner granted `swap` to is an approved one.
  { literal: /an approved delegate swaps/, why: "the delegate grant's word: a delegate granted `swap` is an approved one" },
  // Seat membership in the file: the note names a pane the file does not carry.
  { literal: /^.*: its record is not an approved seat; left (?:running|as it is) \(the owner cleans it: team remove .*\)$/, why: "'approved' is the note's word for a seat of the file in force" },
  // A sign-off, taken off in the file; the owner's `team up` is what reads it. The repair line
  // says the same act the message names.
  { literal: /is signed off; the owner approves the seat back and runs team up/, why: 'a sign-off is taken off in the file; the owner\'s `team up` reads it' },
  { literal: /^the owner approves the seat back, then runs team up$/, why: 'the sign-off refusal\'s repair line: the owner\'s `team up` reads it' },
  // The restore path reads the record's stored copy — the only archive of a file on this machine.
  { literal: /^nothing to restore: no team file was approved for this folder on this machine(?:\. Run team init for a skeleton\.)?$/, why: 'there is no stored copy to restore from: the message and its terminal form' },
  { literal: /^restored the approved copy$/, why: "the file written is the record's own stored copy" },
  { literal: /^Restored \$\{TEAM_FILE\} from the copy you last approved on this machine\./, why: "the copy the record stored, restored onto disk" },
  { literal: /^# the command and its model options; no approval flags$/, why: 'a line of the skeleton `init` writes: it carries no approval flags' },
  // A filter over the doctor's own lines: a finding that names the approval command, or the
  // never-approved case, is skipped by `add`, `restart` and `up` — never printed by them.
  { literal: /^APPROVED$/, why: "the `team list` §5 column: whether the live file loads and validates, not an approval record" },
  { literal: /^team approve$/, why: "part of a filter over the doctor's lines, never printed by these commands" },
  { literal: /^never approved$/, why: "part of a filter over the doctor's lines, never printed by these commands" },
  // The output contract's refusal ids: the JSON envelope's `error.id` member, a key read and
  // compared, never an approval-copy sentence. `down`'s grant gate keys its case on the grant's
  // own `grant.approval`; the others name a standing that is not a verified copy.
  { literal: /^down\.grant-approval$/, why: "down's grant gate refusal id, keyed on the grant's own approval case" },
  { literal: /^(?:remove|up|worktree)\.never-approved$/, why: 'the refusal id for a standing that is not a verified copy: a key in the JSON envelope, never a sentence' },
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

test('no sentence in src/ names the approval copy', () => {
  const hits: string[] = [];
  for (const path of sources(join(import.meta.dir, '..', 'src'))) {
    const shown = path.slice(path.indexOf('/src/') + 1);
    for (const [index, line] of readFileSync(path, 'utf8').split('\n').entries()) {
      for (const needle of NEEDLES) {
        if (line.includes(needle)) hits.push(`${shown}:${index + 1} says "${needle}"`);
      }
    }
  }
  expect(hits).toEqual([]);
});

test('every /approv/i string in the commands and the watch is one the list allows', () => {
  const hits: string[] = [];
  const used = new Set<number>();
  for (const dir of ['src/commands', 'src/watch']) {
    for (const path of sources(join(import.meta.dir, '..', dir))) {
      const shown = path.slice(path.indexOf('/src/') + 1);
      for (const [index, line] of readFileSync(path, 'utf8').split('\n').entries()) {
        // A comment's prose, and a backticked word inside one, is not a string a caller is shown.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        for (const match of line.matchAll(LITERAL)) {
          const text = match[1] ?? match[2] ?? match[3] ?? '';
          if (!/approv/i.test(text)) continue;
          const at = ALLOWED.findIndex((entry) => entry.literal.test(text));
          if (at === -1) hits.push(`${shown}:${index + 1} "${text}"`);
          else used.add(at);
        }
      }
    }
  }
  expect(hits).toEqual([]);
  const stale = ALLOWED.map((entry, at) => (used.has(at) ? null : entry.literal.source)).filter((one) => one !== null);
  expect(stale).toEqual([]);
});

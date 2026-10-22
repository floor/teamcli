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
  // A grant gate's refusal id (`a grant needs a verified approval: …`), compared by `up` and
  // `register` and never printed: a grant's own approval-state key, not an approved copy.
  // A grant's own word: a delegate the owner granted `swap` to is an approved one.
  { literal: /an approved delegate swaps/, why: "the delegate grant's word: a delegate granted `swap` is an approved one" },
  // The live file's delegate, the same word the file and the docs use for the pane its
  // `delegates` entries name: who runs `add` when the caller is not the owner is the owner, or
  // that delegate from its own pane.
  { literal: /^the owner or an approved delegate$/, why: "add's detached refusal names who runs it: the owner, or the live file's delegate" },
  { literal: /^an approved delegate runs /, why: "add's caller-gate repair names the delegate's own pane first, the owner's terminal otherwise" },
  // Seat membership in the file: the note names a pane the file does not carry.
  { literal: /^.*: its record is not an approved seat; left (?:running|as it is) \(the owner cleans it: team remove .*\)$/, why: "'approved' is the note's word for a seat of the file in force" },
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
  // Dev-mode warnings emitted when a delegate or grant gate folds its approval precondition: the
  // template literal interpolates `.devApproval` (an identifier, not an approval-copy sentence).
  { literal: /^(?:! |team (?:add|reload|remove): )\$\{(?:plainText\()?(?:verdict|said|decided)\.devApproval\)?\}\\n$/, why: 'a template interpolation of the `.devApproval` warning property, not an approval-copy sentence' },
  // The owner-authorization token variable name in `development-mode`'s repair line.
  { literal: /^run `team development-mode set <mode> --show`, have the owner read the fingerprint back, then rerun with TEAM_OWNER_APPROVAL=<fingerprint>$/, why: "the owner-authorization token variable name in `development-mode`'s repair line" },
  // The store record file name read by `feed` for its `root` index entry, never shown to a caller.
  { literal: /^approval\.json$/, why: "the store record file name read for its `root` index entry, never shown to a caller" },
  // The `queue.installer` repair line: the owner seals the `installer:` designation in the live file.
  { literal: /^the owner records `installer:` in the team file and approves it$/, why: "the `queue.installer` repair line for sealing the live file's `installer:` designation" },
  // Grant emission and owner-seat approval (`team grant`, `team init`): the request/answer flags,
  // the standing-rule listing and revocation, and their refusal id. These name the owner's answer
  // to one request or a standing rule, never a verified copy of the live file.
  { literal: /^(?:approve|approvals|approve-as-owner-seat|revoke-approval)$/, why: 'a grant or init flag name: an owner answer or a standing rule, not an approval copy' },
  { literal: /^--approvals takes no other arguments$/, why: "the grant flag's invocation refusal" },
  { literal: /^init\.approval-refused$/, why: "init's owner-seat refusal id, a key in the JSON envelope" },
  { literal: /^team init: (?:team-create approval rules|approval rule revoked)/, why: "init's standing team-create rules: an owner-seat answer, not an approval copy" },
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
      // `UNAPPROVED_INSTALLER` in `src/tasks/slice-handler.ts` names the `installer:` designation
      // ("the installer designation is not the approved one"), not the removed approval copy.
      if (line.includes('the installer designation is not the approved one')) continue;
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

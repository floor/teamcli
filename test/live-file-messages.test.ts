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
  // The answerable dialog kind the screen reader classifies. Its own name is a screen class —
  // `DIALOG_KINDS` in `src/watch/dialog.ts`, the `Screen` kind, the `Attention` and `PromptKind`
  // unions, and every `screen.kind === 'plan approval'` comparison in the commands and the
  // watch — and the pass files the kind's told-set under the same name. The profile's key for
  // the kind is written `plan_approval` (`StageName` in `src/watch/screen-core.ts`, `STAGES` and
  // `question_text` in `src/watch/screen-file.ts`). Neither is an approval copy, and neither
  // tells a seat to approve anything: the watch's reports name the dialog and leave it to its
  // operator, and no key is sent from this word.
  { literal: /^plan approval$/, why: "the answerable dialog kind's own name: a screen class (src/watch/dialog.ts DIALOG_KINDS and the screen-kind unions), never an approval copy" },
  { literal: /^plan approval:$/, why: "the attention key prefix the pass files the kind's reports under (src/watch/pass.ts): a told-set key, never printed" },
  { literal: /^plan_approval$/, why: "the profile's own stage and question_text key for the kind (src/watch/screen-core.ts, src/watch/screen-file.ts): a YAML key, never an approval copy" },
  // The two sentences that name those kinds in prose: both refuse, and both say the pane waits
  // at no answerable dialog.
  { literal: /^\$\{seatName\}: it is not waiting at a question, plan approval or confirmation dialog$/, why: "answer's state refusal: the kinds it can answer, said of a seat that waits at none" },
  { literal: /^the pane is not at a question, plan approval or confirmation dialog$/, why: "answer's not-a-question refusal after a fresh read: the pane is at no answerable dialog" },
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
  // `up`'s notice when the team has no approval record: a fact, never a refusal, naming the
  // "Team change" workflow's step where a record is required. It is read as the source writes
  // it, cut at its escaped apostrophe.
  { literal: /^the team has no approval record; the Team change workflow\\$/, why: "up's no-record notice: it names the inventory's step where a record is required" },
  // Grant emission and owner-seat approval (`team grant`, `team init`): the request/answer flags,
  // the standing-rule listing and revocation, and their refusal id. These name the owner's answer
  // to one request or a standing rule, never a verified copy of the live file.
  { literal: /^(?:approve|approvals|approve-as-owner-seat|revoke-approval)$/, why: 'a grant or init flag name: an owner answer or a standing rule, not an approval copy' },
  { literal: /^--approvals takes no other arguments$/, why: "the grant flag's invocation refusal" },
  { literal: /^init\.approval-refused$/, why: "init's owner-seat refusal id, a key in the JSON envelope" },
  { literal: /^(?:(?:up|add|import|migrate)\.)?approval-(?:requested|refused)$/, why: "the owner-seat door's outcome and refusal ids (src/client/owner-action.ts): keys, not an approval copy" },
  { literal: /^owner-seat-approved$/, why: "up's log word for a run an owner-seat answer admitted" },
  { literal: /^Usage: team (?:up|down) .*--approval <request-id>/s, why: "up and down usage, naming the owner-seat door's --approval flag" },
  // `team approvals` lists and revokes owner-seat always rules. The word is the command's own,
  // and the rule it removes is an owner-seat answer, never a verified copy of the live file.
  { literal: /^team approvals: /, why: "approvals' own lines: listing and revoking owner-seat always rules" },
  { literal: /^team-revoke-approval$/, why: "the owner-seat action id for revoking an always rule" },
  { literal: /^--approval$/, why: "batch forwards the owner-seat door's --approval flag to each recorded command" },
  { literal: /^team batch --approval \$\{made\.record\.request_id\}$/, why: "batch's replay line names the owner-seat door's --approval flag" },
  { literal: /^pass --request and one or more --do <command>, or --approval <request-id>$/, why: "batch's invocation line names the owner-seat door's --approval flag" },
  { literal: /^--request asks the owner seat and --approval runs an answered request: pass one$/, why: "batch and migrate refuse combining --request and --approval" },
  // `development-mode set`'s own invocation refusal: a switch is applied by `--request` or by an
  // answered `--approval`, and `--show` only prints what it would change. It names the flags.
  { literal: /^--request and --approval apply a switch, and --show only prints what it would change: pass one$/, why: "development-mode's refusal to combine a switch's flags with --show: the flags' own names" },
  { literal: /^team migrate: owner-seat approval \$\{(?:id|args\.values\.approval)\} \(signed by \$\{admitted\.signer\}\)\\n$/, why: "migrate names the owner-seat signature that admitted this record" },
  { literal: /^team migrate\$\{keepFile \? ' --keep-file' : ''\} --approval \$\{id\}$/, why: "migrate's replay line names the owner-seat door's --approval flag" },
  { literal: /^team migrate: owner-seat request \$\{id\} recorded; \$\{where\}\\n\$\{made\.text\}\\nwaiting for the signed approval\\n$/, why: "migrate shows the owner-seat card and waits for the signature" },
  { literal: /^--dry-run checks an answered request: pass --approval <request-id>$/, why: "batch's dry run names the owner-seat door's --approval flag" },
  { literal: /^--approval runs the recorded batch and takes no --do$/, why: "batch's --approval runs the recorded list and takes no further command" },
  // `approvals` and `init`'s two owner doors, in role words: only the owner revokes a standing
  // rule or changes an approval mode, and this call is refused. Neither tells the caller to
  // approve anything — both refuse it, and neither is a copy of the live file. Every live line
  // with either wording after the integration is one of these two, and each is used.
  { literal: /^only the owner changes an approval mode, from a terminal outside the terminal host; this call is \$\{describeCaller\(caller\)\}$/, why: "init's approval-mode caller refusal: the owner changes a mode record" },
  { literal: /^only the owner revokes an approval rule, from a terminal outside the terminal host; this call is \$\{describeCaller\(caller\)\}$/, why: "approvals and init: the owner revokes a standing rule" },
  { literal: /^"\$\{id\}" is not an approval rule id$/, why: "approvals refuses an id that is neither a team-create nor an owner-action rule" },
  { literal: /^"\$\{id\}" is not an approval rule id; nothing was run$/, why: "batch refuses a revoke id that is not a rule, and runs nothing" },
  { literal: /^team init: (?:team-create approval rules|approval rule revoked)/, why: "init's standing team-create rules: an owner-seat answer, not an approval copy" },
  // The approval mode of team-create (`none | always-rule | per-action`): an owner-signed policy
  // record, signed once at setup, never a copy of the live file.
  { literal: /^(?:approval-mode|approval-modes|--approval-mode needs --scope <folder>)$/, why: "init's approval-mode flags and their invocation refusal" },
  { literal: /^team init: approval mode(?:s$| for team-create is )/, why: "init's owner-signed approval mode for team-create, not an approval copy" },
  // `team migrate` reports the approval's standing across the move: the signed record's standing
  // beside what the registry's record still proves, never a copy of the live file.
  { literal: /^the approval is still in force: it is signed over the canonical record\\n$/, why: "migrate's line when the approval keeps verifying across the move" },
  { literal: /^migration completed; (?:the team record is unchanged, and the stored approval \$\{state\}|the stored approval describes an earlier team record and \$\{state\}|the stored approval \$\{state\}); \$\{repair\}\\n$/, why: "migrate's line on an approval that stopped verifying across the move" },
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

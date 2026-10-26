import { formatTable, renderDifferences, type OutputDifference } from '../output/index.ts';
import { forbiddenPatterns, type CheckConfig } from './config.ts';
import { selectCommits, type Commit } from './git.ts';
import { checkSignature, findForbidden, splitLines, withoutPublicationTrailer, type Finding, type FindingKind } from './message.ts';

export interface CheckOptions {
  /** A folder of the repository to read. */
  cwd: string;
  /** A range when it holds `..`, else one commit. */
  ref: string;
  /** Overrides the file's `identity.since` for this run. */
  since?: string;
  /** A pull request's body, to check as well. */
  pullRequestBody?: string;
}

export interface CommitReport {
  hash: string;
  subject: string;
  /** Why the commit needs no signature; its forbidden patterns are still checked. */
  exempt?: 'merge' | 'human';
  findings: Finding[];
}

export interface CheckReport {
  commits: CommitReport[];
  skipped: number;
  since?: string;
  /** Present when a PR body was checked. */
  pullRequest?: Finding[];
  ok: boolean;
}

function exemption(commit: Commit, config: CheckConfig, humans: Set<string>): CommitReport['exempt'] {
  if (config.commits.exemptMerge && commit.parents.length > 1) return 'merge';
  if (humans.has(commit.authorEmail.toLowerCase())) return 'human';
  return undefined;
}

/** Checks the commits of `ref`, and a PR body when one is given. Read only. */
export function runCheck(config: CheckConfig, options: CheckOptions): CheckReport {
  const patterns = forbiddenPatterns(config);
  const humans = new Set(config.humans.map((email) => email.toLowerCase()));
  const selection = selectCommits(options.cwd, options.ref, options.since ?? config.since);

  const commits = selection.commits.map((commit): CommitReport => {
    const lines = splitLines(commit.message);
    const exempt = exemption(commit, config, humans);
    const findings = findForbidden(lines, patterns);
    if (!exempt) {
      findings.push(
        ...checkSignature({ lines, rule: config.commits, ledger: config.ledger, trailers: commit.trailers }),
      );
    }
    return { hash: commit.hash, subject: commit.subject, exempt, findings };
  });

  const pullRequest = options.pullRequestBody === undefined ? undefined : checkBody(config, options.pullRequestBody);

  const ok = commits.every((commit) => commit.findings.length === 0) && (pullRequest?.length ?? 0) === 0;
  return { commits, skipped: selection.skipped, since: selection.since, pullRequest, ok };
}

/** One pull request body's findings: the file's forbidden patterns, and the signature rule the
 *  file writes for bodies (`pullRequests`). Pure over the config and the text, so the commit run
 *  and the body-only `team pr check` share one definition of what a body must pass. */
export function checkBody(config: CheckConfig, body: string): Finding[] {
  const lines = splitLines(body);
  // Forbidden patterns still see the publication trailer. The signature is read
  // on the author's text: that trailer is not a line the author can remove.
  const signed = splitLines(withoutPublicationTrailer(body));
  return [
    ...findForbidden(lines, forbiddenPatterns(config)),
    ...checkSignature({ lines: signed, rule: config.pullRequests, ledger: config.ledger }),
  ];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** What repairs each finding, in a commit and in a pull request body. */
const REPAIRS: Record<FindingKind, { commit: string; body: string }> = {
  forbidden: {
    commit: 'rewrite the commit message so the line no longer matches (git rebase --interactive, then reword)',
    body: 'edit the pull request body so the line no longer matches (its author can edit it on the pull request)',
  },
  'signature-missing': {
    commit: "sign the commit message in a final trailer block of its own (git commit --amend)",
    body: "end the pull request body with a seat's signature (its author can edit it on the pull request)",
  },
  'signature-misplaced': {
    commit: 'move the signature where the file asks for it (git commit --amend)',
    body: 'move the signature where the file asks for it (its author can edit it on the pull request)',
  },
  'signature-in-prose': {
    commit: 'put the signature in a paragraph of its own, with trailers only (git commit --amend)',
    body: 'put the signature in its own last paragraph (its author can edit it on the pull request)',
  },
  'signature-unknown': {
    commit: 'use a signature a seat of this team has (git commit --amend)',
    body: 'use a signature a seat of this team has (its author can edit it on the pull request)',
  },
};

/** Where a finding was read: a commit, or a pull request body. */
export type FindingPlace = { commit: { hash: string; subject: string } } | { body: true };

/** One finding as the difference the output contract prints under the run (`difference:` +
 *  `repair:` + `who:`). Every repair is the offending commit's branch owner's, or the body's. */
export function findingDifference(finding: Finding, place: FindingPlace): OutputDifference {
  const where = 'commit' in place
    ? `commit ${place.commit.hash.slice(0, 10)} ${JSON.stringify(place.commit.subject)}`
    : 'pull request body';
  const at = finding.line === undefined ? '' : `, line ${finding.line}`;
  const quoted = finding.text === undefined ? '' : ` — ${JSON.stringify(finding.text)}`;
  return {
    what: `${where}${at}: ${finding.message}${quoted}`,
    repair: REPAIRS[finding.kind]['commit' in place ? 'commit' : 'body'],
    who: 'any seat',
  };
}

/** Every finding of a report as a difference, in the order the report holds them: each
 *  offending commit's findings in git order, then the pull request body's. */
export function reportDifferences(report: CheckReport): OutputDifference[] {
  const out: OutputDifference[] = [];
  for (const commit of report.commits) {
    for (const finding of commit.findings) out.push(findingDifference(finding, { commit }));
  }
  return out.concat(bodyDifferences(report.pullRequest ?? []));
}

/** A pull request body's findings as differences, each repaired by the body's author. */
export function bodyDifferences(findings: readonly Finding[]): OutputDifference[] {
  return findings.map((finding) => findingDifference(finding, { body: true }));
}

/** The commit's verdict, as the `STATUS` column and the `team.commits` document word it. */
export function commitStatus(commit: CommitReport): 'ok' | 'refused' | 'exempt' {
  if (commit.findings.length > 0) return 'refused';
  return commit.exempt === undefined ? 'ok' : 'exempt';
}

/** The counting part of the closing line — `3 commits checked, 1 by a human or a merge: ok`'s
 *  left half — shared by the plain report and its refusal verdict. */
function summaryParts(report: CheckReport): string[] {
  const exempt = report.commits.filter((commit) => commit.exempt).length;
  const parts = [`${plural(report.commits.length, 'commit')} checked`];
  if (exempt > 0) parts.push(`${exempt} by a human or a merge`);
  if (report.skipped > 0) parts.push(`${report.skipped} skipped (since ${report.since?.slice(0, 10)})`);
  if (report.pullRequest) parts.push('1 pull request body checked');
  return parts;
}

/** The report's closing summary line: the counts, then `ok` or the problems. */
export function reportSummaryLine(report: CheckReport): string {
  const failed = report.commits.filter((commit) => commit.findings.length > 0).length;
  const problems: string[] = [];
  if (failed > 0) problems.push(`${plural(failed, 'commit')} refused`);
  if (report.pullRequest && report.pullRequest.length > 0) problems.push('the pull request body refused');
  return `team commits check: ${summaryParts(report).join(', ')}: ${report.ok ? 'ok' : problems.join(', ')}`;
}

/** The report as `team commits check` prints it: one table row per commit, every finding —
 *  the body's too, when the old `team check --pr` checked one — as a `difference:` block, then
 *  the closing summary line. */
export function formatReport(report: CheckReport): string {
  const table = formatTable({
    headers: ['COMMIT', 'STATUS', 'DETAIL'],
    rows: report.commits.map((commit) => [commit.hash.slice(0, 10), commitStatus(commit), commit.subject]),
    indent: '',
  });
  const lines = table.trimEnd().split('\n');
  lines.push(...renderDifferences(reportDifferences(report)));
  lines.push(reportSummaryLine(report));
  return `${lines.join('\n')}\n`;
}

/** The report as `team pr check` prints it: the body's findings as `difference:` blocks, then
 *  the closing line — the same parts `formatReport` prints for a body alone (design note §2.2). */
export function formatBodyReport(findings: readonly Finding[]): string {
  const out = renderDifferences(bodyDifferences(findings));
  out.push(`team pr check: 1 pull request body checked: ${findings.length === 0 ? 'ok' : 'the pull request body refused'}`);
  return `${out.join('\n')}\n`;
}

// `team workflow check <path> [--json]`,
// `team workflow run <path> --dry --script <path> [--json]`, and
// `team workflow replay <definition> <journal> --evidence <path> [--json]`.
//
// Code-family boundary:
// - CLI exit ids (`workflow.check.*`, `workflow.run-dry`, `workflow.dry-only`, `workflow.refused`,
//   `workflow.script`, `workflow.evidence`, `workflow.replay`, `workflow.replay-mismatch`,
//   `workflow.journal`, `workflow.definition`, `workflow.invocation`, `workflow.file`) live in
//   `contract/exit-codes.json` and populate `team.error.error.id` when `team.error` is emitted.
// - Parse and whole-graph finding codes (`schema.*`, `graph.*`, `ref.*`, `vocab.*`, `annotation.*`
//   from `src/workflow/schema.ts` and `src/workflow/check.ts`) are line-numbered `Finding` codes
//   reported in `findings[]` and human `refusal:` / `note:` lines; they are never folded into exit
//   ids.
// - Runtime transition and effect decision codes (`src/workflow/codes.ts`) belong to run/replay
//   evaluation and are a separate family from static `Finding` codes and CLI exit ids.
//
// Read only: nothing here writes, and no terminal host session is needed.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readArgs, type Args } from '../args.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Command, Io } from '../io.ts';
import { plainText } from '../launch/plain.ts';
import { hasJsonFlag, pluralCount, refuse, writeJson, writeJsonError } from '../output/index.ts';
import { checkWorkflow } from '../workflow/check.ts';
import type { RunState } from '../workflow/core-state.ts';
import {
  dryReplay,
  dryRun,
  dryRunId,
  readScript,
} from '../workflow/dry/index.ts';

export const DRY_NOTICE = 'dry run — no record is written';
import {
  parseWorkflow,
  provisionalResolvers,
  type DefinitionId,
  type DryRunJournal,
  type EvidenceDocument,
  type EvidenceRecord,
  type Finding,
  type WorkflowResolvers,
} from '../workflow/index.ts';
import { readJournal, type ReplayFailure } from '../workflow/replay.ts';
import { parseYaml, YamlError, type YamlNode } from '../yaml.ts';

export { dryRunId };

export const USAGE = `Usage: team workflow check <path> [--json]
       team workflow run <path> --dry --script <path> [--json]
       team workflow replay <definition> <journal> --evidence <path> [--json]

  <path>              the workflow file to check or dry-run
  <definition>        the workflow file to replay against
  <journal>           the dry-run journal JSON file to replay
  --dry               run the workflow in pure in-memory dry mode (required for run)
  --script <path>     the dry-run script YAML file (required for run)
  --evidence <path>   the standalone evidence JSON or YAML file (required for replay)
  --json              the report or journal as a JSON document on stdout

Checks, dry-runs, or replays a workflow definition (schema v1).

Exits 0 when the subcommand succeeds, 1 when it is refused or stops, 2 when the
invocation or a file can't be read.
`;

export interface WorkflowCommandOptions {
  /** Override seat roles instead of loading `.agents/team.yaml` from `io.cwd`. */
  teamRoles?: readonly string[];
  /** Override workflow resolvers directly. */
  resolvers?: WorkflowResolvers;
}

function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => a.line - b.line || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

function resolveTeamRoles(cwd: string, workflowFile: string): string[] {
  const fromCwd = readTeamConfig(cwd, { checkOnly: true });
  if (fromCwd.ok) {
    return [...new Set(fromCwd.team.seats.map((seat) => seat.role))];
  }
  const fromFileDir = readTeamConfig(dirname(workflowFile), { checkOnly: true });
  if (fromFileDir.ok) {
    return [...new Set(fromFileDir.team.seats.map((seat) => seat.role))];
  }
  return [];
}

export function formatWorkflowCheckReport(path: string, findings: readonly Finding[]): string {
  const lines: string[] = [];
  for (const finding of findings) {
    const label = finding.level === 'refusal' ? 'refusal' : 'note';
    const location = finding.line > 0 ? `${path}:${finding.line}` : path;
    lines.push(`${label}: ${location}: [${finding.code}] ${plainText(finding.message)}`);
  }
  const refusals = findings.filter((finding) => finding.level === 'refusal').length;
  const notes = findings.filter((finding) => finding.level === 'note').length;
  if (refusals === 0) {
    const suffix = notes > 0 ? `ok (${pluralCount(notes, 'note')})` : 'ok';
    lines.push(`team workflow check: ${path}: ${suffix}`);
  } else {
    const counts = notes > 0
      ? `${pluralCount(refusals, 'refusal')}, ${pluralCount(notes, 'note')}`
      : pluralCount(refusals, 'refusal');
    lines.push(`team workflow check: ${path}: ${counts}: refused`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatWorkflowDryRunReport(path: string, journal: DryRunJournal): string {
  const lines: string[] = [
    journal.notice,
    `run: ${journal.run} (${journal.definition.workflow} ${journal.definition.digest})`,
    `start: state=${journal.start.state} activation=${journal.start.activation} effects=${journal.start.effects.length}`,
  ];
  for (const step of journal.steps) {
    lines.push(
      `step ${step.revision}: ${step.transition.from} -> ${step.transition.to} on ${step.signal} at ${step.at} (activation ${step.activation}, effects ${step.effects.length})`,
    );
  }
  if (journal.outcome.kind === 'script-exhausted') {
    const finalState = journal.steps.length > 0
      ? journal.steps[journal.steps.length - 1]!.transition.to
      : journal.initial;
    const finalRevision = journal.steps.length;
    lines.push(
      `team workflow run: ${path}: script-exhausted (${pluralCount(journal.steps.length, 'step')}, state ${finalState}, revision ${finalRevision})`,
    );
  } else {
    lines.push(
      `stop: ${journal.outcome.decision} [${journal.outcome.code}] state=${journal.outcome.state} revision=${journal.outcome.revision}: ${plainText(journal.outcome.why)}`,
    );
    lines.push(
      `team workflow run: ${path}: stopped (${journal.outcome.decision} ${journal.outcome.code} at state ${journal.outcome.state}, revision ${journal.outcome.revision})`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function formatWorkflowReplayReport(
  journalPath: string,
  result: { ok: true; stepsReplayed: number; run: RunState } | { ok: false; fail: ReplayFailure },
): string {
  const lines: string[] = [DRY_NOTICE];
  if (result.ok) {
    const blockedSuffix = result.run.blocked
      ? `, blocked ${result.run.blocked.decision} ${result.run.blocked.code}`
      : '';
    lines.push(
      `team workflow replay: ${journalPath}: ok (${pluralCount(result.stepsReplayed, 'step')}, state ${result.run.state}, revision ${result.run.revision}${blockedSuffix})`,
    );
  } else {
    lines.push(
      `team workflow replay: ${journalPath}: [${result.fail.code}] ${plainText(result.fail.why)}: refused`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function yamlNodeToValue(node: YamlNode, where: string): unknown {
  if (node.kind === 'scalar') return node.value;
  if (node.kind === 'seq') return node.items.map((item) => yamlNodeToValue(item, where));
  const out: Record<string, unknown> = {};
  for (const entry of node.entries) {
    if (entry.key === '' || Object.prototype.hasOwnProperty.call(out, entry.key)) {
      throw new YamlError(entry.line, `${where}: key "${entry.key}" is empty or repeated`);
    }
    out[entry.key] = yamlNodeToValue(entry.value, `${where}.${entry.key}`);
  }
  return out;
}

/**
 * Parse a standalone `--evidence <path>` document (JSON or YAML mapping of `ref -> fixture`).
 * Empty `{}` is valid when no evidence is cited; a non-mapping root, empty ref key, non-mapping
 * fixture value, or syntax failure is refused as `workflow.evidence`.
 */
export function readEvidenceDocument(
  text: string,
): { ok: true; evidence: EvidenceDocument } | { ok: false; code: 'workflow.evidence'; why: string } {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: false, code: 'workflow.evidence', why: 'the evidence file is empty' };
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return {
        ok: false,
        code: 'workflow.evidence',
        why: `the evidence file is not valid JSON: ${(error as Error).message}`,
      };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        code: 'workflow.evidence',
        why: 'evidence document must be a mapping of ref to fixture',
      };
    }
    const out: EvidenceDocument = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (key.trim() === '') {
        return { ok: false, code: 'workflow.evidence', why: 'evidence: ref key must not be empty' };
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { ok: false, code: 'workflow.evidence', why: `evidence.${key} must be a mapping` };
      }
      out[key] = value as EvidenceRecord;
    }
    return { ok: true, evidence: out };
  }

  let root: YamlNode;
  try {
    root = parseYaml(text);
  } catch (error) {
    if (error instanceof YamlError) {
      return { ok: false, code: 'workflow.evidence', why: `line ${error.line}: ${error.message}` };
    }
    throw error;
  }
  if (root.kind !== 'map') {
    return {
      ok: false,
      code: 'workflow.evidence',
      why: `line ${root.line}: evidence document must be a mapping of ref to fixture`,
    };
  }
  const out: EvidenceDocument = {};
  try {
    for (const entry of root.entries) {
      if (entry.key.trim() === '') {
        return {
          ok: false,
          code: 'workflow.evidence',
          why: `line ${entry.line}: evidence: ref key must not be empty`,
        };
      }
      if (Object.prototype.hasOwnProperty.call(out, entry.key)) {
        return {
          ok: false,
          code: 'workflow.evidence',
          why: `line ${entry.line}: evidence: ref "${entry.key}" appears twice`,
        };
      }
      if (entry.value.kind !== 'map') {
        return {
          ok: false,
          code: 'workflow.evidence',
          why: `line ${entry.value.line}: evidence.${entry.key} must be a mapping`,
        };
      }
      out[entry.key] = yamlNodeToValue(entry.value, `evidence fixture "${entry.key}"`) as EvidenceRecord;
    }
  } catch (error) {
    if (error instanceof YamlError) {
      return { ok: false, code: 'workflow.evidence', why: `line ${error.line}: ${error.message}` };
    }
    throw error;
  }
  return { ok: true, evidence: out };
}

function refuseWorkflowDry(
  io: Io,
  json: boolean,
  command: string,
  spec: { id: string; message: string; usage?: string },
): void {
  if (json) {
    writeJsonError(io, spec.id, plainText(spec.message), null, 1, undefined, DRY_NOTICE);
  } else {
    io.stderr(`${DRY_NOTICE}\nteam ${command}: ${plainText(spec.message)}\n${spec.usage ?? ''}`);
  }
}

function failCheckInvocation(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'workflow check', { id: 'workflow.check.invocation', message, repair: null, usage: USAGE });
  // exit: workflow.check.invocation
  return 2;
}

function failWorkflowInvocation(io: Io, json: boolean, command: string, message: string): number {
  refuseWorkflowDry(io, json, command, { id: 'workflow.invocation', message, usage: USAGE });
  // exit: workflow.invocation
  return 2;
}

function failWorkflowFile(io: Io, json: boolean, command: string, message: string): number {
  refuseWorkflowDry(io, json, command, { id: 'workflow.file', message });
  // exit: workflow.file
  return 2;
}

function exitWorkflowEvidence(): number {
  // exit: workflow.evidence
  return 1;
}

function runWorkflowCheck(args: Args, io: Io, json: boolean, options: WorkflowCommandOptions): number {
  if (args.error) return failCheckInvocation(io, json, args.error);
  if (args.flags.has('dry')) return failCheckInvocation(io, json, 'workflow check takes no --dry');
  if (args.values.script !== undefined) return failCheckInvocation(io, json, 'workflow check takes no --script');
  if (args.values.evidence !== undefined) return failCheckInvocation(io, json, 'workflow check takes no --evidence');
  const path = args.rest[1];
  if (path === undefined) return failCheckInvocation(io, json, 'a <path> is required');
  if (args.rest.length > 2) return failCheckInvocation(io, json, 'one <path> at most');

  const resolvedPath = resolve(io.cwd, path);
  let text: string;
  try {
    text = readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    const message = `can't read ${path}: ${(error as Error).message}`;
    refuse(io, json, 'workflow check', { id: 'workflow.check.file', message, repair: null });
    // exit: workflow.check.file
    return 2;
  }

  const parsed = parseWorkflow(text);
  if ('invalid' in parsed) {
    const message = parsed.invalid.line > 0
      ? `${path}:${parsed.invalid.line}: ${parsed.invalid.message}`
      : `${path}: ${parsed.invalid.message}`;
    refuse(io, json, 'workflow check', { id: 'workflow.check.file-invalid', message, repair: null });
    // exit: workflow.check.file-invalid
    return 2;
  }

  let findings: Finding[];
  let definition: DefinitionId | null;
  if ('findings' in parsed) {
    findings = sortFindings(parsed.findings);
    definition = null;
  } else {
    const resolvers = options.resolvers
      ?? provisionalResolvers(options.teamRoles ?? resolveTeamRoles(io.cwd, resolvedPath));
    const checked = checkWorkflow(parsed.workflow, resolvers);
    findings = sortFindings(checked.findings);
    definition = parsed.definition;
  }

  const refusals = findings.filter((finding) => finding.level === 'refusal').length;
  const notes = findings.filter((finding) => finding.level === 'note').length;
  const ok = refusals === 0;

  if (json) {
    writeJson(io, 'team.workflow', {
      format: 1 as const,
      ok,
      path,
      definition,
      findings: findings.map((finding) => ({
        code: finding.code,
        level: finding.level,
        line: finding.line,
        message: plainText(finding.message),
      })),
      summary: {
        refusals,
        notes,
      },
    });
  } else {
    io.stdout(formatWorkflowCheckReport(path, findings));
  }

  // exit: workflow.check.passed
  // exit: workflow.check.refused
  return ok ? 0 : 1;
}

function runWorkflowRun(args: Args, io: Io, json: boolean, options: WorkflowCommandOptions): number {
  if (args.error) return failWorkflowInvocation(io, json, 'workflow run', args.error);
  if (args.values.evidence !== undefined) {
    return failWorkflowInvocation(io, json, 'workflow run', 'workflow run takes no --evidence');
  }
  const path = args.rest[1];
  if (path === undefined) return failWorkflowInvocation(io, json, 'workflow run', 'a <path> is required');
  if (args.rest.length > 2) return failWorkflowInvocation(io, json, 'workflow run', 'one <path> at most');

  if (!args.flags.has('dry')) {
    const message =
      'live workflow execution requires the Kernel workflow gate (amendment 04); pass --dry --script <path> for a dry run';
    refuseWorkflowDry(io, json, 'workflow run', { id: 'workflow.dry-only', message });
    // exit: workflow.dry-only
    return 1;
  }

  const scriptPath = args.values.script;
  if (scriptPath === undefined) {
    return failWorkflowInvocation(io, json, 'workflow run', '--script <path> is required with --dry');
  }

  const resolvedPath = resolve(io.cwd, path);
  let definitionBytes: Buffer;
  try {
    definitionBytes = readFileSync(resolvedPath);
  } catch (error) {
    return failWorkflowFile(io, json, 'workflow run', `can't read ${path}: ${(error as Error).message}`);
  }

  const resolvedScriptPath = resolve(io.cwd, scriptPath);
  let scriptText: string;
  try {
    scriptText = readFileSync(resolvedScriptPath, 'utf8');
  } catch (error) {
    return failWorkflowFile(io, json, 'workflow run', `can't read ${scriptPath}: ${(error as Error).message}`);
  }

  const parsed = parseWorkflow(definitionBytes.toString('utf8'));
  if ('invalid' in parsed) {
    const detail = parsed.invalid.line > 0
      ? `${path}:${parsed.invalid.line}: ${parsed.invalid.message}`
      : `${path}: ${parsed.invalid.message}`;
    return failWorkflowFile(io, json, 'workflow run', detail);
  }
  if ('findings' in parsed) {
    const first = sortFindings(parsed.findings)[0];
    const detail = first
      ? `${path}:${first.line > 0 ? `${first.line}: ` : ''}[${first.code}] ${plainText(first.message)}`
      : `${path}: invalid workflow definition`;
    return failWorkflowFile(io, json, 'workflow run', detail);
  }

  const scriptRead = readScript(scriptText);
  if (!scriptRead.ok) {
    const message = `${scriptPath}: ${scriptRead.why}`;
    if (scriptRead.code === 'workflow.script') {
      refuseWorkflowDry(io, json, 'workflow run', { id: 'workflow.script', message });
      // exit: workflow.script
      return 1;
    }
    refuseWorkflowDry(io, json, 'workflow run', { id: 'workflow.evidence', message });
    return exitWorkflowEvidence();
  }

  const resolvers = options.resolvers
    ?? provisionalResolvers(options.teamRoles ?? resolveTeamRoles(io.cwd, resolvedPath));
  const result = dryRun({
    definitionBytes,
    definition: parsed.workflow,
    script: scriptRead.script,
    guards: resolvers.guards,
  });

  if (!result.ok) {
    return failWorkflowFile(io, json, 'workflow run', `${path}: ${result.why}`);
  }

  if (json) {
    io.stdout(`${JSON.stringify(result.journal, null, 2)}\n`);
  } else {
    io.stdout(formatWorkflowDryRunReport(path, result.journal));
  }

  // exit: workflow.run-dry
  // exit: workflow.refused
  return result.exit === 0 ? 0 : 1;
}

function finishReplayFailure(io: Io, json: boolean, journalPath: string, fail: ReplayFailure): number {
  if (json) {
    writeJson(io, 'team.workflow', {
      format: 1 as const,
      kind: 'workflow-replay' as const,
      authoritative: false as const,
      notice: DRY_NOTICE,
      ok: false as const,
      reason: {
        code: fail.code,
        why: plainText(fail.why),
        ...(fail.step !== undefined ? { step: fail.step } : {}),
        ...(fail.expected !== undefined ? { expected: fail.expected } : {}),
        ...(fail.actual !== undefined ? { actual: fail.actual } : {}),
      },
    });
  } else {
    io.stdout(formatWorkflowReplayReport(journalPath, { ok: false, fail }));
  }
  if (fail.code === 'workflow.evidence') {
    return exitWorkflowEvidence();
  }
  // exit: workflow.definition
  // exit: workflow.journal
  // exit: workflow.replay-mismatch
  return 1;
}

function runWorkflowReplay(args: Args, io: Io, json: boolean, options: WorkflowCommandOptions): number {
  if (args.error) return failWorkflowInvocation(io, json, 'workflow replay', args.error);
  if (args.flags.has('dry')) return failWorkflowInvocation(io, json, 'workflow replay', 'workflow replay takes no --dry');
  if (args.values.script !== undefined) {
    return failWorkflowInvocation(io, json, 'workflow replay', 'workflow replay takes no --script');
  }
  const definitionPath = args.rest[1];
  const journalPath = args.rest[2];
  if (definitionPath === undefined) {
    return failWorkflowInvocation(io, json, 'workflow replay', '<definition> and <journal> are required');
  }
  if (journalPath === undefined) {
    return failWorkflowInvocation(io, json, 'workflow replay', 'a <journal> is required');
  }
  if (args.rest.length > 3) {
    return failWorkflowInvocation(io, json, 'workflow replay', '<definition> and <journal> at most');
  }
  const evidencePath = args.values.evidence;
  if (evidencePath === undefined) {
    return failWorkflowInvocation(io, json, 'workflow replay', '--evidence <path> is required');
  }

  const resolvedDefinitionPath = resolve(io.cwd, definitionPath);
  let definitionBytes: Buffer;
  try {
    definitionBytes = readFileSync(resolvedDefinitionPath);
  } catch (error) {
    return failWorkflowFile(io, json, 'workflow replay', `can't read ${definitionPath}: ${(error as Error).message}`);
  }

  const resolvedJournalPath = resolve(io.cwd, journalPath);
  let journalText: string;
  try {
    journalText = readFileSync(resolvedJournalPath, 'utf8');
  } catch (error) {
    return failWorkflowFile(io, json, 'workflow replay', `can't read ${journalPath}: ${(error as Error).message}`);
  }

  const resolvedEvidencePath = resolve(io.cwd, evidencePath);
  let evidenceText: string;
  try {
    evidenceText = readFileSync(resolvedEvidencePath, 'utf8');
  } catch (error) {
    return failWorkflowFile(io, json, 'workflow replay', `can't read ${evidencePath}: ${(error as Error).message}`);
  }

  const journalRead = readJournal(journalText);
  if (!journalRead.ok) {
    return finishReplayFailure(io, json, journalPath, {
      code: 'workflow.journal',
      why: journalRead.why,
    });
  }

  const parsed = parseWorkflow(definitionBytes.toString('utf8'));
  if ('invalid' in parsed) {
    const why = parsed.invalid.line > 0
      ? `${definitionPath}:${parsed.invalid.line}: ${parsed.invalid.message}`
      : `${definitionPath}: ${parsed.invalid.message}`;
    return finishReplayFailure(io, json, journalPath, {
      code: 'workflow.definition',
      why,
    });
  }
  if ('findings' in parsed) {
    const first = sortFindings(parsed.findings)[0];
    const why = first
      ? `${definitionPath}:${first.line > 0 ? `${first.line}: ` : ''}[${first.code}] ${plainText(first.message)}`
      : `${definitionPath}: invalid workflow definition`;
    return finishReplayFailure(io, json, journalPath, {
      code: 'workflow.definition',
      why,
    });
  }

  const evidenceRead = readEvidenceDocument(evidenceText);
  if (!evidenceRead.ok) {
    return finishReplayFailure(io, json, journalPath, {
      code: 'workflow.evidence',
      why: evidenceRead.why,
    });
  }

  const resolvers = options.resolvers
    ?? provisionalResolvers(options.teamRoles ?? resolveTeamRoles(io.cwd, resolvedDefinitionPath));
  const result = dryReplay({
    definitionBytes,
    definition: parsed.workflow,
    journalText,
    evidence: evidenceRead.evidence,
    guards: resolvers.guards,
  });

  if (!result.ok) {
    return finishReplayFailure(io, json, journalPath, result.fail);
  }

  const stepsReplayed = journalRead.journal.steps.length;
  if (json) {
    writeJson(io, 'team.workflow', {
      format: 1 as const,
      kind: 'workflow-replay' as const,
      authoritative: false as const,
      notice: DRY_NOTICE,
      ok: true as const,
      definition: journalRead.journal.definition,
      run: journalRead.journal.run,
      stepsReplayed,
      finalState: result.run.state,
      revision: result.run.revision,
      activation: result.run.activation,
      blocked: result.run.blocked ?? null,
    });
  } else {
    io.stdout(formatWorkflowReplayReport(journalPath, { ok: true, stepsReplayed, run: result.run }));
  }

  // exit: workflow.replay
  return 0;
}

export async function runWorkflow(argv: string[], io: Io, options: WorkflowCommandOptions = {}): Promise<number> {
  const args = readArgs(argv, ['script', 'evidence'], ['dry', 'json']);
  const json = hasJsonFlag(argv, ['script', 'evidence']);
  const sub = args.rest[0];
  if (sub === 'check') return runWorkflowCheck(args, io, json, options);
  if (sub === 'run') return runWorkflowRun(args, io, json, options);
  if (sub === 'replay') return runWorkflowReplay(args, io, json, options);
  const message = args.error
    ?? (sub === undefined ? 'a subcommand is required: check, run, or replay' : `unknown subcommand ${JSON.stringify(sub)}`);
  return failWorkflowInvocation(io, json, 'workflow', message);
}

const command: Command = (argv, io) => runWorkflow(argv, io);
export default command;

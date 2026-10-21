// `team workflow check <path> [--json]`: parses and validates a workflow definition (`Workflow`,
// schema v1) and its transition graph through `parseWorkflow` and `checkWorkflow(workflow,
// resolvers: WorkflowResolvers)` against the project's declared seat roles and the round's
// structural roles (`owner`, `lead`, `integrator`).
//
// Code-family boundary:
// - CLI exit ids (`workflow.check.passed`, `workflow.check.refused`, `workflow.check.invocation`,
//   `workflow.check.file`, `workflow.check.file-invalid`) live in `contract/exit-codes.json` and
//   populate `team.error.error.id` on exit 2.
// - Parse and whole-graph finding codes (`schema.*`, `graph.*`, `ref.*`, `vocab.*`, `annotation.*`
//   from `src/workflow/schema.ts` and `src/workflow/check.ts`) are line-numbered `Finding` codes
//   reported in `findings[]` and human `refusal:` / `note:` lines; they are never folded into exit
//   ids.
// - Runtime transition and effect decision codes (`src/workflow/codes.ts`) belong to run/replay
//   evaluation and are a separate family from static `Finding` codes and CLI exit ids.
//
// Read only: nothing here writes, and no herdr session is needed.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readArgs } from '../args.ts';
import { loadTeamFile } from '../file/load.ts';
import type { Command, Io } from '../io.ts';
import { plainText } from '../launch/plain.ts';
import { hasJsonFlag, pluralCount, refuse, writeJson } from '../output/index.ts';
import { checkWorkflow } from '../workflow/check.ts';
import {
  parseWorkflow,
  provisionalResolvers,
  type DefinitionId,
  type Finding,
  type WorkflowResolvers,
} from '../workflow/index.ts';

export const USAGE = `Usage: team workflow check <path> [--json]

  <path>    the workflow file to check
  --json    the report (pass or refusal) as a document, and an invocation or file error as the error document

Checks a workflow definition (schema v1) and its transition graph.

Exits 0 when the workflow passes, 1 when it is refused, 2 when the check
can't run.
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
  const fromCwd = loadTeamFile(cwd, { checkOnly: true });
  if (fromCwd.ok) {
    return [...new Set(fromCwd.team.seats.map((seat) => seat.role))];
  }
  const fromFileDir = loadTeamFile(dirname(workflowFile), { checkOnly: true });
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

export async function runWorkflow(argv: string[], io: Io, options: WorkflowCommandOptions = {}): Promise<number> {
  const args = readArgs(argv, [], ['json']);
  const json = hasJsonFlag(argv, []);
  const sub = args.rest[0];
  const fail = (message: string): number => {
    refuse(io, json, 'workflow check', { id: 'workflow.check.invocation', message, repair: null, usage: USAGE });
    // exit: workflow.check.invocation
    return 2;
  };
  if (args.error) return fail(args.error);
  if (sub !== 'check') return fail(sub === undefined ? 'a subcommand is required: check' : `unknown subcommand ${JSON.stringify(sub)}`);
  const path = args.rest[1];
  if (path === undefined) return fail('a <path> is required');
  if (args.rest.length > 2) return fail('one <path> at most');

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

const command: Command = (argv, io) => runWorkflow(argv, io);
export default command;

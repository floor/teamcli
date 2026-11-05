// `team analyse`: read-only project analysis report (Slice 1).
// Verifies the named analyser gate before any file or git read on `<path>`, then performs the
// bounded static pass (`readProjectFacts`) and prints the report or the `team.analyse` v1 JSON
// envelope (`proposal: null`). Writes no file, creates no team or project record, executes no
// discovered check, and confers no grant.

import { resolve } from 'node:path';
import {
  mayAnalyseProject,
  type AnalyseGateSources,
  type AnalyserIdentity,
  type AnalysisSource,
} from '../analyse/gate.ts';
import {
  readProjectFacts,
  type AnalysisCost,
  type ProjectReport,
} from '../analyse/read.ts';
import { readArgs } from '../args.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { plainText } from '../launch/plain.ts';
import {
  hasJsonFlag,
  writeJson,
  writeJsonError,
  type OutputSchemaTag,
} from '../output/index.ts';

export const USAGE = `Usage: team analyse [<path>] [--json]

Reads <path> (default .) after verifying the analyser setting, and reports what the project is,
how it is tested and released, its open work, its parallelizable vs. serial paths, and its git
pace. Writes no file, creates no team or project record, runs no discovered check, and confers no
grant.

Exits 0 when the report is printed, 1 when the caller is not a named analyser, a public-only analyser is run on a non-public project, or the project cannot be read, 2 when the invocation can't be read.
`;

export type AnalyseCommandSources = AnalyseGateSources & {
  now?: () => Date;
  durationMs?: number;
};

export type AnalyseJson = {
  schema: OutputSchemaTag;
  format: 1;
  at: string;
  analyser: AnalyserIdentity;
  source: AnalysisSource;
  analysis_cost: AnalysisCost;
  report: ProjectReport;
  proposal: null;
};

export const analyse: Command = (argv, io) => runAnalyse(argv, io);
export default analyse;

function formatReportText(payload: Omit<AnalyseJson, 'schema'>): string {
  const { analyser, source, analysis_cost: cost, report } = payload;
  const langs =
    report.languages.length > 0
      ? report.languages.map((l) => `${l.language} (${l.share_pct}%)`).join(', ')
      : 'none';
  const manifests = report.manifests.length > 0 ? report.manifests.join(', ') : 'none';
  const skills = report.stack_skills.length > 0 ? report.stack_skills.join(', ') : 'none';
  const checks =
    report.checks.length > 0
      ? report.checks.map((c) => `${c.command} [${c.source}]`).join(', ')
      : 'none';
  const ci = report.ci.length > 0 ? report.ci.join(', ') : 'none';
  const relWorkflows =
    report.release.workflows.length > 0 ? report.release.workflows.join(', ') : 'none';
  const par =
    report.topology.parallelizable.length > 0
      ? report.topology.parallelizable.join(', ')
      : 'none';
  const ser = report.topology.serial.length > 0 ? report.topology.serial.join(', ') : 'none';
  const findingsText =
    report.findings.length > 0
      ? `${report.findings.length} (${report.findings.map((f) => `${f.source}: ${f.summary}`).join('; ')})`
      : '0';

  return [
    `project: ${report.root} (${report.visibility.value}, ${report.size.files} files, ${report.size.lines} lines, ${report.size.mark} via ${report.size.source})`,
    `analyser: ${analyser.principal} (scope: ${analyser.scope}, source: ${source.name})`,
    `manifests: ${manifests}`,
    `languages: ${langs}`,
    `stack skills: ${skills}`,
    `checks: ${checks}`,
    `ci: ${ci}`,
    `release: tags=${report.release.tags ? 'yes' : 'no'}, workflows=${relWorkflows}`,
    `pace (${report.pace.window_days}d): ${report.pace.commits_per_day} commits/day, ${report.pace.active_hours_per_day} active h/day (${report.pace.rhythm}, ${report.pace.source})`,
    `open work: ${report.open_work.open} open, ${report.open_work.blocked} blocked (${report.open_work.source})`,
    `topology: parallelizable=[${par}], serial=[${ser}]`,
    `findings: ${findingsText}`,
    `analysis cost: ${cost.duration_ms} ms, ${cost.git_walks} git walk(s), ${cost.files_read} file(s), ${cost.bytes_read} B, $0.00`,
  ].join('\n');
}

export async function runAnalyse(
  argv: string[],
  io: Io,
  sources: AnalyseCommandSources = {},
): Promise<number> {
  const out = cleanedIo(io);
  const args = readArgs(argv, [], ['json']);
  const json = hasJsonFlag(argv);

  if (args.error !== undefined || args.rest.length > 1) {
    const why = plainText(args.error ?? `unexpected "${args.rest[1]}"`);
    if (json) {
      writeJsonError(io, 'analyse.invocation', why, null);
    } else {
      out.stderr(`team analyse: ${why}\n${USAGE}`);
    }
    // exit: analyse.invocation
    return 2;
  }

  const targetArg = args.rest[0] ?? '.';
  const gate = mayAnalyseProject(io, targetArg, sources);
  if (!gate.ok) {
    const why = plainText(gate.why);
    if (gate.code === 'analyse.scope') {
      if (json) {
        writeJsonError(io, 'analyse.scope', why, null);
      } else {
        out.stderr(`team analyse: ${why}\n`);
      }
      // exit: analyse.scope
      return 1;
    }
    if (json) {
      writeJsonError(io, 'analyse.unauthorised', why, null);
    } else {
      out.stderr(`team analyse: ${why}\n`);
    }
    // exit: analyse.unauthorised
    return 1;
  }

  const now = sources.now ? sources.now() : new Date();
  const targetAbs = resolve(io.cwd, targetArg);
  const read = readProjectFacts(targetAbs, {
    displayRoot: targetArg,
    now,
    ...(gate.visibilityHint !== undefined ? { visibilityHint: gate.visibilityHint } : {}),
  });

  if (!read.ok) {
    const why = plainText(read.why);
    if (json) {
      writeJsonError(io, 'analyse.unreadable', why, null);
    } else {
      out.stderr(`team analyse: ${why}\n`);
    }
    // exit: analyse.unreadable
    return 1;
  }

  const analysis_cost: AnalysisCost =
    sources.durationMs !== undefined
      ? { ...read.analysis_cost, duration_ms: sources.durationMs }
      : read.analysis_cost;

  const payload: Omit<AnalyseJson, 'schema'> = {
    format: 1 as const,
    at: now.toISOString(),
    analyser: gate.analyser,
    source: gate.source,
    analysis_cost,
    report: read.report,
    proposal: null,
  };

  if (json) {
    writeJson(io, 'team.analyse', payload);
  } else {
    out.stdout(`${formatReportText(payload)}\n`);
  }
  // exit: analyse.report
  return 0;
}

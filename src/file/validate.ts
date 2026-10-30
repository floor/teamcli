import type { FsReader } from '../lobby/gate.ts';
import { YamlError, parseYaml } from '../yaml.ts';
import type { YamlNode } from '../yaml.ts';
import { findSecrets } from './secrets.ts';
import { Check } from './check.ts';
import { SECTIONS } from './sections/index.ts';
import type { Ctx } from './sections/section.ts';
import { valueOf } from './sections/section.ts';
import type { Budgeted } from './sections/budgets.ts';
import type { ReleaseDecl } from './sections/releases.ts';
import type { DraftSeat } from './sections/seats.ts';
import type { Watched } from './sections/watch.ts';
import type { Seat, TeamFile, ValidateResult } from './types.ts';

export { defaultLabel } from './sections/seats.ts';
export { defaultWatch } from './sections/watch.ts';
export { defaultBudgets } from './sections/budgets.ts';

// Validates the text of a team file. Every problem is collected, each with its line.
// `root` is the project root when the caller knows it: trust entries are then checked against it.
export function validateTeamFile(text: string, options: { home?: string; fs?: FsReader; root?: string; workspaceMode?: 'worktree' | 'shared' } = {}): ValidateResult {
  let root: YamlNode;
  try {
    root = parseYaml(text);
  } catch (error) {
    if (error instanceof YamlError) return { ok: false, parse: true, errors: [{ line: error.line, message: error.message }] };
    throw error;
  }
  const check = new Check();
  const secrets = findSecrets(root, options.fs);
  check.problems.push(...secrets.refused);
  check.warnings.push(...secrets.warned);
  const team = readTeam(root, check, options.home, options.fs, options.root, options.workspaceMode);
  if (check.problems.length || !team) {
    return { ok: false, errors: check.problems.sort((a, b) => a.line - b.line) };
  }
  // Warnings read in file order, as errors do: secrets are pushed before the sections run and
  // the sections push in the order they run, so without this a warning late in the file can
  // print before one written above it. Sorting is stable, so two warnings on one line keep
  // the order they were pushed in. Deprecations keep the same order, for the same reason: the
  // check prints them in the order the file writes them.
  return {
    ok: true,
    team,
    warnings: check.warnings.sort((a, b) => a.line - b.line),
    deprecations: check.deprecations.sort((a, b) => a.line - b.line),
  };
}

function readTeam(root: YamlNode, check: Check, home?: string, fs?: FsReader, rootDir?: string, workspaceMode?: 'worktree' | 'shared'): TeamFile | null {
  if (root.kind !== 'map') {
    check.fail(root.line, 'the file must be a map of fields, starting with "format: 1"');
    return null;
  }
  // `watch.checks` names a line inside `watch`, not a top-level key, so it is no field of the file.
  const top = check.fields(root, 'the file', SECTIONS.filter((section) => !section.name.includes('.')).map((section) => section.key ?? section.name));

  const ctx: Ctx = { check, root, top, broken: new Set(), leads: [], values: new Map(), home, fs, rootDir, ...(workspaceMode !== undefined ? { workspaceMode } : {}) };

  // One wave over the list at a time: a section runs once every section it reads (`after`) has
  // run, so the code moved into the modules reports in the order it reported when it lived here.
  const pending = new Map(SECTIONS.map((section) => [section.name, section]));
  while (pending.size > 0) {
    let ran = 0;
    for (const section of SECTIONS) {
      if (!pending.has(section.name)) continue;
      if (section.after.some((name) => pending.has(name))) continue;
      ctx.values.set(section.name, section.validate(top.get(section.key ?? section.name), ctx));
      pending.delete(section.name);
      ran++;
    }
    if (ran === 0) throw new Error(`circular section dependencies: ${[...pending.keys()].join(', ')}`);
  }

  // A seat that sets no mode works the way the workspace says. Kept here: it reads two sections'
  // values and belongs to neither.
  const seats = valueOf<DraftSeat[]>(ctx, 'seats');
  const mode = valueOf<TeamFile['workspace']>(ctx, 'workspace').mode;
  for (const seat of seats) seat.mode ??= mode;
  const policies = valueOf<TeamFile['policies'] | null>(ctx, 'policies');
  const bus = valueOf<TeamFile['bus'] | null>(ctx, 'bus');

  return {
    format: 1,
    project: valueOf<string>(ctx, 'project'),
    inProject: valueOf<string | null>(ctx, 'in_project'),
    projectLead: valueOf<boolean>(ctx, 'project_lead'),
    entity: valueOf<string | null>(ctx, 'entity'),
    lobby: valueOf<string | null>(ctx, 'lobby'),
    visibility: valueOf<TeamFile['visibility']>(ctx, 'visibility'),
    session: valueOf<string>(ctx, 'session'),
    orchestrator: valueOf<string>(ctx, 'orchestrator'),
    operator: valueOf<string>(ctx, 'operator'),
    deliveryOrder: valueOf<TeamFile['deliveryOrder']>(ctx, 'delivery_order'),
    senderName: valueOf<TeamFile['senderName']>(ctx, 'sender_name'),
    ...(policies !== null && policies !== undefined ? { policies } : {}),
    ...(bus !== null && bus !== undefined ? { bus } : {}),
    tools: valueOf<TeamFile['tools']>(ctx, 'tools'),
    identity: valueOf<TeamFile['identity']>(ctx, 'identity'),
    rules: valueOf<string[]>(ctx, 'rules'),
    trust: valueOf<string[]>(ctx, 'trust'),
    workspace: valueOf<TeamFile['workspace']>(ctx, 'workspace'),
    watch: valueOf<Watched>(ctx, 'watch').watch,
    budgets: valueOf<Budgeted>(ctx, 'budgets').budgets,
    machine: valueOf<TeamFile['machine']>(ctx, 'machine'),
    limits: valueOf<TeamFile['limits']>(ctx, 'limits'),
    releases: valueOf<ReleaseDecl[]>(ctx, 'releases'),
    tasks: valueOf<TeamFile['tasks']>(ctx, 'tasks'),
    tempo: valueOf<TeamFile['tempo']>(ctx, 'tempo'),
    installer: valueOf<string | null>(ctx, 'installer'),
    clients: valueOf<TeamFile['clients']>(ctx, 'clients'),
    grant: valueOf<TeamFile['grant']>(ctx, 'grant'),
    delegates: valueOf<TeamFile['delegates']>(ctx, 'delegates'),
    seats: seats as Seat[],
  };
}

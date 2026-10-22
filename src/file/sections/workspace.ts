import type { YamlEntry } from '../../yaml.ts';
import { insideTrust, isLegacyTrust, isMigratedTrust, normalize } from '../paths.ts';
import type { Check } from '../check.ts';
import type { Mode, TeamFile } from '../types.ts';
import type { Section } from './section.ts';
import { valueOf } from './section.ts';
import type { DraftSeat } from './seats.ts';

export const MODES: Mode[] = ['worktree', 'shared'];

export const workspace: Section = {
  name: 'workspace',
  owner: true,
  after: ['seats', 'project', 'trust'],
  validate(entry, ctx) {
    const project = valueOf<string>(ctx, 'project');
    const trust = valueOf<string[]>(ctx, 'trust');
    const seats = valueOf<DraftSeat[]>(ctx, 'seats');
    return readWorkspace(entry, ctx.check, project, trust, seats, ctx.root.line, ctx.workspaceMode);
  },
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: { enum: MODES },
      path: { type: 'string', pattern: '(^|/)\\{task\\}$' },
      branch: { type: 'string' },
      base: { type: 'string' },
      setup: { type: 'array', items: { type: 'string' } },
      remove: { enum: ['on-merge', 'manual'] },
      protected: { type: 'array', items: { type: 'string' } },
      limit: { type: 'integer', minimum: 1 },
    },
    $comment: 'path ends with the segment {task} under a fixed folder of its own, inside a trust pattern; branch defaults to {task}, base and path are required when a seat works in worktrees — the validator checks what a pattern cannot say',
  },
};

function readWorkspace(
  entry: YamlEntry | undefined, check: Check, project: string, trust: string[], seats: DraftSeat[], topLine: number, defaultMode: Mode = 'worktree',
): TeamFile['workspace'] {
  const fields = check.fields(entry?.value, 'workspace', ['mode', 'path', 'branch', 'base', 'setup', 'remove', 'protected', 'limit']);
  const mode = check.oneOf(fields.get('mode'), 'workspace.mode', MODES) ?? defaultMode;
  const usesWorktrees = seats.some((seat) => (seat.mode ?? mode) === 'worktree');
  const line = entry?.line ?? topLine;

  const path = check.text(fields.get('path'), 'workspace.path') ?? null;
  const base = check.text(fields.get('base'), 'workspace.base') ?? null;
  if (usesWorktrees && !base) check.fail(line, 'workspace.base is required when a seat works in worktrees');
  if (usesWorktrees && !path) check.fail(line, 'workspace.path is required when a seat works in worktrees');
  if (path) {
    const at = fields.get('path')?.value.line ?? line;
    if (/[\x00-\x1f\x7f`]/.test(path)) {
      check.fail(at, 'workspace.path must not contain control characters or backticks');
    }
    const problem = worktreePathProblem(path, project, trust);
    if (problem) check.fail(at, `workspace.path ${problem}`);
  }
  const protectedItems = fields.get('protected') ? check.list(fields.get('protected'), 'workspace.protected') : [];
  for (const item of protectedItems) {
    if (/[\x00-\x1f\x7f`]/.test(item.value)) {
      check.fail(item.line, 'workspace.protected must not contain control characters or backticks');
    }
  }
  const protectedPaths = fields.get('protected') ? protectedItems.map((item) => item.value) : ['.'];
  const branch = check.text(fields.get('branch'), 'workspace.branch') ?? '{task}';
  if (/[\x00-\x1f\x7f`]/.test(branch)) {
    check.fail(fields.get('branch')?.value.line ?? line, 'workspace.branch must not contain control characters or backticks');
  }

  return {
    mode,
    path,
    branch,
    base,
    setup: check.list(fields.get('setup'), 'workspace.setup').map((item) => item.value),
    remove: check.oneOf(fields.get('remove'), 'workspace.remove', ['on-merge', 'manual']) ?? 'on-merge',
    protected: protectedPaths,
    limit: check.whole(fields.get('limit'), 'workspace.limit', 1) ?? 8,
  };
}

// A worktree goes under a fixed folder of its own, and inside a trust path.
function worktreePathProblem(path: string, project: string, trust: string[]): string | null {
  if (path.startsWith('/') || path.startsWith('~')) return 'must be relative to the project';
  const segments = path.split('/').filter((segment) => segment && segment !== '.');
  const last = segments[segments.length - 1];
  if (last !== '{task}') return 'must end with the segment {task}';
  if (segments.slice(0, -1).some((segment) => segment.includes('{task}'))) return 'takes {task} only as its last segment';
  const folder = segments.slice(0, -1).map((segment) => segment.replaceAll('{repo}', project || 'project'));
  if (folder.every((segment) => segment === '..')) {
    return 'needs a fixed folder of its own before {task}: this one puts worktrees straight into the project or one of its parents';
  }
  const sample = normalize([...folder, 'task'].join('/'));
  if (isLegacyTrust(trust) && !insideTrust(sample, trust)) return 'matches no trust pattern';
  return null;
}

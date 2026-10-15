// The owner's override file. It sits beside the approval and may only add dialog
// patterns and quota patterns to a profile this version ships. It cannot take a
// shipped pattern out, and it cannot change a composer, a prompt, a footer, a
// launch line or the order of the stages: anything else in the file is refused
// with its line. An edit takes effect only once `approve` records the text: until
// then the approved copy stays in force, and a copy that cannot be read leaves
// the shipped profiles.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QuotaPattern } from './quota.ts';
import { profileFor, quotaFor, quotaList } from './profile.ts';
import { approvalStanding, findStore, storePath, type Standing } from '../store/store.ts';
import { addedRules } from '../watch/screen-file.ts';
import type { ScreenData, Stage } from '../watch/screen-data.ts';
import { classifyData, screenData, type Screen } from '../watch/screen.ts';
import { YamlError, parseYaml, type YamlEntry, type YamlNode } from '../yaml.ts';

export const DIALOG_STAGES = ['unknown', 'trust', 'permission', 'question'] as const;
export type DialogStage = (typeof DIALOG_STAGES)[number];

export type ProfileOverride = {
  cli: string;
  screen: Partial<Record<DialogStage, Stage>>;
  quota: QuotaPattern[];
};

export type OverrideProblem = { line: number; message: string };

export type OverrideParse =
  | { ok: true; profiles: ProfileOverride[] }
  | { ok: false; errors: OverrideProblem[] };

/** `<store>/overrides.yaml`, the same folder as the approval for this root. The folder is the
 *  one `findStore` reads, so a rename that has not been approved again still finds the file.
 *  The next approval is written under the current project's own folder. */
export function overridesPath(project: string, root: string, home: string): string {
  return join(findStore(root, home) ?? storePath(project, root, home), 'overrides.yaml');
}

/** The file's added patterns, or the line that refuses it. One error, the first. */
export function parseOverrides(text: string): OverrideParse {
  try {
    return { ok: true, profiles: profilesOf(parseYaml(text)) };
  } catch (error) {
    if (error instanceof YamlError) return { ok: false, errors: [{ line: error.line, message: error.message }] };
    throw error;
  }
}

/**
 * Shipped rules stay first, and the added ones follow. The composer and the
 * chrome are the shipped profile's own objects, so an override cannot retune
 * them by merging.
 */
export function mergeScreen(base: ScreenData, added: ProfileOverride): ScreenData {
  const next: ScreenData = { ...base };
  for (const name of DIALOG_STAGES) {
    const extra = added.screen[name];
    if (!extra) continue;
    const existing = base[name];
    next[name] = { rules: [...(existing?.rules ?? []), ...extra.rules] };
  }
  return next;
}

// A shipped vendor notice is never weakened by an override: an added pattern may move a reading
// toward caution, never away from the one record that names a screen the owner must act on. The
// CLI's own exit question is pinned the same way, on the stop's side: a stop answers that screen
// with the profile's key, so an override may not move the reading away from it.
const KEPT = new Set<Screen['kind']>(['permission', 'trust', 'question', 'vendor notice', 'exit question', 'provider error', 'rate limit']);
// `vendor notice` is not here on purpose: an override can never add that stage (DIALOG_STAGES
// names the stages it may add patterns to), so a merged reading can never gain one. A shipped
// one is pinned by KEPT above. `exit question` is the same, and for the same reason: only the
// shipped profile may name the screen a stop answers.
const DIALOG = new Set<Screen['kind']>(['unknown', 'trust', 'permission', 'question']);

/**
 * An added pattern may move a reading toward a dialog. It may not make a screen
 * idle or unsent when the shipped profile does not, and it may not stop a
 * shipped permission, trust or question pattern from matching.
 */
export function guardReading(shipped: Screen, merged: Screen): Screen {
  if (KEPT.has(shipped.kind)) return shipped;
  if ((merged.kind === 'idle' || merged.kind === 'unsent') && merged.kind !== shipped.kind) return shipped;
  if (!DIALOG.has(merged.kind)) return shipped;
  return merged;
}

/** The shipped reading, then the same window with this profile's added patterns, guarded. */
export function classifyWith(cli: string, screen: string | undefined, profiles: readonly ProfileOverride[]): Screen {
  if (screen === undefined) return { kind: 'unknown' };
  const base = screenData(cli);
  if (!base) return { kind: 'unknown' };
  const lines = screen.split('\n');
  const shipped = classifyData(base, lines);
  const added = profiles.find((profile) => profile.cli === cli);
  if (!added || DIALOG_STAGES.every((stage) => added.screen[stage] === undefined)) return shipped;
  return guardReading(shipped, classifyData(mergeScreen(base, added), lines));
}

/** Shipped quota patterns, then the override's. The shipped ones are never dropped. */
export function quotaWith(cli: string, profiles: readonly ProfileOverride[]): readonly QuotaPattern[] {
  const added = profiles.find((profile) => profile.cli === cli)?.quota ?? [];
  return [...quotaFor(cli), ...added];
}

/** What `approve` records when the override file itself is the change. */
export const OVERRIDE_CHANGED = '`overrides` changed';

/** A stored copy that does not parse. The shipped profiles stay in force. */
export const OVERRIDE_UNREADABLE = "the approved overrides can't be read";

export type OverrideForce = {
  /** The approved patterns. Empty when none were approved, or the copy cannot be read. */
  profiles: ProfileOverride[];
  /** Drift from the last approval. Empty when the file matches it, or there is none. */
  differences: string[];
  /** The live file, when it cannot be read or parsed. Already carrying the path and the line. */
  problems: string[];
};

/** The override file's text, and why it was refused. A missing file is an empty text and no problem. */
export function overrideFile(project: string, root: string, home: string): { path: string; text: string | null; problems: string[] } {
  const path = overridesPath(project, root, home);
  try {
    const text = readFileSync(path, 'utf8');
    const parsed = parseOverrides(text);
    return { path, text, problems: parsed.ok ? [] : parsed.errors.map((problem) => overrideProblem(path, problem)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, text: null, problems: [] };
    return { path, text: null, problems: [overrideProblem(path, { line: 0, message: "can't be read" })] };
  }
}

/**
 * The patterns in force for this project, from one standing the caller read.
 * Keyed on the project root, the same store as the team-file approval: another
 * checkout of the same name has its own. The approved text is the verified
 * record's own, so a standing that is not verified leaves the shipped profiles.
 * No file, or a stored copy that cannot be read, leaves the shipped profiles
 * too. The live file is used only when it is the text `approve` recorded.
 */
export function overridesInForceOf(standing: Standing, project: string, root: string, home: string): OverrideForce {
  const record = standing.kind === 'verified' ? standing.record : null;
  const recorded = record !== null && Object.hasOwn(record.approval, 'overrides');
  const stored = recorded ? record?.approval.overrides : undefined;
  const approvedText = typeof stored === 'string' ? stored : null;
  const live = overrideFile(project, root, home);
  const differences: string[] = [];
  const profiles: ProfileOverride[] = [];

  if (approvedText !== null) {
    const parsed = parseOverrides(approvedText);
    if (parsed.ok) profiles.push(...parsed.profiles);
    else differences.push(OVERRIDE_UNREADABLE);
  } else if (recorded && stored !== null && stored !== undefined) {
    differences.push(OVERRIDE_UNREADABLE);
  }

  if (live.text !== approvedText) {
    if (record === null) {
      if (live.text !== null) differences.push('the overrides were never approved');
    } else differences.push(OVERRIDE_CHANGED);
  }

  return { profiles, differences, problems: live.problems };
}

/** `overridesInForce` as a standalone caller uses it: one read of its own, then the derivation. */
export function overridesInForce(project: string, root: string, home: string): OverrideForce {
  return overridesInForceOf(approvalStanding(root, home), project, root, home);
}

export function overrideProblem(path: string, problem: OverrideProblem): string {
  return problem.line ? `${path}: line ${problem.line}: ${problem.message}` : `${path}: ${problem.message}`;
}

function profilesOf(root: YamlNode): ProfileOverride[] {
  const entries = mapping(root, 'an override file');
  const format = required(entries, 'format', root.line);
  if (format.value.kind !== 'scalar' || format.value.value !== 1) fail(format.line, '"format" must be 1');
  only(entries, ['format', 'profiles']);
  const profiles = required(entries, 'profiles', root.line);
  const named = mapping(profiles.value, '"profiles"');
  if (named.length === 0) fail(profiles.line, '"profiles" must name a profile');
  return named.map(profileOf);
}

function profileOf(entry: YamlEntry): ProfileOverride {
  if (!profileFor(entry.key)) fail(entry.line, `unknown profile "${entry.key}"`);
  const entries = mapping(entry.value, 'a profile override');
  only(entries, ['screen', 'quota']);
  const screen = optional(entries, 'screen');
  const quota = optional(entries, 'quota');
  if (!screen && !quota) fail(entry.line, 'a profile override adds dialog patterns or quota patterns');
  const stages = screen ? screenOf(screen.value) : {};
  if (screen && Object.keys(stages).length === 0 && !quota) {
    fail(screen.line, 'a profile override adds dialog patterns or quota patterns');
  }
  return { cli: entry.key, screen: stages, quota: quota ? quotaList(quota.value) : [] };
}

function screenOf(node: YamlNode): ProfileOverride['screen'] {
  const entries = mapping(node, 'screen');
  only(entries, DIALOG_STAGES);
  const screen: ProfileOverride['screen'] = {};
  for (const entry of entries) screen[entry.key as DialogStage] = { rules: addedRules(entry.value) };
  return screen;
}

function mapping(node: YamlNode, what: string): YamlEntry[] {
  if (node.kind !== 'map') fail(node.line, `${what} must be a map`);
  return node.entries;
}

function only(entries: YamlEntry[], allowed: readonly string[]): void {
  for (const entry of entries) if (!allowed.includes(entry.key)) fail(entry.line, `unknown key "${entry.key}"`);
}

function required(entries: YamlEntry[], key: string, line: number): YamlEntry {
  return optional(entries, key) ?? fail(line, `missing "${key}"`);
}

function optional(entries: YamlEntry[], key: string): YamlEntry | undefined {
  return entries.find((entry) => entry.key === key);
}

function fail(line: number, message: string): never {
  throw new YamlError(line, message);
}

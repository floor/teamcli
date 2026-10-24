import { lstatSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { describeCaller, isOwner, walkCaller } from './caller.ts';
import { devModeOwnerLiftAtCwd } from './dev_mode.ts';
import { findRoot, withoutFileOffer } from './file/load.ts';
import { readTeamConfig } from './file/team-config.ts';
import type { TeamFile } from './file/types.ts';
import { validateTeamFile } from './file/validate.ts';
import { writeTeamFile } from './file/write.ts';
import { cleanedIo, type Io } from './io.ts';
import { plainText } from './launch/plain.ts';
import { writeJson, writeJsonError } from './output/index.ts';
import { withLock } from './state.ts';
import { approvedRecordOf } from './store/store.ts';
import { parseYaml, type YamlNode } from './yaml.ts';

export type AuthorityEdit =
  | { kind: 'grant'; seat: string; scope: string[] }
  | { kind: 'delegate'; pane: string; commands: string[] }
  | { kind: 'revoke-grant' }
  | { kind: 'revoke-delegate'; pane: string };

export type AuthorityEditOptions = {
  home?: string;
  dryRun?: boolean;
  json?: boolean;
  /** Tests only: change the fixture after planning, before the final file check. */
  beforeWrite?: () => void;
};

export type AuthorityEditResult = 'ok' | 'refused' | 'invalid';

/** Owner-only management of the existing file records; existing grants cannot admit it. */
export async function runAuthorityEdit(
  command: 'grant' | 'delegate' | 'revoke',
  edit: AuthorityEdit,
  rawIo: Io,
  options: AuthorityEditOptions = {},
): Promise<AuthorityEditResult> {
  const io = cleanedIo(rawIo);
  const json = Boolean(options.json);
  const caller = walkCaller(io);
  if (!isOwner(caller)) {
    const msg = `only the owner runs this, from a terminal outside herdr; this call is ${describeCaller(caller)}`;
    // The owner's dev-mode admission for exactly this gate: a placed lead or
    // orchestrator continues with the warning; the owner's own path above is untouched.
    const lift = devModeOwnerLiftAtCwd(rawIo, { command, refusal: msg, home: options.home ?? homedir() });
    if (lift === null || !lift.lifted) {
      if (json) {
        writeJsonError(rawIo, `${command}.refused`, plainText(msg), `the owner runs \`team ${command}\` from a terminal outside herdr`, 1, 'owner-only');
      } else {
        io.stderr(`team ${command}: ${msg}\n`);
      }
      return 'refused';
    }
    io.stderr(`${lift.warning}\n`);
  }

  const home = options.home ?? homedir();
  let loaded: ReturnType<typeof readTeamConfig>;
  try {
    const root = findRoot(io.cwd) ?? realpathSync(io.cwd);
    requireRegularFile(join(root, '.agents', 'team.yaml'));
    loaded = readTeamConfig(io.cwd, { home });
  } catch (error) {
    const msg = withoutFileOffer(message(error));
    if (json) {
      writeJsonError(rawIo, `${command}.invalid`, plainText(msg), null);
    } else {
      io.stderr(`team ${command}: ${msg}\n`);
    }
    return 'invalid';
  }
  if (!loaded.ok) {
    const msg = withoutFileOffer(loaded.errors[0]?.message ?? 'the team file cannot be read');
    if (json) {
      writeJsonError(rawIo, `${command}.invalid`, plainText(msg), null);
    } else {
      io.stderr(`team ${command}: ${msg}\n`);
    }
    return 'invalid';
  }

  let next: string;
  try {
    next = editedText(loaded.text, loaded.team, edit);
    const checked = validateTeamFile(next, { home, root: loaded.root });
    if (!checked.ok) {
      const msg = checked.errors[0]?.message ?? 'invalid authority record';
      if (json) {
        writeJsonError(rawIo, `${command}.invalid`, plainText(msg), null);
      } else {
        io.stderr(`team ${command}: ${msg}\n`);
      }
      return 'invalid';
    }
  } catch (error) {
    const msg = message(error);
    if (json) {
      writeJsonError(rawIo, `${command}.invalid`, plainText(msg), null);
    } else {
      io.stderr(`team ${command}: ${msg}\n`);
    }
    return 'invalid';
  }
  // Unchanged is decided on the canonical team record, the form an approval signs, not on the
  // text: an edit that only reorders or reformats is no change. A text with no record is a change.
  if (next === loaded.text || sameRecord(loaded.text, next)) {
    if (json) {
      writeAuthorityJson(rawIo, command, edit, loaded.team, Boolean(options.dryRun), 'unchanged', `${command}: unchanged`);
    } else {
      io.stdout(`${command}: unchanged\n`);
    }
    return 'ok';
  }
  if (options.dryRun) {
    if (json) {
      writeAuthorityJson(rawIo, command, edit, loaded.team, true, 'dry-run', `${command}: would change`);
    } else {
      io.stdout(`${command}: would change\n`);
    }
    return 'ok';
  }

  try {
    withLock(dirname(loaded.path), () => {
      options.beforeWrite?.();
      requireRegularFile(loaded.path);
      if (readFileSync(loaded.path, 'utf8') !== loaded.text) {
        throw new Error('the team file changed while checking; nothing written');
      }
      requireAbsentTemporary(loaded.path);
      const wrote = writeTeamFile(loaded.path, next);
      if (!wrote.ok) throw new Error(wrote.errors[0]?.message ?? 'the team file cannot be written');
    });
  } catch (error) {
    const msg = message(error);
    if (json) {
      writeJsonError(rawIo, `${command}.refused`, plainText(msg), null);
    } else {
      io.stderr(`team ${command}: ${msg}\n`);
    }
    return 'refused';
  }
  if (json) {
    writeAuthorityJson(rawIo, command, edit, loaded.team, false, 'updated', `${command}: updated`);
  } else {
    io.stdout(`${command}: updated\n`);
  }
  return 'ok';
}

function writeAuthorityJson(
  io: Io,
  command: 'grant' | 'delegate' | 'revoke',
  edit: AuthorityEdit,
  team: TeamFile,
  dryRun: boolean,
  status: 'updated' | 'unchanged' | 'dry-run',
  summary: string,
): void {
  const target =
    edit.kind === 'grant'
      ? edit.seat
      : edit.kind === 'delegate' || edit.kind === 'revoke-delegate'
        ? edit.pane
        : 'grant';
  writeJson(io, `team.${command}`, {
    format: 1 as const,
    dry_run: dryRun,
    status,
    action_summary: summary,
    project: team.project,
    session: team.session,
    target,
    ...(edit.kind === 'grant' ? { scope: edit.scope } : {}),
    ...(edit.kind === 'delegate' ? { commands: edit.commands } : {}),
    ...(dryRun
      ? {
          plan: [
            {
              step: command,
              detail: summary,
              prefix: (status === 'unchanged' ? 'skip' : '+') as '+' | 'skip',
            },
          ],
        }
      : {}),
  });
}

/** Whether two texts are the same canonical team record; false when either has none. */
function sameRecord(a: string, b: string): boolean {
  const left = approvedRecordOf(a);
  return left !== null && left === approvedRecordOf(b);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Refuses a linked team file; a missing one is left to the loader's own no-team-file refusal.
 * The sweep caught a raw `ENOENT ... lstat '<cwd>/.agents'` here, printed as `*.invalid`: this
 * check runs before the loader, which is the one that knows how to say there is no file.
 */
function requireRegularFile(path: string): void {
  let dir: Stats;
  try {
    dir = lstatSync(dirname(path));
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  let file: Stats;
  try {
    file = lstatSync(path);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  if (!dir.isDirectory() || dir.isSymbolicLink() || !file.isFile() || file.isSymbolicLink()) {
    throw new Error('the team file and its .agents directory must not be symbolic links');
  }
}

/** Whether a failed lstat means nothing is there (`ENOENT`, or `ENOTDIR` when `.agents` is a file). */
function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** The existing atomic writer must not follow an old temporary entry, even a dangling link. */
function requireAbsentTemporary(path: string): void {
  try {
    lstatSync(`${path}.${process.pid}.tmp`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('the temporary team file already exists; nothing written');
}

function editedText(text: string, team: TeamFile, edit: AuthorityEdit): string {
  if (edit.kind === 'grant') {
    const grant = { session: team.session, seat: edit.seat, scope: edit.scope };
    if (JSON.stringify(grant) === JSON.stringify(team.grant)) return text;
    return replaceSection(text, 'grant', [
      'grant:',
      `  session: ${JSON.stringify(grant.session)}`,
      `  seat: ${JSON.stringify(grant.seat)}`,
      `  scope: ${JSON.stringify(grant.scope)}`,
    ]);
  }
  if (edit.kind === 'revoke-grant') return replaceSection(text, 'grant', []);

  const entries: { pane: string; commands: string[] }[] = [...(team.delegates ?? [])];
  const index = entries.findIndex((entry) => entry.pane === edit.pane);
  if (edit.kind === 'delegate') {
    const entry = { pane: edit.pane, commands: edit.commands };
    if (index < 0) entries.push(entry);
    else entries[index] = entry;
  } else {
    // Even a no-op must name a well-formed external target.
    if (!/^[^\s/]+\/[^\s/]+$/.test(edit.pane) || edit.pane.split('/')[0] === team.session) {
      throw new Error('a delegate target must be <session/pane> outside this team');
    }
    if (index < 0) return text;
    entries.splice(index, 1);
  }
  if (JSON.stringify(entries) === JSON.stringify(team.delegates ?? [])) return text;
  return replaceSection(text, 'delegates', entries.length === 0 ? [] : [
    'delegates:',
    ...entries.flatMap((entry) => [
      `  - pane: ${JSON.stringify(entry.pane)}`,
      `    commands: ${JSON.stringify(entry.commands)}`,
    ]),
  ]);
}

function lastLine(node: YamlNode): number {
  if (node.kind === 'scalar') return node.line;
  if (node.kind === 'seq') return Math.max(node.line, ...node.items.map(lastLine));
  return Math.max(node.line, ...node.entries.map((entry) => Math.max(entry.line, lastLine(entry.value))));
}

/** Only the selected top-level entry is rewritten; adjoining comments remain in place. */
function replaceSection(text: string, key: 'grant' | 'delegates', body: string[]): string {
  const parsed = parseYaml(text);
  if (parsed.kind !== 'map') throw new Error('the team file must be a map');
  const entry = parsed.entries.find((entry) => entry.key === key);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  if (!entry) {
    if (body.length === 0) return text;
    return text + (text.endsWith('\n') ? '' : newline) + body.join(newline) + newline;
  }
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  // A flow map at the document root puts unrelated keys on the same line. Refuse instead
  // of reserializing those owner sections as a side effect of this one-record command.
  const end = Math.max(entry.line, lastLine(entry.value));
  if (parsed.entries.some((other) => other !== entry && other.line >= entry.line && other.line <= end)) {
    throw new Error('put the authority section on its own lines before editing it');
  }
  const bom = entry.line === 1 && text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const terminated = lines[end - 1]?.endsWith('\n');
  const replacement = body.length ? body.join(newline) + (terminated ? newline : '') : '';
  const before = lines.slice(0, entry.line - 1).join('');
  const after = lines.slice(end).join('');
  return bom + before + replacement + after;
}

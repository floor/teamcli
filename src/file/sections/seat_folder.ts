import type { Section } from './section.ts';

/** Where a seat that needs a folder of its own starts when its line names no `cwd`. Words in
 *  braces are filled from the team: `{project}` the project the team works in (`in_project`,
 *  else the team's own), `{team}` the team, `{seat}` the seat. Relative to the team's folder.
 *  Non-owner and additive: a file that does not set it keeps every digest it had. */
export const SEAT_FOLDER_DEFAULT = 'worktrees/{project}/{team}/{seat}';

export const seatFolder: Section = {
  name: 'seat_folder',
  owner: false,
  after: [],
  validate(entry, ctx) {
    const text = ctx.check.text(entry, 'seat_folder');
    if (text === undefined || !entry) return SEAT_FOLDER_DEFAULT;
    const line = entry.value.line;
    if (text.startsWith('/') || text.startsWith('~') || /^[A-Za-z]:[\\/]/.test(text)) {
      ctx.check.fail(line, 'seat_folder must be relative to the team\'s folder, never absolute and never "~"');
      return SEAT_FOLDER_DEFAULT;
    }
    if (/[\x00-\x1f\x7f`]/.test(text) || text.split('/').includes('..')) {
      ctx.check.fail(line, 'seat_folder must not contain "..", control characters or backticks');
      return SEAT_FOLDER_DEFAULT;
    }
    if (!text.includes('{seat}')) {
      ctx.check.fail(line, 'seat_folder must contain {seat}, so two seats never share a folder');
      return SEAT_FOLDER_DEFAULT;
    }
    const unknown = (text.match(/\{[^}]*\}/g) ?? []).filter((word) => !['{project}', '{team}', '{seat}'].includes(word));
    if (unknown.length > 0) {
      ctx.check.fail(line, `seat_folder knows {project}, {team} and {seat}, not ${unknown.join(', ')}`);
      return SEAT_FOLDER_DEFAULT;
    }
    return text;
  },
  schema: { type: 'string', $comment: 'relative to the team folder; {project}, {team} and {seat} are filled in' },
};

/** The folder `pattern` names for one seat. */
export function seatFolderOf(pattern: string, project: string, team: string, seat: string): string {
  return pattern.replaceAll('{project}', project).replaceAll('{team}', team).replaceAll('{seat}', seat);
}

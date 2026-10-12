import type { Section } from './section.ts';

// An entity name is one path segment: the same shape as a project name, so lower-casing it
// (`lobbySlug`) is the whole slug and never yields "", "." or "..". The slug is the folder the
// team's lobby lives in, under `~/.config/team/lobbies/`.
const ENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The entity the team belongs to, or null when the file names none. When set — and no explicit
 * `lobby` overrides it — the team operates on its own lobby under `~/.config/team/lobbies/<slug>`,
 * so a second team on the machine no longer waits behind the first's lobby. A file that sets
 * neither `entity` nor `lobby` keeps the machine-global lobby, unchanged.
 */
export const entity: Section = {
  name: 'entity',
  owner: false,
  after: [],
  validate(entry, ctx) {
    const value = ctx.check.text(entry, 'entity');
    if (value === undefined) return null;
    if (!ENTITY.test(value)) {
      ctx.check.fail(
        entry?.line ?? 1,
        'entity must be a short name: letters, digits, ".", "_" and "-", starting with a letter or a digit',
      );
      return null;
    }
    return value;
  },
  schema: {
    type: 'string',
    minLength: 1,
    pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
    $comment: 'the entity the team belongs to; its lobby is ~/.config/team/lobbies/<entity>',
  },
};

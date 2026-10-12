import type { Section } from './section.ts';

const CONTROL_OR_BACKTICK = /[\x00-\x1f\x7f`]/;

/**
 * The folder the team's seats start and wait in, or null when the file names none. It is an
 * absolute path or starts with `~/` (the home) and holds no `..` segment: a relative or
 * traversing value would otherwise anchor to a cwd and only fail later at the trust refusal, so
 * it is refused here, legibly. Set, it is the lobby outright, ahead of any `entity`; the gate's
 * own symlink, owner and realpath checks then decide whether the resolved folder may be used, and
 * trust must list it. Omitted with `entity`, the lobby is `~/.config/team/lobbies/<entity>`;
 * omitted with both, the machine-global lobby `~/.config/team/lobby`, unchanged.
 */
export const lobby: Section = {
  name: 'lobby',
  owner: false,
  after: [],
  validate(entry, ctx) {
    const value = ctx.check.text(entry, 'lobby');
    if (value === undefined) return null;
    const line = entry?.line ?? 1;
    if (CONTROL_OR_BACKTICK.test(value)) {
      ctx.check.fail(line, 'lobby must not contain control characters or backticks');
      return null;
    }
    const absolute = value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
    if (!absolute && !value.startsWith('~/')) {
      ctx.check.fail(line, 'lobby must be an absolute path or start with "~/"');
      return null;
    }
    if (value.split('/').some((segment) => segment === '..')) {
      ctx.check.fail(line, 'lobby must not contain a ".." segment');
      return null;
    }
    return value;
  },
  schema: {
    type: 'string',
    minLength: 1,
    $comment: 'the folder the team\'s seats start and wait in; a ~ prefix is the home. Overrides entity',
  },
};

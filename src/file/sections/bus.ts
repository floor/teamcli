import type { TeamFile } from '../types.ts';
import type { Section } from './section.ts';

/**
 * The team's event bus. `team up` starts `team bus` in its own workspace, the way it starts the
 * watch, unless `bus.autostart` is false; `team down` stops it. Non-owner and additive: a file
 * that writes no `bus:` keeps the default (autostart on) and changes no approval digest.
 */
export const bus: Section = {
  name: 'bus',
  owner: false,
  after: [],
  validate(entry, ctx): TeamFile['bus'] {
    const fields = ctx.check.fields(entry?.value, 'bus', ['autostart']);
    const autostart = fields.get('autostart');
    return { autostart: autostart === undefined ? true : ctx.check.flag(autostart, 'bus.autostart') };
  },
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      autostart: {
        type: 'boolean',
        description: 'whether team up starts the event bus in its own workspace and team down stops it; on unless set to false',
      },
    },
  },
};

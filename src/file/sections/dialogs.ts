import type { Section } from './section.ts';

/** The parsed policy. The file's `orchestrator` normalises to `coordinator`: the value records hash. */
export type Dialogs = { trust: 'owner' | 'coordinator' };

/** Omitted means the owner answers every trust dialog. The only key is `trust`. */
export const dialogs: Section = {
  name: 'dialogs',
  owner: true,
  after: [],
  validate(entry, ctx) {
    if (!entry) return { trust: 'owner' } satisfies Dialogs;
    if (entry.value.kind !== 'map') {
      ctx.check.fail(entry.line, 'dialogs must be a map containing trust');
      return { trust: 'owner' } satisfies Dialogs;
    }
    const fields = ctx.check.fields(entry.value, 'dialogs', ['trust']);
    if (entry.value.entries.length === 0 || !fields.has('trust')) {
      ctx.check.fail(entry.line, 'dialogs must contain trust');
    }
    const trustEntry = fields.get('trust');
    const trust = ctx.check.oneOf(trustEntry, 'dialogs.trust', ['owner', 'orchestrator', 'coordinator']);
    // The old word is still read, and says so once, at its own line.
    if (trust === 'coordinator' && trustEntry) {
      ctx.check.warnings.push({
        line: trustEntry.value.line,
        message: '`dialogs.trust: coordinator` is now `orchestrator`, and is still read',
        repair: 'set `dialogs.trust: orchestrator` in .agents/team.yaml',
      });
    }
    // One policy, one parsed value: the new word normalises to the one every record's digest was
    // written with, so a file rewritten to it is still the file the owner approved.
    return { trust: trust === 'orchestrator' ? 'coordinator' : trust ?? 'owner' } satisfies Dialogs;
  },
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['trust'],
    properties: { trust: { enum: ['owner', 'orchestrator', 'coordinator'] } },
    $comment: 'who may answer a folder-trust dialog. Omitted means owner, and then no command sends a trust key',
  },
};

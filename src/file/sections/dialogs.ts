import type { Section } from './section.ts';

/**
 * `dialogs:` is the 0.4 line's trust-dialog setting. It is read and ignored: answering a trust
 * dialog is the owner's live team grant now, so the key grants nothing. It stays a known field
 * so a file written for the 0.4 line still loads, and `team check` and `team doctor` name it
 * with its repair; every other command stays quiet about it, and no command acts on its value.
 */
export const dialogs: Section = {
  name: 'dialogs',
  owner: false,
  after: [],
  validate(entry, ctx) {
    // Any shape loads: the key is ignored, so refusing one would refuse a file the 0.4 line
    // wrote for a reason this build no longer reads. The one thing the section does is report
    // the deprecation, and `team check` and `team doctor` print that report.
    if (entry) {
      ctx.check.deprecations.push({
        line: entry.line,
        message: '`dialogs:` is deprecated and grants nothing',
        repair: 'remove dialogs: from {file}; trust answering is now an owner grant: team grant @team --capabilities dialogs.trust',
      });
    }
    return undefined;
  },
  schema: {
    deprecated: true,
    $comment: 'the 0.4 line\'s trust-dialog setting: read and ignored, and it grants nothing — trust answering is the owner\'s team grant',
  },
};

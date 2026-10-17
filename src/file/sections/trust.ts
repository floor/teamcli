import { homedir } from 'node:os';
import { absoluteTrustProblem, isLegacyTrustEntry, trustProblem } from '../paths.ts';
import type { Section } from './section.ts';

export const trust: Section = {
  name: 'trust',
  owner: true,
  after: [],
  validate(entry, ctx) {
    const trustItems = ctx.check.list(entry, 'trust');
    const hasLegacy = trustItems.some((item) => isLegacyTrustEntry(item.value));
    const hasAbsolute = trustItems.some((item) => !isLegacyTrustEntry(item.value));
    if (hasLegacy && hasAbsolute) {
      for (const item of trustItems) {
        ctx.check.fail(item.line, `trust: "${item.value}" cannot mix legacy patterns and absolute paths`);
      }
      return trustItems.map((item) => item.value);
    }
    if (hasLegacy) {
      for (const item of trustItems) {
        const problem = trustProblem(item.value);
        if (problem) ctx.check.fail(item.line, `trust: "${item.value}" ${problem}`);
      }
    } else if (hasAbsolute) {
      const home = ctx.home ?? homedir();
      for (const item of trustItems) {
        const problem = absoluteTrustProblem(item.value, home, ctx.fs, ctx.rootDir);
        if (problem) ctx.check.fail(item.line, `trust: "${item.value}" ${problem}`);
      }
    }
    return trustItems.map((item) => item.value);
  },
  schema: {
    type: 'array',
    items: { type: 'string', minLength: 1 },
    $comment: "absolute paths the seats may work in, including the team's lobby (the default ~/.config/team/lobby) and the project root",
  },
};

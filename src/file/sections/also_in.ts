import { PROJECT_NAME } from './in_project.ts';
import type { Section } from './section.ts';
import { valueOf } from './section.ts';

// Valid short names map to project ids by lowercasing and trimming trailing hyphens.
function projectKey(name: string): string {
  return name.toLowerCase().replace(/-+$/, '');
}

/** Additional projects the team serves. Only in_project supplies its home and inheritance. */
export const alsoIn: Section = {
  name: 'also_in',
  owner: false,
  after: ['in_project'],
  validate(entry, ctx) {
    if (entry === undefined) return [];
    const home = valueOf<string | null>(ctx, 'in_project');
    if (home === null) {
      ctx.check.fail(entry.line, 'also_in needs in_project: name the home project first');
    }
    if (entry.value.kind !== 'seq') {
      ctx.check.fail(entry.line, 'also_in must be a list of project names');
      return [];
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of ctx.check.list(entry, 'also_in')) {
      if (!PROJECT_NAME.test(item.value)) {
        ctx.check.fail(item.line, 'each project in also_in must be a short name: letters, digits, ".", "_" and "-", starting with a letter or a digit, 128 at most');
        continue;
      }
      const key = projectKey(item.value);
      if (home !== null && key === projectKey(home)) {
        ctx.check.fail(item.line, `also_in repeats the home project "${item.value}": keep it in in_project only`);
      } else if (seen.has(key)) {
        ctx.check.fail(item.line, `also_in names "${item.value}" twice`);
      }
      seen.add(key);
      out.push(item.value);
    }
    return out;
  },
  schema: {
    type: 'array',
    items: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
    },
    uniqueItems: true,
    $comment: 'additional projects this team serves; requires in_project and cannot repeat the home',
  },
};

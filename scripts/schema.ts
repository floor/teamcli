// The team file's JSON Schema, assembled from the `schema` fragment of each section module and
// checked in at schema/team.schema.json. The schema documents the shape the validator accepts so
// a person and an editor can read it; the validator stays what refuses a file, and checks what a
// shape cannot say (paths inside trust patterns, a seat that names a declared seat, and so on).
//
//   bun scripts/schema.ts           check: regenerate in memory and fail on any difference
//   bun scripts/schema.ts --write   write schema/team.schema.json
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECTIONS } from '../src/file/sections/index.ts';
import type { JsonSchema } from '../src/file/sections/section.ts';
import { COMMAND_OUTPUT_SCHEMAS, publishCommandOutputSchema } from '../src/output/schema.ts';

export const NAME = 'schema/team.schema.json';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = join(root, 'schema', 'team.schema.json');

// The fields the validator refuses to see missing: the format marker, the project, the operator
// and the seats. `required` is a shape of the whole file, not of one section, so it lives here;
// every field it names is refused by name in the section that reads it. The lead is required
// too, but by either of its two spellings — the `coordinator:` key or `leads: true` on one seat —
// and `required` can name only keys, so the loader holds that rule.
const REQUIRED = ['format', 'project', 'operator', 'seats', 'trust'];

/** The whole schema: one property per top-level key, in the order the sections run. */
export function buildSchema(): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const section of SECTIONS) {
    // `watch.checks` is a line inside `watch`, not a key of the file: its fragment is the checks
    // property of the watch fragment, and only top-level sections become properties here. The
    // property is the section's declared file key — the key the validator reads — not its
    // canonical name, which stays the digest's and the wave's.
    if (section.name.includes('.')) continue;
    properties[section.key ?? section.name] = section.schema;
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/floor/teamcli/blob/main/schema/team.schema.json',
    title: 'A team file',
    $comment: 'generated from the section modules by scripts/schema.ts: the validator is the source of truth',
    type: 'object',
    additionalProperties: false,
    required: REQUIRED,
    properties,
  };
}

export function renderSchema(): string {
  return `${JSON.stringify(buildSchema(), null, 2)}\n`;
}

// Where two versions of the file first disagree, for the check's message.
function firstDifference(current: string, wanted: string): string {
  const lines = current.split('\n');
  const wantedLines = wanted.split('\n');
  for (let index = 0; index < Math.max(lines.length, wantedLines.length); index++) {
    if (lines[index] !== wantedLines[index]) {
      const at = index + 1;
      return `line ${at}: the file has ${JSON.stringify(lines[index] ?? '<end of file>')}, the sections make ${JSON.stringify(wantedLines[index] ?? '<end of file>')}`;
    }
  }
  return 'the two differ';
}

if (import.meta.main) {
  const rendered = renderSchema();
  const writeMode = process.argv.includes('--write');
  if (writeMode) {
    writeFileSync(target, rendered);
    for (const spec of COMMAND_OUTPUT_SCHEMAS) {
      publishCommandOutputSchema(root, spec, 'write');
    }
    process.stdout.write(`schema: wrote ${NAME} and ${COMMAND_OUTPUT_SCHEMAS.length} output schema(s)\n`);
  } else if (!existsSync(target)) {
    process.stderr.write(`schema: ${NAME} is missing: run \`bun scripts/schema.ts --write\`\n`);
    process.exitCode = 1;
  } else {
    const current = readFileSync(target, 'utf8');
    if (current !== rendered) {
      process.stderr.write(`schema: ${NAME} is out of date with the section modules (${firstDifference(current, rendered)}): run \`bun scripts/schema.ts --write\`\n`);
      process.exitCode = 1;
    } else {
      for (const spec of COMMAND_OUTPUT_SCHEMAS) {
        const check = publishCommandOutputSchema(root, spec, 'check');
        if (!check.ok) {
          process.stderr.write(`schema: ${check.message}: run \`bun scripts/schema.ts --write\`\n`);
          process.exitCode = 1;
        }
      }
      if (!process.exitCode) {
        process.stdout.write(`schema: ${NAME} is current\n`);
      }
    }
  }
}


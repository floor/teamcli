// The lead path says "lead": the word "orchestrator" survives in the source only as the
// canonical section name, the team file's field and the client protocol vocabulary, none of
// which this test reaches. The modules below are the ones that resolve, name or admit the lead;
// in them the old role word must not survive in a string literal. The one exemption is the
// section's own `name:`, which approval digests and the schema read: renaming it would move
// every record's bucket, so the canonical spelling stays.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { devModeOwnerRoleOf } from '../src/dev_mode.ts';
import type { TeamFile } from '../src/file/types.ts';

/** The modules on the lead path: the chain, the team file's word, and the dev-mode admission. */
const LEAD_PATH = [
  'src/lead.ts',
  'src/lead-chain.ts',
  'src/file/sections/lead.ts',
  'src/file/sections/orchestrator.ts',
  'src/dev_mode.ts',
];

/** The canonical section name, the only quoted spelling the lead path keeps. */
const CANONICAL = "name: 'orchestrator',";

const ROLE_WORD = /'orchestrator'|"orchestrator"/;

function hits(file: string): string[] {
  const text = readFileSync(join(import.meta.dir, '..', file), 'utf8');
  const found: string[] = [];
  text.split('\n').forEach((line, at) => {
    if (ROLE_WORD.test(line) && line.trim() !== CANONICAL) found.push(`${file}:${at + 1}: ${line.trim()}`);
  });
  return found;
}

describe('the lead path is spelled lead', () => {
  test('no module on the lead path spells the role "orchestrator"', () => {
    const found = LEAD_PATH.flatMap(hits);
    expect(found.join('\n')).toBe('');
  });

  test('the canonical section name is the one exemption, and it stays', () => {
    const canonical = readFileSync(join(import.meta.dir, '..', 'src/file/sections/orchestrator.ts'), 'utf8');
    expect(canonical).toContain(CANONICAL);
  });

  test('the dev-mode role a lead seat holds is `lead`', () => {
    const team = { orchestrator: 'seat-a', operator: 'seat-b' } as unknown as TeamFile;
    expect(devModeOwnerRoleOf('seat-a', team)).toBe('lead');
    expect(devModeOwnerRoleOf('seat-b', team)).toBe('operator');
    expect(devModeOwnerRoleOf('seat-c', team)).toBeNull();
  });
});

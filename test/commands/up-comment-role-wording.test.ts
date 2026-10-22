// The terminal host's name stays out of this command's prose. A milestone review measured three
// residual comment sites that still name it: the close reading above `seatProcessVerdict`, the
// unblocking command's doc comment, and the no-create-grant comment above the detached refusal.
// Each check reads the comment block directly above its site and requires the host's name to be
// gone from that prose. Identifiers, refusal ids, imports and the host's own message vocabulary
// are outside these checks: prose role wording is the contract here, not the host's spelling.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../../src/commands/up.ts', import.meta.url), 'utf8');
const HOST_NAME = 'herdr';

/** The contiguous comment block directly above the line carrying `anchor`. Throws when the site
 *  or its comment is gone, so the check cannot pass vacuously on a moved or deleted site. */
function commentAbove(anchor: string): string {
  const rows = SOURCE.split('\n');
  const at = rows.findIndex((row) => row.includes(anchor));
  if (at < 0) throw new Error(`the command no longer carries the ${anchor} site`);
  const block: string[] = [];
  for (let i = at - 1; i >= 0; i -= 1) {
    const row = rows[i] ?? '';
    if (/^\s*(?:\/\/|\/\*|\*)/u.test(row)) {
      block.unshift(row);
      continue;
    }
    break;
  }
  if (block.length === 0) throw new Error(`the ${anchor} site carries no comment above it`);
  return block.join('\n');
}

describe("the terminal host stays out of up's prose", () => {
  test('the close reading names its host by role', () => {
    expect(commentAbove('const verdict = seatProcessVerdict(')).not.toContain(HOST_NAME);
  });

  test('the unblocking command comment names its host by role', () => {
    expect(commentAbove('function unblockingUpRun(')).not.toContain(HOST_NAME);
  });

  test('the detached reading comment names its caller by role', () => {
    expect(commentAbove('if (detached !== undefined && !createGranted)')).not.toContain(HOST_NAME);
  });
});

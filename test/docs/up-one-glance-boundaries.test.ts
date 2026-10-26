// The one-glance cut of the `team up` page at its boundaries. The cut moved the page's example
// and its rationale off the page; nothing executes or even reads what moved — docs.test.ts walks
// docs/commands/ alone — so these pins hold: the promises the old intro made survive the
// condensed one, the page's single refusal scene quotes the binary word for word, the shape stays
// one glance (no example block creeps back), and the moved example stays whole where it landed.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUp, type UpSources } from '../../src/commands/up.ts';
import { testIo } from '../helpers.ts';

const PAGE = '../../docs/internal/commands/up.md';
const INTERNAL = '../../docs/internal/up.md';
const NOW = new Date('2026-10-15T05:00:00.000Z');

// The placement promise: which seats start where. The old intro said it in two sentences, the
// condensed one in a clause — either way the promise itself may not be softened or dropped.
const PLACEMENT =
  "A fresh launch of the orchestrator or the operator starts in the project folder; every other seat starts in the team's lobby.";

// The no-touch promise: a seat already there is left alone. The old page made it three claims
// (not closed, not moved, nothing typed); the cut folds them into one clause that must keep all
// three verbs.
const NO_TOUCH = 'its pane is not closed, moved or typed into';

// The one claim that survives about the sidebar: rewritten from the file either way.
const SIDEBAR = 'its sidebar is rewritten from the file either way';

// Whitespace runs collapse before the match, so the sentences survive line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function raw(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

describe('the one-glance cut of the up page', () => {
  test('the condensed intro keeps the promises the old page made, verbatim', () => {
    const page = prose(PAGE);
    expect(page.includes(PLACEMENT), 'up.md lost the placement promise').toBe(true);
    expect(page.includes(NO_TOUCH), 'up.md lost the no-touch promise').toBe(true);
    expect(page.includes(SIDEBAR), 'up.md lost the sidebar promise').toBe(true);
  });

  // The public page's shape is now the human template's, pinned in
  // test/docs/human-command-pages.test.ts; the full reference these pins read is
  // docs/internal/commands/up.md.

  test('the page’s refusal scene quotes the binary word for word', async () => {
    // The scene is the page's only example, and docs.test.ts executes it against fakes — but a
    // fixture can drift as quietly as prose. Here the quoted sentence is taken from the page and
    // required to be the real refusal the command prints for that caller, so the two cannot part.
    // The scene carries a second invocation, the dry run, whose lines name the reason itself.
    const page = raw(PAGE);
    const scene = page.match(/\n\$ (team up[^\n]*)\n([^\n]+)\nexit 1\n/);
    expect(scene, 'up.md lost its refusal scene').not.toBeNull();
    const invoked = scene![1]!;
    const quoted = scene![2]!.trim();
    expect(invoked, 'up.md changed the refusal scene\'s invocation').toBe('team up --file other.yaml ; echo "exit $?"');

    base = realpathSync(mkdtempSync(join(tmpdir(), 'up-one-glance-')));
    const root = join(base, 'acme');
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    const io = testIo(root, {
      kind: 'unplaced',
      reason: 'it is run by an agent (claude) outside herdr',
    });
    const sources: UpSources = {
      sessionRunning: () => false,
      agents: () => [],
      home: join(base, 'home'),
    };
    const code = await runUp(['--file', 'other.yaml'], io, sources);
    expect(code).toBe(1);
    expect(io.err.includes(quoted), `the page's scene no longer matches the binary:\n  page: ${quoted}\n  real: ${io.err.trim()}`).toBe(true);
  });

  test('the example that moved off the page stayed whole where it landed', () => {
    // The moved example is the only record of the skipped-seat shapes, and nothing executes it.
    // These are the binary's own strings (plan.ts builds them), so the page that moved them owes
    // them whole: the fixture, both register notes, the stopped seat, and the seat-caller refusal.
    const internal = prose(INTERNAL);
    expect(internal.includes('agents: [claude-keeper, claude-beacon]'), 'internal/up.md lost the fixture line').toBe(true);
    expect(internal.includes('name: gemini-qa'), 'internal/up.md lost the stopped seat').toBe(true);
    expect(internal.includes('stopped: true'), 'internal/up.md lost the stopped marker').toBe(true);
    expect(
      internal.includes(
        'already ready; left as it is; its process was never recorded: run team register claude-keeper to record it, nothing relaunched',
      ),
      'internal/up.md lost the lead register note',
    ).toBe(true);
    expect(
      internal.includes(
        'already ready; left as it is; its process was never recorded: run team register claude-beacon to record it, nothing relaunched',
      ),
      'internal/up.md lost the implementer register note',
    ).toBe(true);
    expect(
      internal.includes('skip gemini-qa: stopped in the file; start it with `team add gemini-qa`'),
      'internal/up.md lost the stopped skip line',
    ).toBe(true);
    expect(internal.includes('dry run: nothing was run'), 'internal/up.md lost the dry-run line').toBe(true);
    expect(internal.includes('this call is claude-beacon'), 'internal/up.md lost the seat-caller refusal').toBe(true);
  });
});

// The Jules TUI shows the owner's whole account, and its `ctrl+d` deletes a session for
// everyone — a seat's own included. No profile path may send that key: the profile exits by
// `ctrl+c` alone, its delivery types through `jules-compose.ts`, and neither may spell the
// delete. This file holds the profile to that, and holds the one standing rule the CLI makes
// necessary — "Never delete a Jules session." — in the text every jules seat receives.
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { rulesText } from '../src/launch/rules.ts';
import { profileFor } from '../src/profiles/index.ts';

const ROOT = join(import.meta.dir, '..');

/** Every `.ts` file under a directory, walked with its own names. */
function tsFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...tsFiles(path));
    else if (name.endsWith('.ts')) found.push(path);
  }
  return found;
}

/** The shipped profiles, as the loader the launch path uses reads them. */
function shippedNames(): string[] {
  return readdirSync(join(ROOT, 'src', 'profiles'))
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => name.replace(/\.yaml$/, ''));
}

/** A key as any path would spell it: a quoted string. A comment that quotes the footer is not
 *  a key press, and is not written with quotes around the key alone. */
const QUOTED_DELETE = /['"`]ctrl\+(?:d|D)['"`]|['"`]ctrl-(?:d|D)['"`]/;

describe('no profile path sends the Jules delete key', () => {
  test('no shipped profile names ctrl+d among the keys it sends', () => {
    const named: string[] = [];
    for (const name of shippedNames()) {
      const profile = profileFor(name);
      if (profile === null) throw new Error(`profile ${name} did not load`);
      for (const key of [...profile.exitKeys, ...(profile.exitClear === null ? [] : [profile.exitClear]), ...(profile.exitConfirm === null ? [] : [profile.exitConfirm])]) {
        if (/^ctrl[+-]d$/i.test(key)) named.push(`${name}: ${key}`);
      }
    }
    expect(named).toEqual([]);
  });

  test('the schema admits only ctrl+c as an exit key', () => {
    const schema = JSON.parse(readFileSync(join(ROOT, 'src', 'profiles', 'profile.schema.json'), 'utf8')) as {
      properties: { exit_keys: { items: { enum: string[] } } };
    };
    expect(schema.properties.exit_keys.items.enum).toEqual(['ctrl+c']);
  });

  test('no shipped source spells the delete key as a key', () => {
    // A key press is a quoted string, so any file that could send one would carry the spelling.
    // Command construction, the arm of a screen module, and a future path all read the same.
    const offenders = tsFiles(join(ROOT, 'src'))
      .filter((file) => QUOTED_DELETE.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });

  test('jules exits by ctrl+c alone, and carries the standing rule', () => {
    const jules = profileFor('jules');
    if (jules === null) throw new Error('the jules profile did not load');
    expect(jules.exit).toBeNull();
    expect(jules.exitKeys).toEqual(['ctrl+c']);
    expect(jules.standingRules).toEqual(['Never delete a Jules session.']);
  });
});

describe('the standing rule rides a jules seat\'s every brief', () => {
  test('the prepended text carries it between the profile\'s own rules and the file\'s', () => {
    const jules = profileFor('jules');
    if (jules === null) throw new Error('the jules profile did not load');
    const text = rulesText(
      {
        orchestrator: 'orchestrator',
        rules: ['Keep every change on a branch.'],
        profileRules: jules.standingRules,
        signature: {
          commit: 'Agent: Sample Model · builder',
          pullRequest: '**Agent:** Sample Model · builder',
          commitPosition: 'trailer',
        },
        workspace: { mode: 'worktree', protected: ['.'] },
      },
      'prepend',
    );
    const lines = text.split('\n');
    const rule = lines.indexOf('- Never delete a Jules session.');
    const fileRule = lines.indexOf('- Keep every change on a branch.');
    expect(rule).toBeGreaterThan(0);
    expect(fileRule).toBeGreaterThan(rule);
    expect(text.endsWith('These are standing rules for this session. The brief follows.')).toBe(true);
  });

  test('a profile with no standing rules adds none', () => {
    const codex = profileFor('codex');
    if (codex === null) throw new Error('the codex profile did not load');
    expect(codex.standingRules).toEqual([]);
  });
});

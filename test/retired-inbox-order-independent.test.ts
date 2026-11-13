// A delivery order that names only the retired inbox word is the mailbox. The seat gets a
// drop and nothing is typed. A word that also names typed keeps typed. A seat that names
// no order still falls back to typed, then drop.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import type { ProjectSources } from '../src/commands/projects.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { MESSAGE_ID } from '../src/mcp/inbox.ts';
import { deliveryChainOf } from '../src/send/delivery.ts';
import { readHistory } from '../src/send/history.ts';
import { deliveryOrder } from '../src/settings/resolve.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-06T16:30:00Z');
const SESSION = 'scratch';

let scratch = '';

afterEach(() => {
  if (scratch !== '') discardFixtures([scratch], { roots: [dirname(scratch)] });
  scratch = '';
});

function teamText(root: string, order: string | undefined): string {
  const line = order === undefined ? '' : `    delivery_order: [${order}]\n`;
  return `format: 1
project: acme
session: ${SESSION}
coordinator: guide
operator: guide
workspace:
  mode: shared
  base: main
trust:
  - ${lobbyDir(join(root, '..', 'home'))}
  - ${root}
seats:
  - role: coordinator
    name: guide
    label: guide
    cli: claude-code
    vendor: example
    model: Example
    version: "1"
    launch: claude
${line}`;
}

function prepare(order: string | undefined): { root: string; home: string; sockets: string } {
  scratch = fixtureBase('retired-inbox-');
  const home = join(scratch, 'home');
  const root = join(scratch, 'repo');
  const sockets = join(scratch, 'sockets');
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(sockets, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q'], {
    cwd: root,
    env: gitEnv(),
    stdio: 'ignore',
  });
  const text = teamText(root, order);
  writeFileSync(join(root, '.agents', 'team.yaml'), text, { mode: 0o600 });
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return { root, home, sockets };
}

const projects: ProjectSources = {
  list: () => [],
  byName: () => null,
  ofTeam: () => null,
};

function hostOf(home: string, sockets: string): SendHost & { typed: string[] } {
  const typed: string[] = [];
  return {
    typed,
    agents: () => [{ name: 'guide', pane: 'fixture-pane-one', cli: 'claude' }],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: sockets,
    deliver: async () => {
      throw new Error('the socket was dialed');
    },
    native: {
      typeText: (_session, _pane, text) => {
        typed.push(text);
        return true;
      },
      pressEnter: () => true,
      status: () => 'idle',
      wait: async () => {},
      paneText: () => '',
    },
    now: () => NOW,
    home,
    projects,
  };
}

function orderOf(root: string, home: string): readonly string[] {
  return deliveryOrder(deliveryChainOf({
    root,
    seat: 'guide',
    home,
    projectOfTeam: () => null,
  }));
}

function dropNames(root: string): string[] {
  const dir = join(root, '.agents', 'send-drops', SESSION, 'guide');
  try {
    return readdirSync(dir).filter((name) => MESSAGE_ID.test(name));
  } catch {
    return [];
  }
}

function deliveryLegs(out: string): string[] {
  const doc = JSON.parse(out) as { delivery?: { leg: string }[] };
  return (doc.delivery ?? []).map((row) => row.leg);
}

function lastSend(root: string, home: string): { via?: string; failed?: string[] } {
  const history = readHistory('acme', root, home);
  expect(history.ok).toBe(true);
  if (!history.ok) return {};
  return history.entries.at(-1) ?? {};
}

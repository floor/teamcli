// E7b revision 3, stage D: the body-write inventory. A stamped body may only be written into a
// container level-2 code never reads, and each container is chosen by one era-aware function
// (src/queue/mail-tree.ts `recordFolderFor`, or the carrier's own stamped container). This scan
// holds the source to that: every path to a mail tree is built in mail-tree.ts, every write into a
// mail folder is a classified site, every stamping site is known, every relay copy passes the era
// wrapper, and every delivery leg that hands a body over numbers its copy. A new site fails here
// until it is classified, with its reason.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO = join(import.meta.dir, '..');
const SRC = join(REPO, 'src');

function sources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const at = join(dir, name);
      if (statSync(at).isDirectory()) walk(at);
      else if (name.endsWith('.ts')) out.push({ path: relative(REPO, at), text: readFileSync(at, 'utf8') });
    }
  };
  walk(SRC);
  return out;
}

const files = sources();
const byPath = new Map(files.map((file) => [file.path, file.text]));

/** The code of a file with its comments removed (line and block comments), strings kept. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => (/^\s*\/\//.test(line) ? '' : line)).join('\n');
}

/** Each call site of `name(` in code, as `path` → count. */
function sitesOf(name: string): Record<string, number> {
  const out: Record<string, number> = {};
  const call = new RegExp(`(?<![\\w.]|function )${name}\\(`, 'g');
  for (const file of files) {
    const n = (code(file.text).match(call) ?? []).length;
    if (n > 0) out[file.path] = n;
  }
  return out;
}

describe('revision 3: the body-write inventory', () => {
  test('every path to a mail tree is built in src/queue/mail-tree.ts', () => {
    const literal = /(['"`])send-(drops|stamped)\1|['"`/]send-(drops|stamped)\//;
    const found: Record<string, number> = {};
    for (const file of files) {
      if (file.path === 'src/queue/mail-tree.ts') continue;
      for (const line of code(file.text).split('\n')) {
        // The daemon request kind is a word, not a path.
        if (literal.test(line) && !/'send-stamped'/.test(line)) found[file.path] = (found[file.path] ?? 0) + 1;
      }
    }
    // Each remaining hit, with its reason.
    expect(found).toEqual({
      // `team drops --help` text: prose, not a path the code opens.
      'src/commands/drops.ts': 1,
      // The older drop-retention store's own manifest prefix: that mover reads the legacy tree only.
      'src/send/drop-retention.ts': 2,
    });
  });

  test('every write into a mail folder (dropMessage) is a classified site', () => {
    expect(sitesOf('dropMessage')).toEqual({
      // The record writers: the folder comes from recordFolderFor, or the sidecar sits beside the
      // record it settles (besideRecord), in the record's own tree.
      'src/send/record.ts': 4,
      // Body-carrying markers: in the seat folder of the record's own tree (seatFolderOf).
      'src/send/pending.ts': 1,
      'src/send/taken.ts': 1,
      // A draft copy beside the drop file it belongs to (dirname of the record's own path).
      'src/send/deliver.ts': 1,
      // Unstamped runtime records only (signed without stampedPayload): the lead notice, the
      // lead-blocked and unread reports, the watch's work prompt.
      'src/send/endpoint-notice.ts': 1,
      'src/watch/unread.ts': 3,
      'src/commands/watch.ts': 1,
      // Seat-identity and body-free bookkeeping: the listener marker, the wake mark, the fallback
      // facts, a restart's draft of its own launch line.
      'src/mcp/inbox.ts': 1,
      'src/send/wake-marker.ts': 1,
      'src/send/fallback-events.ts': 3,
      'src/commands/restart.ts': 1,
    });
  });

  test('a record is stamped only where its writer takes the folder from its era', () => {
    expect(Object.keys(sitesOf('stampedPayload')).sort()).toEqual([
      'src/client/send.ts', // an external client's record: stampedPayload never stamps it
      'src/commands/reply.ts', // written through writeRecord
      'src/commands/send.ts', // staged through writeSendRecord and the relay wrappers
      'src/watch/native.ts', // written through ensureRecord, then writeRecord
    ]);
    // The unstamped-only writers above never stamp.
    for (const path of ['src/send/endpoint-notice.ts', 'src/watch/unread.ts', 'src/commands/watch.ts']) {
      expect(code(byPath.get(path) as string)).not.toContain('stampedPayload(');
    }
  });

  test('every record writer and relay copy takes its folder from the one era-aware function', () => {
    const record = code(byPath.get('src/send/record.ts') as string);
    for (const fn of ['writeRecord', 'writeRecordOver']) {
      const body = record.slice(record.indexOf(`export function ${fn}(`), record.indexOf('\n}\n', record.indexOf(`export function ${fn}(`)));
      expect(body).toContain('recordFolderFor(');
    }
    const relay = code(byPath.get('src/send/relay-stage.ts') as string);
    expect(relay).toContain('recordFolderFor(');
    // No module but the wrappers calls the relay package's acting functions.
    const importers = files.filter((file) => file.path !== 'src/send/relay-stage.ts'
      && /import\s*\{[^}]*\b(stage|deliver)\b[^}]*\}\s*from\s*'[./]*packages\/relay\/index\.js'/.test(code(file.text)));
    expect(importers.map((file) => file.path)).toEqual([]);
  });

  test('the four other carriers keep their stamped containers', () => {
    const pending = code(byPath.get('src/send/pending.ts') as string);
    expect(pending).toMatch(/if \(stamped\) \{\s*\n[^\n]*\n\s*dir = nativePendingDir\(root\);/);
    // Carrier 2 is deleted: a stamped send never dials the daemon, and the daemon has no stamped kind.
    expect(code(byPath.get('src/commands/send.ts') as string)).toContain('const dialled = !isStampedPayload(record) && existsSync(daemonSock)');
    expect(code(byPath.get('src/send/daemon.ts') as string)).not.toContain('send-stamped');
    const history = code(byPath.get('src/send/history.ts') as string);
    expect(history).toContain("floorState(root, home).kind !== 'dark'");
    const outbox = code(byPath.get('src/send/confined-outbox.ts') as string);
    expect(outbox).toContain('outboxFolder(input.dir, input.session, input.seat, OUTBOX_PROTOCOL)');
  });

  test('every delivery leg that hands a stamped body over numbers its copy', () => {
    // The legs: the channel push, the inbox read, the typed wake, the socket frame and the daemon's
    // handoff. Each one that reads a body for a stamped record takes a copy number.
    for (const path of ['src/mcp/serve.ts', 'src/mcp/inbox.ts', 'src/send/readable-wake.ts', 'src/commands/send.ts']) {
      expect(code(byPath.get(path) as string)).toMatch(/takeCopyNumber\(|wrapCopy\(/);
    }
  });

  test('the Claude adapter offer token is minted, kept and read only inside the comms boundary', () => {
    // Minted by the channel server alone, for the push it writes.
    expect(sitesOf('newOfferToken')).toEqual({ 'src/mcp/serve.ts': 1 });
    // The history entries that hold it are read by the offer module alone: no reader, pointer,
    // hook or status line opens them.
    expect(Object.keys(sitesOf('offeredCopies')).sort()).toEqual(['src/comms/offer.ts']);
    // The token-ack log is read only through the offer module.
    const logReaders = files.filter((file) => file.path !== 'src/comms/offer.ts' && code(file.text).includes('OFFER_ACKS'));
    expect(logReaders.map((file) => file.path)).toEqual([]);
  });
});

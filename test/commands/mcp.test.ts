// `team mcp status` and `team mcp doctor`: fixtures only. Every path, socket, HTTP answer and
// certificate here is synthetic; the fake sources stand in for the machine so no test touches a
// live bridge, and the two secret-shaped values below are literals invented for the fixtures —
// the point of several tests is that they never reach the output.
import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  bridgeProcessPattern,
  parseAuditTail,
  parseBridgeConfig,
  parseGuardConfig,
  runMcp,
  USAGE,
  type McpSources,
  type PathKind,
  type PathStat,
} from '../../src/commands/mcp.ts';
import { testIo } from '../helpers.ts';

const HOME = '/fake/home';
const LOBBY = `${HOME}/.config/team/lobby`;
const HELPER = '/fake/helper';
const BRIDGE_DIR = `${LOBBY}/bridge-810`;
const CONFIG = `${BRIDGE_DIR}/bridge.json`;
const SOCK = `${HELPER}/sock/signer.sock`;
const MAILBOX = `${BRIDGE_DIR}/mailbox`;
const AUDIT = `${BRIDGE_DIR}/audit.jsonl`;
const GUARD_DIR = `${LOBBY}/desk-810`;
const NEXT_YEAR = '2027-01-07T20:53:15.000Z';

// The two secret-shaped fixture values: 32 zero-free bytes in base64url (43 characters), the
// shape `loadBridgeConfig` demands. No output may ever hold them.
const CONNECTOR_TOKEN = Buffer.alloc(32, 3).toString('base64url');
const QUEUE_HMAC_KEY = Buffer.alloc(32, 9).toString('base64url');
const PUBLIC_PEM = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
const PRIVATE_KEY_TEXT = '-----BEGIN PRIVATE KEY-----\nnot a real key\n-----END PRIVATE KEY-----\n';

function bridgeConfigText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    wss_url: 'wss://bridge.example.test/connector',
    connector_token: CONNECTOR_TOKEN,
    queue_hmac_key: QUEUE_HMAC_KEY,
    relay_public_keys: { 'relay-1': PUBLIC_PEM },
    seats: [{ alias: 'desk', route: 'seat-desk-1', key_id: 'seat-desk-1', public_key: PUBLIC_PEM }],
    signer_socket: SOCK,
    mailbox_dir: MAILBOX,
    audit_file: AUDIT,
    ...overrides,
  }, null, 2);
}

interface Entry { kind: PathKind; mode: number; size: number }

/** The stand-in machine: an entry table (kind, mode, size), file texts, folder listings, socket
 *  answers, HTTP answers keyed by `<upgrade>|<url>`, one certificate, and one process answer. */
class Fake {
  entries = new Map<string, Entry>();
  texts = new Map<string, string>();
  listing = new Map<string, string[]>();
  sockets = new Map<string, 'ok' | 'refused' | 'missing'>();
  http = new Map<string, number | null>();
  probed: Array<{ url: string; upgrade: boolean }> = [];
  patterns: string[] = [];
  cert: { validTo: string; authorized: boolean } | null = null;
  process: boolean | null = false;
  nowDate = new Date('2026-10-10T12:00:00Z');

  dir(path: string, mode = 0o700): this {
    this.entries.set(path, { kind: 'dir', mode, size: 0 });
    return this;
  }

  file(path: string, text: string, mode = 0o600): this {
    this.entries.set(path, { kind: 'file', mode, size: Buffer.byteLength(text) });
    this.texts.set(path, text);
    return this;
  }

  socket(path: string, mode = 0o660, answer: 'ok' | 'refused' | 'missing' = 'ok'): this {
    this.entries.set(path, { kind: 'socket', mode, size: 0 });
    this.sockets.set(path, answer);
    return this;
  }

  list(path: string, names: string[]): this {
    this.listing.set(path, [...names].sort());
    return this;
  }

  sources(): McpSources {
    return {
      home: () => HOME,
      helperRoot: () => HELPER,
      now: () => this.nowDate,
      listDir: (path) => this.listing.get(path) ?? null,
      stat: (path): PathStat | null => {
        const entry = this.entries.get(path);
        return entry ? { ...entry } : null;
      },
      readText: (path, maxBytes) => {
        const entry = this.entries.get(path);
        const text = this.texts.get(path);
        return entry && entry.kind === 'file' && entry.size <= maxBytes && text !== undefined ? text : null;
      },
      readTail: (path, maxBytes) => {
        const entry = this.entries.get(path);
        const text = this.texts.get(path);
        return entry && entry.kind === 'file' && entry.size <= maxBytes && text !== undefined ? text : null;
      },
      countSuffix: (dir, suffix) => {
        const names = this.listing.get(dir);
        return names === undefined ? null : names.filter((name) => name.endsWith(suffix)).length;
      },
      probeSocket: (path) => Promise.resolve(this.sockets.get(path) ?? 'missing'),
      probeHttp: (url, upgrade) => {
        this.probed.push({ url, upgrade });
        return Promise.resolve(this.http.get(`${upgrade ? 'up' : 'plain'}|${url}`) ?? null);
      },
      certExpiry: () => Promise.resolve(this.cert),
      processRunning: (pattern) => {
        this.patterns.push(pattern);
        return this.process;
      },
    };
  }

  /** The happy lobby: helper folders, one bridge whose every leg answers, the guard pair, the
   *  front's 401+401 and a certificate good for a year. Tests then break one leg each. */
  full(): this {
    this
      .dir(HELPER, 0o755)
      .dir(`${HELPER}/keys`)
      .dir(`${HELPER}/queue`)
      .dir(`${HELPER}/state`)
      .dir(`${HELPER}/sock`, 0o770)
      .file(`${HELPER}/bin/bun`, '#!/bin/sh\n', 0o755)
      .file(`${HELPER}/app/src/connector/bridge-main.ts`, '// the bridge\n', 0o644)
      .file(`${HELPER}/helper-config.json`, '{"version":1}', 0o600)
      .socket(SOCK, 0o660, 'ok')
      .dir(BRIDGE_DIR)
      .file(CONFIG, bridgeConfigText())
      .dir(MAILBOX)
      .list(`${MAILBOX}/outbound`, ['one.ready', 'two.ready', 'stale.taken'])
      .list(`${MAILBOX}/inbound`, ['reply.ready'])
      .file(AUDIT, '{"ts":"2026-10-10T19:16:21.121Z","event":"late_reply"}\n{"ts":"2026-10-10T19:16:27.000Z","event":"ws-open"}\n')
      .dir(GUARD_DIR)
      .file(`${GUARD_DIR}/guard.json`, JSON.stringify({
        version: 1, target_alias: 'seat-desk-1', enabled: true,
        public_keys: { 'relay-1': PUBLIC_PEM },
        replay_db: `${GUARD_DIR}/replay.db`, audit_file: `${GUARD_DIR}/audit.jsonl`,
      }, null, 2))
      .file(`${GUARD_DIR}/replay.db`, '', 0o600)
      .file(`${GUARD_DIR}/audit.jsonl`, '{"ts":"2026-10-10T19:16:28.000Z","event":"accepted"}\n')
      .file(`${GUARD_DIR}/seat-reply-config.json`, JSON.stringify({
        version: 1, seat_alias: 'seat-desk-1', key_id: 'seat-desk-1',
        key_file: `${GUARD_DIR}/seat-desk-1.private.pem`, replay_db: `${GUARD_DIR}/replay.db`,
        answer_dir: `${GUARD_DIR}/answers`,
      }, null, 2))
      .dir(`${GUARD_DIR}/answers`)
      .list(LOBBY, ['bridge-810', 'desk-810']);
    this.http.set('up|https://bridge.example.test/connector', 401);
    this.http.set('plain|https://bridge.example.test/mcp', 401);
    this.cert = { validTo: NEXT_YEAR, authorized: true };
    return this;
  }
}

async function run(args: string[], fake: Fake) {
  const io = testIo('/fake');
  const rc = await runMcp(args, io, fake.sources());
  return { rc, out: io.out, err: io.err };
}

describe('team mcp status', () => {
  test('reports every leg up, exit 0, secrets never printed', async () => {
    const fake = new Fake().full();
    fake.process = true;
    const { rc, out } = await run(['status'], fake);
    expect(rc).toBe(0);
    expect(out).toContain('state: up');
    expect(out).toContain('desk -> seat-desk-1');
    expect(out).toContain('running');
    expect(out).toContain('401, OAuth required');
    expect(out).not.toContain(CONNECTOR_TOKEN);
    expect(out).not.toContain(QUEUE_HMAC_KEY);
    // The process check is pinned to this config, not to any bridge.
    expect(fake.patterns).toEqual([bridgeProcessPattern(CONFIG)]);
    expect(fake.patterns[0]).toContain(CONFIG.replace(/\./g, '\\.'));
  });

  test('--json: format 1, every leg and the front in the document', async () => {
    const fake = new Fake().full();
    fake.process = true;
    const { rc, out } = await run(['status', '--json'], fake);
    expect(rc).toBe(0);
    const doc = JSON.parse(out);
    expect(doc.format).toBe(1);
    expect(doc.lobby_dir).toBe(LOBBY);
    expect(doc.state).toBe('up');
    expect(doc.bridges).toHaveLength(1);
    expect(doc.bridges[0]).toMatchObject({
      dir: BRIDGE_DIR,
      config: 'ok',
      wss_url: 'wss://bridge.example.test/connector',
      bridge_process: 'up',
      signer_socket: { path: SOCK, state: 'ok' },
      mailbox: { outbound_ready: 2, inbound_ready: 1 },
      seats: [{ alias: 'desk', route: 'seat-desk-1', key_id: 'seat-desk-1' }],
      audit: { path: AUDIT, last: { event: 'ws-open' } },
    });
    expect(doc.front).toMatchObject({ origin: 'https://bridge.example.test', mcp_status: 401, connector_status: 401 });
    expect(doc.guards[0]).toMatchObject({ config: 'ok', enabled: true });
    expect(out).not.toContain(CONNECTOR_TOKEN);
  });

  test('one leg down: exit 1, the row and the document say which', async () => {
    const fake = new Fake().full();
    fake.process = false;
    fake.sockets.set(SOCK, 'refused');
    fake.http.set('up|https://bridge.example.test/connector', 404);
    const { rc, out } = await run(['status', '--json'], fake);
    expect(rc).toBe(1);
    const doc = JSON.parse(out);
    expect(doc.state).toBe('down');
    expect(doc.bridges[0].bridge_process).toBe('down');
    expect(doc.bridges[0].signer_socket.state).toBe('refused');
    expect(doc.front.connector_status).toBe(404);
  });

  test('not set up: exit 1, state not-set-up, empty bridges', async () => {
    const fake = new Fake();
    fake.dir(LOBBY, 0o700).list(LOBBY, []);
    const plain = await run(['status'], fake);
    expect(plain.rc).toBe(1);
    expect(plain.out).toContain('state: not-set-up');
    expect(plain.out).toContain('no bridge configuration');
    const json = await run(['status', '--json'], fake);
    const doc = JSON.parse(json.out);
    expect(doc.state).toBe('not-set-up');
    expect(doc.bridges).toEqual([]);
    expect(doc.front).toEqual({ origin: null, mcp_status: null, connector_status: null, tls_valid_to: null, tls_authorized: null });
  });

  test('a bridge the loader would refuse reads as a config problem, not a crash', async () => {
    const fake = new Fake().full();
    fake.process = true;
    fake.file(CONFIG, bridgeConfigText({ connector_token: 'too-short' }));
    const { rc, out } = await run(['status', '--json'], fake);
    expect(rc).toBe(1);
    const doc = JSON.parse(out);
    expect(doc.bridges[0].config).toBe('invalid');
    expect(doc.bridges[0].problem).toContain('connector_token');
    expect(doc.state).toBe('down');
  });
});

describe('team mcp doctor', () => {
  test('nothing missing: exit 0, every fix slot empty', async () => {
    const fake = new Fake().full();
    fake.process = true;
    const { rc, out } = await run(['doctor'], fake);
    expect(rc).toBe(0);
    expect(out).toContain('nothing missing');
    const json = await run(['doctor', '--json'], fake);
    const doc = JSON.parse(json.out);
    expect(doc.format).toBe(1);
    expect(doc.missing).toBe(0);
    expect(doc.warnings).toBe(0);
    for (const finding of doc.findings) {
      if (finding.level === 'ok') expect(finding.fix).toBeNull();
    }
  });

  test('finds each broken leg with its one-line fix, owner-gated where it must be', async () => {
    const fake = new Fake().full();
    fake.process = false;
    fake.http.set('up|https://bridge.example.test/connector', 404);
    fake.cert = { validTo: new Date(fake.nowDate.getTime() + 3 * 86_400_000).toISOString(), authorized: true };
    fake.file(`${GUARD_DIR}/guard.json`, PRIVATE_KEY_TEXT);
    const { rc, out } = await run(['doctor'], fake);
    expect(rc).toBe(1);
    expect(out).toContain('MISS');
    expect(out).toContain('fix: start it: bun');
    expect(out).toContain('TEAMCLI_CONNECTOR_ENABLED=1');
    expect(out).toContain('fix: [owner] renew the front certificate');
    expect(out).toContain('private key material');
    expect(out).toContain('fix: [owner]');
    expect(out).not.toContain(PRIVATE_KEY_TEXT.split('\n')[0]! + '\nnot a real key');
    const json = await run(['doctor', '--json'], fake);
    const doc = JSON.parse(json.out);
    expect(doc.missing).toBeGreaterThanOrEqual(4);
    const missingTexts = doc.findings.filter((finding: { level: string }) => finding.level === 'miss').map((finding: { text: string }) => finding.text);
    expect(missingTexts.some((text: string) => text.includes('the bridge is not running'))).toBe(true);
    expect(missingTexts.some((text: string) => text.includes('private key material'))).toBe(true);
  });

  test('a fresh machine: the not-set-up finding carries the owner-gated pointer', async () => {
    const fake = new Fake();
    fake.dir(LOBBY, 0o700).list(LOBBY, []);
    const { rc, out } = await run(['doctor', '--json'], fake);
    expect(rc).toBe(1);
    const doc = JSON.parse(out);
    const noBridge = doc.findings.find((finding: { text: string }) => finding.text.includes('no bridge configuration'));
    expect(noBridge.level).toBe('miss');
    expect(noBridge.fix).toContain('[owner]');
    expect(doc.findings.some((finding: { text: string }) => finding.text.includes('root:'))).toBe(true);
  });

  test('a fault in the audit tail is a warning, not a miss', async () => {
    const fake = new Fake().full();
    fake.process = true;
    fake.file(AUDIT, '{"ts":"2026-10-10T19:16:27.121Z","event":"late_reply"}\n');
    const { rc, out } = await run(['doctor', '--json'], fake);
    const doc = JSON.parse(out);
    const fault = doc.findings.find((finding: { text: string }) => finding.text.includes('late_reply'));
    expect(fault.level).toBe('warn');
    expect(doc.warnings).toBeGreaterThanOrEqual(1);
    // And the leg staying up keeps the exit at 0 when nothing else is missing.
    expect(rc).toBe(0);
    expect(doc.missing).toBe(0);
  });
});

describe('team mcp invocation', () => {
  test('no subcommand, unknown subcommand, extra positional: exit 2 with the usage', async () => {
    const fake = new Fake();
    for (const args of [[], ['frobnicate'], ['status', 'extra'], ['doctor', 'extra', 'more']]) {
      const { rc, err } = await run(args, fake);
      expect(rc).toBe(2);
      expect(err).toContain('team mcp:');
      expect(err).toContain(USAGE.trim().split('\n')[0]!);
    }
  });

  test('an unknown option is the invocation error too', async () => {
    const fake = new Fake();
    const { rc, err } = await run(['status', '--nope'], fake);
    expect(rc).toBe(2);
    expect(err).toContain('unknown option --nope');
  });

  test('the walk test’s contract: usage lines carry both subcommands and --json', () => {
    expect(USAGE.split('\n')[0]).toMatch(/^Usage: team mcp\b/);
    expect(USAGE).toContain('team mcp status [--json]');
    expect(USAGE).toContain('team mcp doctor [--json]');
  });
});

describe('the pure parsers', () => {
  test('parseBridgeConfig accepts the shape the bridge loads and names each break', () => {
    const good = parseBridgeConfig(bridgeConfigText({ inbox_outbox: `${BRIDGE_DIR}/inbox-outbox` }));
    expect(good.problems).toEqual([]);
    expect(good.view).toMatchObject({ wssUrl: 'wss://bridge.example.test/connector', inboxOutbox: `${BRIDGE_DIR}/inbox-outbox` });
    expect(good.view?.seats).toEqual([{ alias: 'desk', route: 'seat-desk-1', key_id: 'seat-desk-1' }]);

    expect(parseBridgeConfig('not json').problems).toEqual(['the config is not JSON']);
    expect(parseBridgeConfig(bridgeConfigText({ wss_url: 'wss://host/connector?x=1' })).problems).toContain('wss_url is not a bare wss://<host>/connector URL');
    expect(parseBridgeConfig(bridgeConfigText({ queue_hmac_key: QUEUE_HMAC_KEY.slice(0, 42) })).problems).toContain('queue_hmac_key is not 32 bytes in base64url');
    expect(parseBridgeConfig(bridgeConfigText({ relay_public_keys: {} })).problems).toContain('relay_public_keys must hold 1 to 4 keys');
    const duplicate = bridgeConfigText({
      seats: [
        { alias: 'desk', route: 'seat-desk-1', key_id: 'seat-desk-1', public_key: PUBLIC_PEM },
        { alias: 'DESK', route: 'seat-desk-2', key_id: 'seat-desk-2', public_key: PUBLIC_PEM },
      ],
    });
    expect(parseBridgeConfig(duplicate).problems.some((problem) => problem.includes('repeats'))).toBe(true);
    expect(parseBridgeConfig(bridgeConfigText({ signer_socket: 'sock.sock' })).problems).toContain('signer_socket is not an absolute path');
    // The secret values themselves never appear in a problem line.
    expect(parseBridgeConfig(bridgeConfigText({ connector_token: CONNECTOR_TOKEN.slice(0, 5) })).problems.join(' ')).not.toContain(CONNECTOR_TOKEN.slice(0, 5));
  });

  test('parseGuardConfig refuses private key material wherever it came from', () => {
    expect(parseGuardConfig(PRIVATE_KEY_TEXT).problems).toContain('the config contains private key material');
    const bad = parseGuardConfig(JSON.stringify({
      version: 1, target_alias: 'Desk', enabled: 'yes',
      public_keys: { 'relay-1': PUBLIC_PEM }, replay_db: '/x/replay.db', audit_file: '/x/audit.jsonl',
    }));
    expect(bad.view).toBeNull();
    expect(bad.problems).toContain('target_alias is not a lowercase seat alias');
  });

  test('parseAuditTail keeps the last well-formed entries and drops torn lines', () => {
    const tail = '{"ts":"a","event":"ws-open"}\n{"broken\n{"no_ts":1}\n{"ts":"b","event":"late_reply"}\n';
    expect(parseAuditTail(tail, 2)).toEqual([
      { ts: 'a', event: 'ws-open' },
      { ts: 'b', event: 'late_reply' },
    ]);
    expect(parseAuditTail('', 3)).toEqual([]);
  });
});

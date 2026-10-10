// `team mcp status` and `team mcp doctor`: what the MCP bridge looks like from this machine,
// read as the user who runs the command and never changed. Status reports each leg the bridge
// needs (the helper folders, the one bridge configuration in the lobby, the signer socket, the
// bridge process, the mailbox, the audit trail, and the public front); doctor diagnoses what is
// missing or misconfigured and prints one fix line per finding, with owner-gated steps marked.
// Both are read-only: nothing here writes a file, no secret value is ever printed (fields are
// named, never quoted), and no privileged command runs.
import { spawnSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { closeSync, constants as fs, fstatSync, lstatSync, openSync, readSync, readdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { readArgs } from '../args.ts';
import type { Command, Io } from '../io.ts';
import { lobbyDir } from '../lobby/gate.ts';

export const USAGE = `Usage: team mcp status [--json]
       team mcp doctor [--json]
Read-only: reports the MCP bridge's state and diagnoses what is missing.
\`status\` exits 0 when every observed leg is up, 1 when one is down or the
bridge was never set up. \`doctor\` exits 0 when nothing is missing, 1 with
findings. Owner-gated fixes are marked [owner]. The mutating setup commands
(enable, disable, key generation) are not in this build yet.
`;

/** Where the helper lives on the Mac (the layout the MCP bring-up fixes). Read-only access
 *  only: keys/, queue/ and state/ belong to the helper uid and are not readable from here. */
export const HELPER_ROOT = '/usr/local/teamcli-helper';

export type Level = 'ok' | 'warn' | 'miss' | 'note';

/** One doctor finding: the level, the sentence, and the one-line fix (null when nothing needs
 *  doing). A fix that needs the owner or privileged access starts with "[owner]". */
export interface McpFinding {
  level: Level;
  text: string;
  fix: string | null;
}

/** One status row, shared by the plain output and the JSON. `state` is the same word the plain
 *  output prints (ok, warn, MISS, --). */
export interface McpRow {
  name: string;
  state: string;
  detail: string;
}

export interface McpSeatJson {
  alias: string;
  route: string;
  key_id: string;
}

export interface McpBridgeJson {
  dir: string;
  config: 'ok' | 'invalid';
  problem: string | null;
  wss_url: string | null;
  seats: McpSeatJson[];
  signer_socket: { path: string; state: 'ok' | 'refused' | 'missing' | 'unknown' } | null;
  bridge_process: 'up' | 'down' | 'unknown';
  mailbox: { outbound_ready: number | null; inbound_ready: number | null } | null;
  inbox_outbox: string | null;
  audit: { path: string; last: { ts: string; event: string } | null } | null;
}

export interface McpGuardJson {
  dir: string;
  config: 'ok' | 'invalid';
  problem: string | null;
  enabled: boolean | null;
  last_audit: { ts: string; event: string } | null;
}

/** The JSON shape printed by `team mcp status --json`. Format 1. */
export interface McpStatusJson {
  format: 1;
  lobby_dir: string;
  helper: { root: string; present: boolean; rows: McpRow[] };
  bridges: McpBridgeJson[];
  guards: McpGuardJson[];
  front: {
    origin: string | null;
    mcp_status: number | null;
    connector_status: number | null;
    tls_valid_to: string | null;
    tls_authorized: boolean | null;
  };
  state: 'up' | 'down' | 'not-set-up';
}

/** The JSON shape printed by `team mcp doctor --json`. Format 1. */
export interface McpDoctorJson {
  format: 1;
  lobby_dir: string;
  findings: McpFinding[];
  missing: number;
  warnings: number;
}

// What `status` and `doctor` read from the machine, so tests can stand in for it. Every path
// answer is "null when it is not there or not readable": a probe that cannot answer is never
// reported as a state that was observed.
export type PathKind = 'file' | 'dir' | 'socket' | 'other';
export interface PathStat {
  kind: PathKind;
  mode: number;
  size: number;
}

export interface McpSources {
  home(): string;
  helperRoot(): string;
  now(): Date;
  /** Entry names of a folder, sorted; null when it cannot be read. */
  listDir(path: string): string[] | null;
  stat(path: string): PathStat | null;
  /** A file's text, or null when it is missing, not a file, or larger than the cap. */
  readText(path: string, maxBytes: number): string | null;
  /** The last bytes of a file (for audit tails), or null. */
  readTail(path: string, maxBytes: number): string | null;
  /** How many entries of a folder end with the suffix; null when the folder can't be read. */
  countSuffix(dir: string, suffix: string): number | null;
  /** A connect probe of a unix socket. The signer destroys an idle connection itself, so a
   *  probe that connects and hangs up changes nothing. */
  probeSocket(path: string): Promise<'ok' | 'refused' | 'missing'>;
  /** One HTTP status of a URL, or null when the request could not be made. `upgrade` sends the
   *  WebSocket upgrade headers the connector route answers on. */
  probeHttp(url: string, upgrade: boolean): Promise<number | null>;
  /** The TLS certificate the public front presents, read without sending a request. */
  certExpiry(host: string): Promise<{ validTo: string; authorized: boolean } | null>;
  /** Whether a process whose command line matches the pattern is running; null when pgrep
   *  cannot tell (exit 0 is a match, 1 no match, anything else is "cannot tell"). */
  processRunning(pattern: string): boolean | null;
}

export const realSources: McpSources = {
  home: () => homedir(),
  helperRoot: () => HELPER_ROOT,
  now: () => new Date(),
  listDir(path) {
    try {
      return readdirSync(path).sort();
    } catch {
      return null;
    }
  },
  stat(path) {
    try {
      const stat = lstatSync(path);
      const kind = stat.isDirectory() ? 'dir'
        : stat.isFile() ? 'file'
          : stat.isSocket() ? 'socket' : 'other';
      return { kind, mode: stat.mode & 0o777, size: stat.size };
    } catch {
      return null;
    }
  },
  readText(path, maxBytes) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > maxBytes) return null;
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  readTail(path, maxBytes) {
    try {
      const fd = openSync(path, fs.O_RDONLY | fs.O_NOFOLLOW);
      try {
        const size = fstatSync(fd).size;
        const start = Math.max(0, size - maxBytes);
        const buffer = Buffer.alloc(size - start);
        readSync(fd, buffer, 0, buffer.length, start);
        return buffer.toString('utf8');
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  },
  countSuffix(dir, suffix) {
    try {
      return readdirSync(dir).filter((name) => name.endsWith(suffix)).length;
    } catch {
      return null;
    }
  },
  probeSocket(path) {
    return new Promise((resolve) => {
      let settled = false;
      const socket = connect({ path });
      const done = (state: 'ok' | 'refused' | 'missing'): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(state);
      };
      socket.setTimeout(2_000);
      socket.once('connect', () => done('ok'));
      socket.once('timeout', () => done('refused'));
      socket.once('error', (error) => done((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'refused'));
    });
  },
  probeHttp(url, upgrade) {
    const headers = upgrade ? ['-H', 'Connection: Upgrade', '-H', 'Upgrade: websocket'] : [];
    const result = spawnSync('curl', [
      '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '8', '--http1.1', ...headers, url,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 12_000 });
    if (result.error) return Promise.resolve(null);
    const code = Number(result.stdout.trim());
    return Promise.resolve(Number.isInteger(code) && code > 0 ? code : null);
  },
  certExpiry(host) {
    return new Promise((resolve) => {
      let settled = false;
      const socket = tlsConnect({ host, port: 443, servername: host });
      const done = (value: { validTo: string; authorized: boolean } | null): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(8_000);
      socket.once('secureConnect', () => {
        const certificate = socket.getPeerCertificate();
        done(certificate.valid_to ? { validTo: certificate.valid_to, authorized: socket.authorized } : null);
      });
      socket.once('timeout', () => done(null));
      socket.once('error', () => done(null));
    });
  },
  processRunning(pattern) {
    const result = spawnSync('pgrep', ['-f', pattern], { stdio: 'ignore', timeout: 5_000 });
    if (result.error) return null;
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    return null;
  },
};

// The bridge config's checks, replayed from `loadBridgeConfig` in the bridge itself so doctor
// finds a file the bridge would refuse before the bridge ever runs. Pure: no filesystem.
export interface BridgeView {
  wssUrl: string;
  signerSocket: string;
  mailboxDir: string;
  auditFile: string;
  inboxOutbox: string | null;
  relayKeyIds: string[];
  seats: McpSeatJson[];
}

const ROUTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function base64url32(value: unknown): boolean {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === value;
}

function ed25519Pem(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 2_000 || !value.startsWith('-----BEGIN PUBLIC KEY-----')) {
    return false;
  }
  try {
    const key = createPublicKey(value);
    return key.type === 'public' && key.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

function absolute(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && !value.includes('\0');
}

export function parseBridgeConfig(text: string): { view: BridgeView | null; problems: string[] } {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { view: null, problems: ['the config is not JSON'] };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { view: null, problems: ['the config is not a JSON object'] };
  }
  const config = raw as Record<string, unknown>;
  if (config.version !== 1) problems.push('version is not 1');
  let wssUrl: string | null = null;
  if (typeof config.wss_url !== 'string') problems.push('wss_url is not a string');
  else {
    try {
      const url = new URL(config.wss_url);
      if (url.protocol !== 'wss:' || url.href !== config.wss_url || url.pathname !== '/connector' ||
        url.search || url.hash || url.username || url.password) {
        problems.push('wss_url is not a bare wss://<host>/connector URL');
      } else {
        wssUrl = config.wss_url;
      }
    } catch {
      problems.push('wss_url is not a URL');
    }
  }
  if (!base64url32(config.connector_token)) problems.push('connector_token is not 32 bytes in base64url');
  if (!base64url32(config.queue_hmac_key)) problems.push('queue_hmac_key is not 32 bytes in base64url');
  const relayIds: string[] = [];
  if (typeof config.relay_public_keys !== 'object' || config.relay_public_keys === null ||
    Array.isArray(config.relay_public_keys)) {
    problems.push('relay_public_keys is not an object');
  } else {
    const entries = Object.entries(config.relay_public_keys as Record<string, unknown>);
    if (entries.length < 1 || entries.length > 4) problems.push('relay_public_keys must hold 1 to 4 keys');
    for (const [id, pem] of entries) {
      if (!ROUTE.test(id)) problems.push(`relay key id ${JSON.stringify(id)} is not a key id shape`);
      else if (!ed25519Pem(pem)) problems.push(`relay key "${id}" is not an Ed25519 public PEM`);
      else relayIds.push(id);
    }
  }
  const seats: McpSeatJson[] = [];
  if (!Array.isArray(config.seats)) {
    problems.push('seats is not an array');
  } else {
    if (config.seats.length < 1 || config.seats.length > 32) problems.push('seats must hold 1 to 32 seats');
    const seen = new Set<string>();
    config.seats.forEach((entry, index) => {
      if (typeof entry !== 'object' || entry === null) {
        problems.push(`seat ${index + 1}: not an object`);
        return;
      }
      const seat = entry as Record<string, unknown>;
      const alias = seat.alias;
      if (typeof alias !== 'string' || !ROUTE.test(alias)) problems.push(`seat ${index + 1}: alias is not a seat alias`);
      else if (seen.has(alias.toLowerCase())) problems.push(`seat ${index + 1}: alias "${alias}" repeats`);
      else seen.add(alias.toLowerCase());
      if (typeof seat.route !== 'string' || !ROUTE.test(seat.route)) problems.push(`seat ${index + 1}: route is not a route shape`);
      if (typeof seat.key_id !== 'string' || !ROUTE.test(seat.key_id)) problems.push(`seat ${index + 1}: key_id is not a key id shape`);
      if (!ed25519Pem(seat.public_key)) problems.push(`seat ${index + 1}: public_key is not an Ed25519 public PEM`);
      if (typeof alias === 'string') {
        seats.push({ alias, route: String(seat.route ?? ''), key_id: String(seat.key_id ?? '') });
      }
    });
  }
  for (const field of ['signer_socket', 'mailbox_dir', 'audit_file'] as const) {
    if (!absolute(config[field])) problems.push(`${field} is not an absolute path`);
  }
  if (config.inbox_outbox !== undefined && !absolute(config.inbox_outbox)) {
    problems.push('inbox_outbox is not an absolute path');
  }
  if (problems.length) return { view: null, problems };
  return {
    view: {
      wssUrl: wssUrl as string,
      signerSocket: config.signer_socket as string,
      mailboxDir: config.mailbox_dir as string,
      auditFile: config.audit_file as string,
      inboxOutbox: config.inbox_outbox === undefined ? null : (config.inbox_outbox as string),
      relayKeyIds: relayIds,
      seats,
    },
    problems,
  };
}

// The seat guard's config, replayed from `configAt` in `seat-guard.ts` (the deployed loader).
// The `PRIVATE KEY` refusal is the provisioning checker's, kept here because a guard config
// holding private key material is a misconfiguration wherever it came from.
export interface GuardView {
  targetAlias: string;
  enabled: boolean;
  keyIds: string[];
  replayDb: string;
  auditFile: string;
  refusalQueue: string | null;
}

export function parseGuardConfig(text: string): { view: GuardView | null; problems: string[] } {
  const problems: string[] = [];
  if (text.includes('PRIVATE KEY')) problems.push('the config contains private key material');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { view: null, problems: [...problems, 'the config is not JSON'] };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { view: null, problems: [...problems, 'the config is not a JSON object'] };
  }
  const config = raw as Record<string, unknown>;
  if (config.version !== 1) problems.push('version is not 1');
  if (typeof config.target_alias !== 'string' || !ALIAS.test(config.target_alias)) {
    problems.push('target_alias is not a lowercase seat alias');
  }
  if (typeof config.enabled !== 'boolean') problems.push('enabled is not a boolean');
  if (!absolute(config.replay_db)) problems.push('replay_db is not an absolute path');
  if (!absolute(config.audit_file)) problems.push('audit_file is not an absolute path');
  if (config.refusal_queue !== undefined && !absolute(config.refusal_queue)) {
    problems.push('refusal_queue is not an absolute path');
  }
  const keyIds: string[] = [];
  if (typeof config.public_keys !== 'object' || config.public_keys === null || Array.isArray(config.public_keys)) {
    problems.push('public_keys is not an object');
  } else {
    const entries = Object.entries(config.public_keys as Record<string, unknown>);
    if (entries.length < 1 || entries.length > 4) problems.push('public_keys must hold 1 to 4 keys');
    for (const [id, pem] of entries) {
      if (!ROUTE.test(id)) problems.push(`public key id ${JSON.stringify(id)} is not a key id shape`);
      else if (!ed25519Pem(pem)) problems.push(`public key "${id}" is not an Ed25519 public PEM`);
      else keyIds.push(id);
    }
  }
  if (problems.length) return { view: null, problems };
  return {
    view: {
      targetAlias: config.target_alias as string,
      enabled: config.enabled as boolean,
      keyIds,
      replayDb: config.replay_db as string,
      auditFile: config.audit_file as string,
      refusalQueue: config.refusal_queue === undefined ? null : (config.refusal_queue as string),
    },
    problems,
  };
}

// The seat reply helper's config, replayed from `configAt` in `seat-reply-helper.ts`.
export interface SeatReplyView {
  seatAlias: string;
  keyId: string;
  keyFile: string;
  replayDb: string;
  answerDir: string;
}

export function parseSeatReplyConfig(text: string): { view: SeatReplyView | null; problems: string[] } {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { view: null, problems: ['the config is not JSON'] };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { view: null, problems: ['the config is not a JSON object'] };
  }
  const config = raw as Record<string, unknown>;
  if (config.version !== 1) problems.push('version is not 1');
  if (typeof config.seat_alias !== 'string' || !ALIAS.test(config.seat_alias)) {
    problems.push('seat_alias is not a lowercase seat alias');
  }
  if (typeof config.key_id !== 'string' || !ROUTE.test(config.key_id)) problems.push('key_id is not a key id shape');
  for (const field of ['key_file', 'replay_db', 'answer_dir'] as const) {
    if (!absolute(config[field])) problems.push(`${field} is not an absolute path`);
  }
  if (problems.length) return { view: null, problems };
  return {
    view: {
      seatAlias: config.seat_alias as string,
      keyId: config.key_id as string,
      keyFile: config.key_file as string,
      replayDb: config.replay_db as string,
      answerDir: config.answer_dir as string,
    },
    problems,
  };
}

export interface AuditEntry {
  ts: string;
  event: string;
  request_id?: string;
}

/** The last `limit` well-formed audit lines of a tail. A line that is not JSON, or has no ts and
 *  event, is skipped: several lanes write the same trail and a torn write must not read as an
 *  event. */
export function parseAuditTail(text: string, limit: number): AuditEntry[] {
  const entries: AuditEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.ts !== 'string' || typeof entry.event !== 'string') continue;
      entries.push({
        ts: entry.ts,
        event: entry.event,
        ...(typeof entry.request_id === 'string' ? { request_id: entry.request_id } : {}),
      });
    } catch {
      continue;
    }
  }
  return entries.slice(-limit);
}

// The bridge's fault event names (`relay.ts` and `bridge-main.ts` audit event names only): a
// last audit line with one of these is worth a doctor warning.
const AUDIT_FAULTS = new Set(['invalid_reply', 'uncorrelated_reply', 'late_reply', 'send_failed', 'invalid_bridge_frame']);

const LEVEL_LABEL: Record<Level, string> = { ok: 'ok  ', warn: 'warn', miss: 'MISS', note: '--  ' };

function octal(mode: number): string {
  return mode.toString(8).padStart(4, '0');
}

function levelOf(state: string): Level {
  return state === 'MISS' ? 'miss' : state === 'warn' ? 'warn' : state === '--' ? 'note' : 'ok';
}

/** The pgrep pattern that finds the bridge for one config: the interpreter's argv holds the
 *  bridge script and its config path, so the config path pins the match to this bridge. */
export function bridgeProcessPattern(configPath: string): string {
  const escaped = configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `bridge-main\\.ts.*${escaped}`;
}

interface HelperCheck {
  name: string;
  level: Level;
  detail: string;
  fix: string | null;
}

function folderCheck(sources: McpSources, root: string, name: string, what: string): HelperCheck {
  const full = join(root, name);
  const stat = sources.stat(full);
  if (stat === null) {
    return { name, level: 'miss', detail: `${what} is missing`, fix: `[owner] the helper bring-up creates ${full}` };
  }
  if (stat.kind !== 'dir') {
    return { name, level: 'miss', detail: `${what} is not a folder`, fix: `[owner] replace ${full} with a folder` };
  }
  if ((stat.mode & 0o077) !== 0) {
    return {
      name, level: 'miss', detail: `readable beyond the helper uid (mode ${octal(stat.mode)})`,
      fix: `[owner] chmod 700 ${full}`,
    };
  }
  return { name, level: 'ok', detail: `${octal(stat.mode)}, private (contents are the helper's own, not readable here)`, fix: null };
}

function socketCheck(sources: McpSources, path: string, state: 'ok' | 'refused' | 'missing' | 'unknown'): HelperCheck {
  const stat = sources.stat(path);
  if (stat === null) {
    return { name: 'signer socket', level: 'miss', detail: `${path} is missing`, fix: `[owner] start the signer socket (it binds ${path})` };
  }
  if (stat.kind !== 'socket') {
    return { name: 'signer socket', level: 'warn', detail: `${path} is not a socket`, fix: `[owner] remove ${path} and start the signer socket again` };
  }
  if ((stat.mode & 0o777) !== 0o660) {
    return {
      name: 'signer socket', level: 'warn', detail: `${path} has mode ${octal(stat.mode)}, expected 0660`,
      fix: '[owner] the signer socket creates its own mode; restart it',
    };
  }
  if (state === 'ok') return { name: 'signer socket', level: 'ok', detail: `${path} accepts connections (0660)`, fix: null };
  if (state === 'refused') {
    return { name: 'signer socket', level: 'miss', detail: `${path} is there but refuses connections`, fix: '[owner] restart the signer socket' };
  }
  if (state === 'missing') {
    return { name: 'signer socket', level: 'miss', detail: `${path} is registered but not there`, fix: '[owner] start the signer socket' };
  }
  return { name: 'signer socket', level: 'warn', detail: `${path}: the connect probe did not answer`, fix: null };
}

/** The helper-folder checks, shared by status (as rows) and doctor (as findings). The socket
 *  row is passed in: it is for the conventional path only when no bridge config named one. */
function helperChecks(sources: McpSources, socket: HelperCheck | null): HelperCheck[] {
  const root = sources.helperRoot();
  const checks: HelperCheck[] = [];
  const rootStat = sources.stat(root);
  if (rootStat === null) {
    checks.push({
      name: 'root', level: 'miss', detail: `the helper is not installed at ${root}`,
      fix: `[owner] the MCP helper bring-up installs it under ${root}`,
    });
  } else if (rootStat.kind !== 'dir') {
    checks.push({ name: 'root', level: 'miss', detail: `${root} is not a folder`, fix: `[owner] replace ${root} with a folder` });
  } else if ((rootStat.mode & 0o001) === 0) {
    checks.push({
      name: 'root', level: 'warn', detail: `mode ${octal(rootStat.mode)}, not world-traversable`,
      fix: `[owner] chmod 755 ${root} (the bridge uid reaches sock/ through it)`,
    });
  } else {
    checks.push({ name: 'root', level: 'ok', detail: `${octal(rootStat.mode)}, world-traversable`, fix: null });
  }
  checks.push(folderCheck(sources, root, 'keys', 'the key folder'));
  checks.push(folderCheck(sources, root, 'queue', 'the queue folder'));
  checks.push(folderCheck(sources, root, 'state', 'the state folder'));
  const sock = join(root, 'sock');
  const sockStat = sources.stat(sock);
  if (sockStat === null) {
    checks.push({ name: 'sock/', level: 'miss', detail: 'the socket folder is missing', fix: `[owner] the helper bring-up creates ${sock}` });
  } else if (sockStat.kind !== 'dir') {
    checks.push({ name: 'sock/', level: 'miss', detail: 'not a folder', fix: `[owner] replace ${sock} with a folder` });
  } else if ((sockStat.mode & 0o007) !== 0) {
    checks.push({
      name: 'sock/', level: 'miss', detail: `readable by "other" (mode ${octal(sockStat.mode)})`,
      fix: `[owner] chmod 770 ${sock} (group staff keeps the bridge uid in)`,
    });
  } else {
    checks.push({ name: 'sock/', level: 'ok', detail: `${octal(sockStat.mode)}, excludes "other"`, fix: null });
  }
  if (socket !== null) checks.push(socket);
  const bun = join(root, 'bin', 'bun');
  const bunStat = sources.stat(bun);
  if (bunStat === null) {
    checks.push({ name: 'bin/bun', level: 'miss', detail: 'the pinned bun is missing', fix: `[owner] the helper bring-up installs ${bun}` });
  } else if ((bunStat.mode & 0o111) === 0) {
    checks.push({ name: 'bin/bun', level: 'warn', detail: 'not executable', fix: `[owner] chmod +x ${bun}` });
  } else {
    checks.push({ name: 'bin/bun', level: 'ok', detail: 'executable', fix: null });
  }
  const app = join(root, 'app', 'src', 'connector', 'bridge-main.ts');
  if (sources.stat(app) === null) {
    checks.push({
      name: 'app/', level: 'miss', detail: 'the bridge script is not deployed',
      fix: `[owner] deploy the bridge export under ${join(root, 'app')} (the runbook's sha-gated swap)`,
    });
  } else {
    checks.push({ name: 'app/', level: 'ok', detail: 'the bridge script is deployed', fix: null });
  }
  const helperConfig = join(root, 'helper-config.json');
  const helperStat = sources.stat(helperConfig);
  if (helperStat === null) {
    checks.push({
      name: 'helper-config.json', level: 'miss', detail: 'missing',
      fix: "[owner] fill the helper config (the runbook's config-wiring block)",
    });
  } else if ((helperStat.mode & 0o777) !== 0o600) {
    checks.push({
      name: 'helper-config.json', level: 'warn', detail: `mode ${octal(helperStat.mode)}, expected 0600`,
      fix: `[owner] chmod 600 ${helperConfig}`,
    });
  } else {
    checks.push({ name: 'helper-config.json', level: 'ok', detail: '0600, owner-held (its contents are not read here)', fix: null });
  }
  return checks;
}

function rowOf(check: HelperCheck): McpRow {
  return { name: check.name, state: LEVEL_LABEL[check.level], detail: check.detail };
}

function findingOf(check: HelperCheck): McpFinding {
  return { level: check.level, text: `${check.name}: ${check.detail}`, fix: check.fix };
}

interface BridgeReport {
  dir: string;
  json: McpBridgeJson;
  rows: McpRow[];
  view: BridgeView | null;
  problems: string[];
  ok: boolean;
}

/** One bridge folder, read-only: the config file and its checks, the process, the socket, the
 *  mailbox and the audit tail. The front is probed separately, once per origin. */
async function bridgeReport(sources: McpSources, dir: string): Promise<BridgeReport> {
  const configPath = join(dir, 'bridge.json');
  const rows: McpRow[] = [];
  const row = (name: string, level: Level, detail: string): void => {
    rows.push({ name, state: LEVEL_LABEL[level], detail });
  };
  const json: McpBridgeJson = {
    dir, config: 'ok', problem: null, wss_url: null, seats: [],
    signer_socket: null, bridge_process: 'unknown', mailbox: null, inbox_outbox: null, audit: null,
  };
  const fail = (problem: string): BridgeReport => {
    json.config = 'invalid';
    json.problem = problem;
    row('config', 'miss', problem);
    return { dir, json, rows, view: null, problems: [problem], ok: false };
  };
  const dirStat = sources.stat(dir);
  if (dirStat === null || dirStat.kind !== 'dir') return fail('the bridge folder cannot be read');
  if (dirStat.mode !== 0o700) return fail(`the bridge folder mode is ${octal(dirStat.mode)}, expected 0700`);
  const fileStat = sources.stat(configPath);
  if (fileStat === null) return fail('bridge.json is missing');
  if (fileStat.kind !== 'file' || fileStat.mode !== 0o600 || fileStat.size > 65_536) {
    return fail(`bridge.json is not a 0600 file under 64 KiB (mode ${octal(fileStat.mode)}, ${fileStat.size} bytes)`);
  }
  const text = sources.readText(configPath, 65_536);
  if (text === null) return fail('bridge.json cannot be read');
  const { view, problems } = parseBridgeConfig(text);
  if (view === null) return fail(problems[0] ?? 'the config is invalid');
  json.config = 'ok';
  json.wss_url = view.wssUrl;
  json.seats = view.seats;
  json.inbox_outbox = view.inboxOutbox;
  row('config', 'ok', `0600, ${fileStat.size} bytes`);
  row('seats', 'ok', view.seats.map((seat) => `${seat.alias} -> ${seat.route} (${seat.key_id})`).join(', '));

  const running = sources.processRunning(bridgeProcessPattern(configPath));
  json.bridge_process = running === null ? 'unknown' : running ? 'up' : 'down';
  row('bridge process', running === true ? 'ok' : running === null ? 'warn' : 'miss',
    running === true ? 'running' : running === null ? 'not observable (pgrep did not answer)' : 'not running');

  const socketStat = sources.stat(view.signerSocket);
  const socketState = socketStat === null ? 'missing' : await sources.probeSocket(view.signerSocket);
  json.signer_socket = { path: view.signerSocket, state: socketState };
  row('signer socket', socketState === 'ok' ? 'ok' : 'miss',
    socketState === 'ok' ? `${view.signerSocket} accepts connections`
      : socketState === 'refused' ? `${view.signerSocket} refuses connections`
        : `${view.signerSocket} is missing`);

  const mailboxStat = sources.stat(view.mailboxDir);
  if (mailboxStat === null) {
    row('mailbox', 'warn', 'not present yet (the bridge creates it on first run)');
  } else {
    const outbound = sources.countSuffix(join(view.mailboxDir, 'outbound'), '.ready');
    const inbound = sources.countSuffix(join(view.mailboxDir, 'inbound'), '.ready');
    json.mailbox = { outbound_ready: outbound, inbound_ready: inbound };
    row('mailbox', mailboxStat.mode === 0o700 ? 'ok' : 'warn',
      `${outbound ?? '?'} outbound ready, ${inbound ?? '?'} inbound ready${mailboxStat.mode === 0o700 ? '' : ` (mode ${octal(mailboxStat.mode)})`}`);
  }

  if (view.inboxOutbox !== null) {
    const inbox = sources.stat(view.inboxOutbox);
    row('inbox outbox', inbox !== null && inbox.kind === 'dir' && inbox.mode === 0o700 ? 'ok' : 'warn',
      inbox === null ? `${view.inboxOutbox} is not there yet` : `${view.inboxOutbox} (${inbox.kind}, mode ${octal(inbox.mode)})`);
  }

  const auditStat = sources.stat(view.auditFile);
  if (auditStat === null) {
    row('last audit', 'note', 'no audit file yet');
  } else {
    const tail = sources.readTail(view.auditFile, 65_536);
    const last = tail === null ? [] : parseAuditTail(tail, 1);
    json.audit = { path: view.auditFile, last: last.length ? { ts: last[0]!.ts, event: last[0]!.event } : null };
    row('last audit', last.length === 0 ? 'note' : AUDIT_FAULTS.has(last[0]!.event) ? 'warn' : 'ok',
      last.length === 0 ? 'no entries' : `${last[0]!.event} at ${last[0]!.ts}`);
  }

  const ok = json.bridge_process === 'up' && socketState === 'ok';
  return { dir, json, rows, view, problems, ok };
}

interface FrontReport {
  json: McpStatusJson['front'];
  rows: McpRow[];
  ok: boolean;
}

async function probeFront(sources: McpSources, wssUrl: string): Promise<FrontReport> {
  const url = new URL(wssUrl);
  // The connector dials wss://; the front's other surfaces speak https on the same host. The
  // probe itself is plain HTTP either way — the upgrade headers are just the request the
  // connector route answers — and a URL's own origin for wss stays wss:// (ws and wss are
  // special schemes), so both probe URLs are built here.
  const origin = `https://${url.host}`;
  const connector = await sources.probeHttp(`${origin}${url.pathname}`, true);
  const mcp = await sources.probeHttp(`${origin}/mcp`, false);
  const certificate = await sources.certExpiry(url.hostname);
  const rows: McpRow[] = [];
  const row = (name: string, level: Level, detail: string): void => {
    rows.push({ name, state: LEVEL_LABEL[level], detail });
  };
  row('mcp endpoint', mcp === 401 ? 'ok' : mcp === null ? 'miss' : 'warn',
    mcp === 401 ? '401, OAuth required (the front answers)' : mcp === null ? 'no answer' : `HTTP ${mcp}`);
  row('connector', connector === 401 ? 'ok' : connector === null || connector === 404 ? 'miss' : 'warn',
    connector === 401 ? '401, enabled and token-gated (the route is bound)'
      : connector === null ? 'no answer'
        : connector === 404 ? 'HTTP 404 (the connector is off or the route is not bound)'
          : `HTTP ${connector}`);
  let tlsValidTo: string | null = null;
  let tlsAuthorized: boolean | null = null;
  if (certificate === null) {
    row('tls certificate', 'miss', 'could not be read');
  } else {
    tlsValidTo = certificate.validTo;
    tlsAuthorized = certificate.authorized;
    const expires = Date.parse(certificate.validTo);
    const days = Number.isNaN(expires) ? null : Math.floor((expires - sources.now().getTime()) / 86_400_000);
    row('tls certificate', days === null ? 'note' : days < 7 ? 'miss' : days < 30 ? 'warn' : 'ok',
      days === null ? `valid to ${certificate.validTo}`
        : `valid for ${days} more day${days === 1 ? '' : 's'} (to ${certificate.validTo})${certificate.authorized ? '' : ', unverified'}`);
  }
  return {
    json: { origin, mcp_status: mcp, connector_status: connector, tls_valid_to: tlsValidTo, tls_authorized: tlsAuthorized },
    rows,
    ok: mcp === 401 && connector === 401,
  };
}

interface GuardReport {
  dir: string;
  json: McpGuardJson;
  rows: McpRow[];
  view: GuardView | null;
  problems: string[];
}

function guardReport(sources: McpSources, dir: string): GuardReport {
  const rows: McpRow[] = [];
  const row = (name: string, level: Level, detail: string): void => {
    rows.push({ name, state: LEVEL_LABEL[level], detail });
  };
  const json: McpGuardJson = { dir, config: 'invalid', problem: null, enabled: null, last_audit: null };
  const fail = (problem: string): GuardReport => {
    json.problem = problem;
    row('config', 'miss', problem);
    return { dir, json, rows, view: null, problems: [problem] };
  };
  const configPath = join(dir, 'guard.json');
  const fileStat = sources.stat(configPath);
  if (fileStat === null) return fail('guard.json is missing');
  if (fileStat.kind !== 'file' || (fileStat.mode & 0o022) !== 0) {
    return fail(`guard.json is not a file the guard accepts (mode ${octal(fileStat.mode)})`);
  }
  const text = sources.readText(configPath, 16_384);
  if (text === null) return fail('guard.json cannot be read or is over 16 KiB');
  const { view, problems } = parseGuardConfig(text);
  if (view === null) return fail(problems[0] ?? 'the config is invalid');
  json.config = 'ok';
  json.enabled = view.enabled;
  row('config', (fileStat.mode & 0o077) !== 0 ? 'warn' : 'ok',
    `${octal(fileStat.mode)}, target "${view.targetAlias}", ${view.enabled ? 'enabled' : 'disabled'}${(fileStat.mode & 0o077) !== 0 ? ' (the guard accepts it; 0600 is the standard)' : ''}`);
  const tail = sources.readTail(view.auditFile, 65_536);
  if (tail !== null) {
    const last = parseAuditTail(tail, 1);
    if (last.length) {
      json.last_audit = { ts: last[0]!.ts, event: last[0]!.event };
      row('last audit', 'ok', `${last[0]!.event} at ${last[0]!.ts}`);
    }
  }
  return { dir, json, rows, view, problems };
}

function renderSections(sections: Array<{ title: string; detail: string; rows: McpRow[] }>): string {
  const lines: string[] = [];
  for (const section of sections) {
    lines.push(`${section.title}  ${section.detail}`);
    const width = Math.max(0, ...section.rows.map((row) => row.name.length));
    for (const row of section.rows) {
      lines.push(`  ${row.name.padEnd(width)}  ${row.state.padEnd(4)}  ${row.detail}`.trimEnd());
    }
  }
  return lines.join('\n');
}

const NO_SETUP = 'no bridge configuration found (the setup command is not in this build yet)';

export async function runMcpStatus(io: Io, json: boolean, sources: McpSources): Promise<number> {
  const lobby = lobbyDir(sources.home());
  const helperRoot = sources.helperRoot();
  const dirs: string[] = [];
  for (const name of sources.listDir(lobby) ?? []) {
    const full = join(lobby, name);
    if (sources.stat(full)?.kind === 'dir') dirs.push(full);
  }
  const bridges: BridgeReport[] = [];
  for (const dir of dirs.filter((dir) => sources.stat(join(dir, 'bridge.json')) !== null)) {
    bridges.push(await bridgeReport(sources, dir));
  }
  const guards = dirs.filter((dir) => sources.stat(join(dir, 'guard.json')) !== null).map((dir) => guardReport(sources, dir));

  const firstView = bridges.find((bridge) => bridge.view !== null)?.view ?? null;
  const defaultSocket = firstView === null ? join(helperRoot, 'sock', 'signer.sock') : null;
  const socketCheckRow = defaultSocket === null ? null
    : socketCheck(sources, defaultSocket, sources.stat(defaultSocket) === null ? 'missing' : await sources.probeSocket(defaultSocket));
  const helperRows = helperChecks(sources, socketCheckRow).map(rowOf);

  const front = firstView === null ? null : await probeFront(sources, firstView.wssUrl);
  const state: McpStatusJson['state'] = bridges.length === 0 ? 'not-set-up'
    : bridges.every((bridge) => bridge.ok) && (front === null || front.ok) ? 'up' : 'down';

  const doc: McpStatusJson = {
    format: 1,
    lobby_dir: lobby,
    helper: { root: helperRoot, present: sources.stat(helperRoot) !== null, rows: helperRows },
    bridges: bridges.map((bridge) => bridge.json),
    guards: guards.map((guard) => guard.json),
    front: front?.json ?? { origin: null, mcp_status: null, connector_status: null, tls_valid_to: null, tls_authorized: null },
    state,
  };

  if (json) {
    io.stdout(`${JSON.stringify(doc, null, 2)}\n`);
  } else {
    const sections: Array<{ title: string; detail: string; rows: McpRow[] }> = [
      { title: 'helper', detail: helperRoot, rows: helperRows },
    ];
    if (bridges.length === 0) {
      sections.push({ title: 'bridge', detail: lobby, rows: [{ name: 'config', state: LEVEL_LABEL.miss, detail: NO_SETUP }] });
    } else {
      for (const bridge of bridges) sections.push({ title: 'bridge', detail: bridge.dir, rows: bridge.rows });
      if (front !== null) sections.push({ title: 'front', detail: front.json.origin ?? '', rows: front.rows });
    }
    for (const guard of guards) sections.push({ title: 'guard', detail: guard.dir, rows: guard.rows });
    io.stdout(`${renderSections(sections)}\nstate: ${state}\n`);
  }
  if (state === 'not-set-up') {
    // exit: mcp.not-set-up
    return 1;
  }
  // exit: mcp.up
  // exit: mcp.down
  return state === 'up' ? 0 : 1;
}

function bridgeRowFinding(dir: string, row: McpRow, helperRoot: string, configPath: string): McpFinding {
  const level = levelOf(row.state);
  let fix: string | null = null;
  if (level === 'miss' || level === 'warn') {
    if (row.name === 'bridge process') fix = `start it: bun ${join(helperRoot, 'app', 'src', 'connector', 'bridge-main.ts')} ${configPath}`;
    else if (row.name === 'signer socket') fix = '[owner] start the signer socket (the runbook\'s signer step)';
    else if (row.name === 'config') fix = `[owner] correct ${configPath} (the bridge refuses to start on it)`;
    else if (row.name === 'last audit') fix = null;
    else if (row.name === 'mailbox') fix = null;
    else if (row.name === 'inbox outbox') fix = null;
  }
  return { level, text: `${dir}: ${row.name}: ${row.detail}`, fix };
}

export async function runMcpDoctor(io: Io, json: boolean, sources: McpSources): Promise<number> {
  const lobby = lobbyDir(sources.home());
  const helperRoot = sources.helperRoot();
  const dirs: string[] = [];
  for (const name of sources.listDir(lobby) ?? []) {
    const full = join(lobby, name);
    if (sources.stat(full)?.kind === 'dir') dirs.push(full);
  }
  const bridges: BridgeReport[] = [];
  for (const dir of dirs.filter((dir) => sources.stat(join(dir, 'bridge.json')) !== null)) {
    bridges.push(await bridgeReport(sources, dir));
  }
  const guards = dirs.filter((dir) => sources.stat(join(dir, 'guard.json')) !== null).map((dir) => guardReport(sources, dir));

  const findings: McpFinding[] = [];
  const firstView = bridges.find((bridge) => bridge.view !== null)?.view ?? null;
  const socketPath = firstView?.signerSocket ?? join(helperRoot, 'sock', 'signer.sock');
  const socketCheckRow = socketCheck(sources, socketPath, sources.stat(socketPath) === null ? 'missing' : await sources.probeSocket(socketPath));
  for (const check of helperChecks(sources, socketCheckRow)) findings.push(findingOf(check));

  if (bridges.length === 0) {
    findings.push({
      level: 'miss', text: `no bridge configuration in ${lobby}`,
      fix: '[owner] the automated setup is not in this build yet; the MCP bring-up runbook\'s G4/G5 blocks wire the helper and the bridge',
    });
  }

  for (const bridge of bridges) {
    const configPath = join(bridge.dir, 'bridge.json');
    for (const row of bridge.rows) findings.push(bridgeRowFinding(bridge.dir, row, helperRoot, configPath));
    for (const problem of bridge.problems.slice(bridge.view === null ? 1 : 0)) {
      findings.push({ level: 'miss', text: `${bridge.dir}: ${problem}`, fix: `[owner] correct it in ${configPath} (the bridge refuses to start on it)` });
    }
    if (bridge.json.bridge_process === 'down') {
      findings.push({
        level: 'miss', text: `${bridge.dir}: the bridge is not running`,
        fix: `start it: bun ${join(helperRoot, 'app', 'src', 'connector', 'bridge-main.ts')} ${configPath}`,
      });
    }
    if (bridge.view !== null) {
      const front = await probeFront(sources, bridge.view.wssUrl);
      for (const row of front.rows) {
        const level = levelOf(row.state);
        let fix: string | null = null;
        if (row.name === 'connector' && level !== 'ok') {
          fix = row.detail.includes('404')
            ? "[owner] set TEAMCLI_CONNECTOR_ENABLED=1 in the front's .env and bind the nginx /connector route (the front host, owner-run)"
            : "check DNS and the front host: curl -sS -o /dev/null -w '%{http_code}' https://<host>/connector";
        } else if (row.name === 'mcp endpoint' && level !== 'ok') {
          fix = 'check DNS and the front host, then the front process itself (it binds loopback behind nginx)';
        } else if (row.name === 'tls certificate' && level !== 'ok') {
          fix = '[owner] renew the front certificate (certbot or the Cloudflare edge; owner-run)';
        }
        if (level !== 'ok') findings.push({ level, text: `${front.json.origin}: ${row.name}: ${row.detail}`, fix });
      }
    }
  }

  for (const guard of guards) {
    const configPath = join(guard.dir, 'guard.json');
    for (const row of guard.rows) {
      const level = levelOf(row.state);
      findings.push({
        level, text: `${guard.dir}: guard ${row.name}: ${row.detail}`,
        fix: level === 'miss' ? `[owner] correct ${configPath} (the seat guard blocks on it)` : null,
      });
    }
    for (const problem of guard.problems.slice(guard.view === null ? 1 : 0)) {
      findings.push({ level: 'miss', text: `${guard.dir}: ${problem}`, fix: `[owner] correct it in ${configPath}` });
    }
    if (guard.view !== null) {
      const replayParent = sources.stat(dirname(guard.view.replayDb));
      if (replayParent !== null && (replayParent.mode & 0o077) !== 0) {
        findings.push({
          level: 'miss', text: `${guard.dir}: the replay ledger's folder is readable beyond the owner (mode ${octal(replayParent.mode)})`,
          fix: `[owner] chmod 700 ${dirname(guard.view.replayDb)} (sqlite writes -wal and -shm siblings there)`,
        });
      }
      const replyText = sources.readText(join(guard.dir, 'seat-reply-config.json'), 16_384);
      if (replyText !== null) {
        const reply = parseSeatReplyConfig(replyText);
        if (reply.view === null) {
          findings.push({
            level: 'miss', text: `${guard.dir}: seat-reply-config.json: ${reply.problems[0] ?? 'invalid'}`,
            fix: `[owner] correct it in ${join(guard.dir, 'seat-reply-config.json')}`,
          });
        } else {
          const answerDir = sources.stat(reply.view.answerDir);
          if (answerDir === null || answerDir.mode !== 0o700) {
            findings.push({
              level: 'miss', text: `${guard.dir}: the reply answer folder is not a private 0700 folder`,
              fix: `[owner] chmod 700 ${reply.view.answerDir}`,
            });
          }
        }
      }
    }
  }

  const missing = findings.filter((finding) => finding.level === 'miss').length;
  const warnings = findings.filter((finding) => finding.level === 'warn').length;
  if (json) {
    const doc: McpDoctorJson = { format: 1, lobby_dir: lobby, findings, missing, warnings };
    io.stdout(`${JSON.stringify(doc, null, 2)}\n`);
  } else {
    for (const finding of findings) {
      io.stdout(`${LEVEL_LABEL[finding.level]}  ${finding.text}\n`);
      if (finding.fix !== null) io.stdout(`      fix: ${finding.fix}\n`);
    }
    const plural = warnings === 1 ? '' : 's';
    io.stdout(missing ? `team mcp doctor: ${missing} missing, ${warnings} warning${plural}\n`
      : `team mcp doctor: nothing missing, ${warnings} warning${plural}\n`);
  }
  // exit: mcp.clear
  // exit: mcp.missing
  return missing ? 1 : 0;
}

export async function runMcp(argv: string[], io: Io, sources: McpSources = realSources): Promise<number> {
  const args = readArgs(argv, [], ['json']);
  const sub = args.rest[0];
  const fail = (message: string): number => {
    io.stderr(`team mcp: ${message}\n\n${USAGE}`);
    // exit: mcp.invocation
    return 2;
  };
  if (args.error) return fail(args.error);
  if (sub !== 'status' && sub !== 'doctor') {
    return fail(sub === undefined ? 'a subcommand is required: status or doctor' : `unknown subcommand ${JSON.stringify(sub)}`);
  }
  if (args.rest.length > 1) return fail(`unexpected ${JSON.stringify(args.rest[1] as string)}`);
  if (sub === 'status') return runMcpStatus(io, args.flags.has('json'), sources);
  return runMcpDoctor(io, args.flags.has('json'), sources);
}

export const mcp: Command = (argv, io) => runMcp(argv, io, realSources);
export default mcp;

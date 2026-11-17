// The terminal host's read calls over its own socket: which CLI calls are answered that way, which
// socket is certain enough to use, and, against a host process on a scratch socket, the same
// `result` the CLI reads, an error answer thrown, and every unusable answer handed back to the CLI.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { directRequestOf, directSocketOf, herdrDirect, herdrDirectBound } from '../src/herdr-direct.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

describe('the calls answered over the socket', () => {
  test('the five read calls map to their API methods', () => {
    expect(directRequestOf(['agent', 'list'])).toEqual({ method: 'agent.list', params: {} });
    expect(directRequestOf(['workspace', 'list'])).toEqual({ method: 'workspace.list', params: {} });
    expect(directRequestOf(['pane', 'process-info', '--pane', 'w1:p1'])).toEqual({ method: 'pane.process_info', params: { pane_id: 'w1:p1' } });
    expect(directRequestOf(['pane', 'get', 'w1:p1'])).toEqual({ method: 'pane.get', params: { pane_id: 'w1:p1' } });
    expect(directRequestOf(['pane', 'list', '--workspace', 'w1'])).toEqual({ method: 'pane.list', params: { workspace_id: 'w1' } });
  });

  test('every other call, and any other shape of these, keeps the CLI', () => {
    for (const args of [
      ['agent', 'list', '--json'],
      ['pane', 'read', 'w1:p1'],
      ['pane', 'get', '--pane', 'w1:p1'],
      ['pane', 'process-info', 'w1:p1'],
      ['pane', 'send-keys', 'w1:p1', 'enter'],
      ['agent', 'rename', 'w1:p1', 'x'],
      ['server', 'reload-config'],
      ['workspace', 'close', 'w1'],
    ]) {
      expect(directRequestOf(args)).toBeNull();
    }
  });
});

describe('the socket the CLI would use', () => {
  const env = (extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ HOME: '/home/u', ...extra });

  test('an explicit session names its own socket, whatever HERDR_SOCKET_PATH says', () => {
    expect(directSocketOf('alpha', env({ HERDR_SOCKET_PATH: '/elsewhere/x.sock' }))).toBe('/home/u/.config/herdr/sessions/alpha/herdr.sock');
  });

  test('no session: HERDR_SOCKET_PATH, only when it is a herdr socket under this HOME', () => {
    expect(directSocketOf(undefined, env({ HERDR_SOCKET_PATH: '/home/u/.config/herdr/sessions/beta/herdr.sock' }))).toBe('/home/u/.config/herdr/sessions/beta/herdr.sock');
    expect(directSocketOf(undefined, env({ HERDR_SOCKET_PATH: '/home/u/.config/herdr/herdr.sock' }))).toBe('/home/u/.config/herdr/herdr.sock');
    expect(directSocketOf(undefined, env({ HERDR_SOCKET_PATH: '/home/other/.config/herdr/sessions/a/herdr.sock' }))).toBeNull();
    expect(directSocketOf(undefined, env({ HERDR_SOCKET_PATH: '/home/u/.config/herdr/sessions/../x/herdr.sock' }))).toBeNull();
    expect(directSocketOf(undefined, env({ HERDR_SESSION: 'alpha' }))).toBeNull();
    expect(directSocketOf(undefined, env({}))).toBeNull();
  });

  test('XDG_CONFIG_HOME or a name the CLI refuses keeps the CLI', () => {
    expect(directSocketOf('alpha', env({ XDG_CONFIG_HOME: '/x' }))).toBeNull();
    expect(directSocketOf('a b', env({}))).toBeNull();
    expect(directSocketOf('..', env({}))).toBeNull();
    expect(directSocketOf('a/b', env({}))).toBeNull();
  });
});

const live = process.platform === 'darwin' && process.versions.bun !== undefined;

// A host on a scratch socket in its own process (the read is synchronous: a host on this
// process's own loop could never answer it). It answers by the request's params.
const HOST = `
const { createServer } = require('node:net');
const path = process.argv[1];
createServer((socket) => {
  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk;
    if (!buf.endsWith('\\n')) return;
    const req = JSON.parse(buf);
    const pane = req.params.pane_id;
    if (pane === 'silent') return;
    if (pane === 'late') {
      // Two early pieces, the last one past a 400 ms deadline but inside one fresh 400 ms read.
      const text = JSON.stringify({ id: req.id, result: { late: true } }) + '\\n';
      socket.write(text.slice(0, 5));
      setTimeout(() => socket.write(text.slice(5, 10)), 300);
      setTimeout(() => socket.end(text.slice(10)), 650);
      return;
    }
    if (pane === 'drip') {
      // A full answer, a few bytes every 150 ms: each read waits less than the limit, the whole
      // answer takes longer than it.
      const text = JSON.stringify({ id: req.id, result: { late: true } }) + '\\n';
      let at = 0;
      const step = () => { if (at >= text.length) { socket.end(); return; } socket.write(text.slice(at, at + 8)); at += 8; setTimeout(step, 150); };
      step();
      return;
    }
    if (pane === 'close') { socket.end(); return; }
    if (pane === 'err') { socket.end(JSON.stringify({ id: req.id, error: { code: 'pane_not_found', message: 'pane err not found' } }) + '\\n'); return; }
    if (pane === 'other-id') { socket.end(JSON.stringify({ id: 'x', result: {} }) + '\\n'); return; }
    if (pane === 'big') { socket.end(JSON.stringify({ id: req.id, result: { text: 'y'.repeat(300000) } }) + '\\n'); return; }
    socket.end(JSON.stringify({ id: req.id, result: { method: req.method, params: req.params } }) + '\\n');
  });
}).listen(path, () => console.log('ready'));
`;

describe.if(live)('against a host on a scratch socket', () => {
  let base = '';
  let host: ReturnType<typeof Bun.spawn> | null = null;
  const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };

  beforeAll(async () => {
    base = fixtureBase('hd-');
    const socket = join(base, '.config', 'herdr', 'sessions', 'fixture', 'herdr.sock');
    mkdirSync(dirname(socket), { recursive: true });
    host = Bun.spawn(['bun', '-e', HOST, socket], { stdout: 'pipe', stderr: 'ignore' });
    for (let i = 0; i < 200 && !existsSync(socket); i++) await Bun.sleep(10);
    process.env.HOME = base;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterAll(() => {
    host?.kill();
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.XDG !== undefined) process.env.XDG_CONFIG_HOME = saved.XDG;
    discardFixtures([base], { roots: [dirname(base)] });
  });

  test('the reader binds', () => {
    expect(herdrDirectBound()).toBe(true);
  });

  test('a result comes back as the CLI reads it', () => {
    expect(herdrDirect(['pane', 'get', 'w1:p1'], 'fixture')).toEqual({ result: { method: 'pane.get', params: { pane_id: 'w1:p1' } } });
    expect(herdrDirect(['agent', 'list'], 'fixture')).toEqual({ result: { method: 'agent.list', params: {} } });
  });

  test('a long answer is read whole', () => {
    const answer = herdrDirect(['pane', 'get', 'big'], 'fixture') as { result: { text: string } };
    expect(answer.result.text.length).toBe(300000);
  });

  test('an error answer throws, as the CLI exits non-zero', () => {
    expect(() => herdrDirect(['pane', 'get', 'err'], 'fixture')).toThrow('pane err not found');
  });

  test('an answer for another request, or a closed connection, goes back to the CLI', () => {
    expect(herdrDirect(['pane', 'get', 'other-id'], 'fixture')).toBeUndefined();
    expect(herdrDirect(['pane', 'get', 'close'], 'fixture')).toBeUndefined();
  });

  test('no socket for the session, or a call not answered here, goes back to the CLI', () => {
    expect(herdrDirect(['agent', 'list'], 'no-such-session')).toBeUndefined();
    expect(herdrDirect(['pane', 'read', 'w1:p1'], 'fixture')).toBeUndefined();
  });

  test('an answer dripped past the deadline is refused as late, whatever each read waits', () => {
    const started = Date.now();
    let code: unknown;
    let answer: unknown;
    try {
      answer = herdrDirect(['pane', 'get', 'drip'], 'fixture', 400);
    } catch (error) {
      code = (error as { code?: unknown }).code;
    }
    expect(answer).toBeUndefined();
    expect(code).toBe('ETIMEDOUT');
    // The deadline, plus at most one bounded wait: never the whole drip (~1 s).
    expect(Date.now() - started).toBeLessThan(700);
  });

  test('the last piece landing after the deadline is late, even inside one read wait', () => {
    const started = Date.now();
    let code: unknown;
    let answer: unknown;
    try {
      answer = herdrDirect(['pane', 'get', 'late'], 'fixture', 400);
    } catch (error) {
      code = (error as { code?: unknown }).code;
    }
    expect(answer).toBeUndefined();
    expect(code).toBe('ETIMEDOUT');
    expect(Date.now() - started).toBeLessThan(600);
  });

  test('a host that never answers is a timeout, not a second try', () => {
    const started = Date.now();
    let code: unknown;
    try {
      herdrDirect(['pane', 'get', 'silent'], 'fixture', 300);
    } catch (error) {
      code = (error as { code?: unknown }).code;
    }
    expect(code).toBe('ETIMEDOUT');
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

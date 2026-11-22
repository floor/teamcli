// Author R3 regression (lead, 2026-11-11 05:12Z): normal registry writer versus compare/delete.
// Pipe barriers define the interleaving; no sleeps, guessed timing bounds or raw registry writes.
import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { agentsDir, findAgent, registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { captureModelDriftFence, clearModelDrift, reportModelDrift } from '../src/send/model-drift.ts';
import { LOCK_FILE } from '../src/state.ts';
import { signedSeatModelObservation } from '../src/status/statusline.ts';
import { wrapperPane } from './helpers.ts';
import { NOW, world } from './send-native-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const RECORDED = { model: 'GLM', version: '5.3' };

function fixture() {
  const w = world(['drop']);
  cleanups.push(w.cleanup);
  const record = registerAgent(w.home, {
    name: 'synthetic recipient', signing: { ...RECORDED, role: 'coordinator' }, lab: 'test',
    cli: 'claude-code', launcher: null, launch: 'claude-glm.sh',
    reach: { team: teamIdOf(w.root), seat: 'lead', session: 'acme', pane: 'synthetic-pane', address: null },
    mcp: [], skills: [], lifecycle: 'running', by: 'synthetic fixture',
  });
  const scope = { dir: w.dir, root: w.root, home: w.home, session: 'acme', seat: 'lead' };
  const file = join(w.dir, 'model-drift', 'acme', 'lead.json');
  let notices = 0;
  const report = () => reportModelDrift({ ...scope,
    drift: { recipient: record.id, recorded: RECORDED, observed: { model: 'GLM', version: '5.4' } },
    lead: 'lead', leadId: record.id, now: NOW,
    send: async () => { notices += 1; return { ok: true, detail: 'synthetic notice recorded' }; },
  });
  const observation = signedSeatModelObservation({ cli: record.cli, ...RECORDED, launch: record.launch }, wrapperPane('glm-5.3'));
  return { w, scope, record, file, observation, report, notices: () => notices };
}

function worker(mode: string, request: unknown) {
  const child = spawn(process.execPath, [join(import.meta.dir, 'helpers', 'model-drift-lock-worker.ts'), mode, JSON.stringify(request)],
    { cwd: join(import.meta.dir, '..'), stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.setEncoding('utf8').on('data', (text: string) => { errors += text; });
  const done = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  const lines = createInterface({ input: child.stdout });
  const first = Promise.race([
    once(lines, 'line').then(([line]) => String(line)),
    done.then((code) => { throw new Error(`synthetic ${mode} exited before its barrier (${String(code)}): ${errors}`); }),
  ]);
  return { child, done, first, errors: () => errors };
}

test('an ordinary registry writer publishing B while a clear has copied A preserves the episode', async () => {
  const f = fixture();
  await f.report();
  const episodeId = JSON.parse(readFileSync(f.file, 'utf8')).id;
  const fence = captureModelDriftFence(f.scope);
  expect(fence).not.toBeNull();
  const request = {
    home: f.w.home, id: f.record.id, conversation: 'synthetic-rebound-conversation',
    agentFile: join(agentsDir(f.w.home), `${f.record.id}.yaml`), registryLock: join(agentsDir(f.w.home), LOCK_FILE),
    clear: { ...f.scope, recipient: f.record.id, observation: f.observation, fence },
  };
  const writer = worker('writer', request);
  let reader: ReturnType<typeof worker> | undefined;
  try {
    expect(await writer.first).toBe('writer-held');
    expect(readFileSync(request.registryLock, 'utf8').trim()).toBe(String(writer.child.pid));
    reader = worker('clear', request);
    const phase = await reader.first;
    expect(['registry-lock', 'copied-record']).toContain(phase);
    // In the parent the clear has already copied A; in the fix it has not acquired the
    // registry lock yet. Both receive exactly the same ordinary B publication before resume.
    writer.child.stdin.end('go');
    expect(await writer.done, writer.errors()).toBe(0);
    expect(findAgent(f.w.home, { team: teamIdOf(f.w.root), seat: 'lead' }, { fresh: true })?.reach.agent_session).toBe(request.conversation);
    reader.child.stdin.end('go');
    expect(await reader.done, reader.errors()).toBe(0);
    console.info(`R3 interleaving: ${phase}; writer=B; clear finished; episode kept=${String(existsSync(f.file))}`);
    expect(existsSync(f.file), `writer B committed before clear resumed at ${phase}`).toBe(true);
    expect(JSON.parse(readFileSync(f.file, 'utf8')).id).toBe(episodeId);
    await f.report();
    expect(f.notices()).toBe(1);
  } finally {
    for (const item of [writer, reader]) {
      if (item === undefined) continue;
      if (!item.child.stdin.writableEnded && !item.child.stdin.destroyed) item.child.stdin.end('go');
      if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill();
    }
    await Promise.allSettled([writer.done, ...(reader === undefined ? [] : [reader.done])]);
  }
});

test('a positive current repair still commits its clear when no registry writer intervenes', async () => {
  const f = fixture();
  await f.report();
  clearModelDrift({ ...f.scope, recipient: f.record.id, observation: f.observation, fence: captureModelDriftFence(f.scope) });
  expect(existsSync(f.file)).toBe(false);
  await f.report();
  expect(f.notices()).toBe(2);
});

// `team swap` at its edges: the rule's own proposal, an aimed target, the queue record in the
// state, the owner's force, the cancel, and the wait the resolved policy chain gives it
// (Policies rules 10 and 11).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { type Caller } from '../src/caller.ts';
import { runSwap, type SwapCommandOptions } from '../src/commands/swap.ts';
import { SWAP_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { readState } from '../src/state.ts';
import { testIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

const TEAM = `format: 1
project: acme
entity: lab
operator: lead
workspace:
  mode: shared
seats:
  - role: project coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    cli: claude-code
    vendor: deepseek
    model: DeepSeek Flash
    version: "4.0"
    launch: claude --model deepseek-flash
  - role: reviewer
    name: helper
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "5.0"
    launch: codex --model gpt-sol
`;

const NOW = new Date('2026-10-19T09:00:00Z');
const OWNER: Caller = { kind: 'owner' };

const files: string[] = [];
let root = '';
let home = '';

function place(): void {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-swap-')));
  files.push(base);
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
}

afterEach(() => {
  for (const dir of files.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setRule(value: string): void {
  const wrote = writePolicySet(home, { level: 'entity', target: 'lab', name: 'model-rule', value }, { now: NOW });
  if (!wrote.ok) throw new Error(wrote.why);
}

async function swap(argv: string[], caller: Caller = OWNER): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, caller);
  const code = await runSwap(argv, io, { home, now: () => NOW } satisfies SwapCommandOptions);
  return { code, out: io.out, err: io.err };
}

const queue = () => readState(join(root, '.agents')).swaps ?? {};

describe('team swap queue', () => {
  test('queues the recipe the rule proposes, for the boundary and the default 30 minutes', async () => {
    place();
    setRule('*=!anthropic');
    const result = await swap(['queue', 'lead']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('swap queued: lead');
    const record = queue().lead;
    expect(record).toBeDefined();
    expect(record!.reason).toBe('model-rule');
    expect(record!.from).toMatchObject({ cli: 'claude-code', vendor: 'anthropic', model: 'Claude Opus' });
    expect(record!.to).toMatchObject({ cli: 'claude-code', vendor: 'deepseek', model: 'DeepSeek Flash' });
    expect(Date.parse(record!.deadline) - Date.parse(record!.queuedAt)).toBe(1800 * 1000);
    expect(record!.waitFor).toContain('boundary');
  });

  test('a swap-wait-seconds entity value sets the deadline', async () => {
    place();
    setRule('*=!anthropic');
    writePolicySet(home, { level: 'entity', target: 'lab', name: 'swap-wait-seconds', value: 60 }, { now: NOW });
    const result = await swap(['queue', 'lead']);
    expect(result.code).toBe(0);
    const record = queue().lead!;
    expect(Date.parse(record.deadline) - Date.parse(record.queuedAt)).toBe(60 * 1000);
  });

  test('--to copies a donor on that cli and model', async () => {
    place();
    setRule('*=!anthropic');
    const result = await swap(['queue', 'lead', '--to', 'codex:gpt sol']);
    expect(result.code).toBe(0);
    const record = queue().lead!;
    expect(record.to).toMatchObject({ cli: 'codex', vendor: 'openai', model: 'GPT Sol', launch: 'codex --model gpt-sol' });
  });

  test('--to with no donor of the entity refuses', async () => {
    place();
    setRule('*=!anthropic');
    const result = await swap(['queue', 'lead', '--to', 'codex:gemini']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('no seat of the entity this team may copy from');
    expect(queue()).toEqual({});
  });

  test('a seat the rule allows has nothing to swap to', async () => {
    place();
    setRule('*=!anthropic');
    const result = await swap(['queue', 'worker']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('nothing to swap to');
    expect(queue()).toEqual({});
  });

  test('a seat the team does not declare is refused', async () => {
    place();
    setRule('*=!anthropic');
    const result = await swap(['queue', 'nobody']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('no seat "nobody"');
  });

  test('no entity rule means nothing to queue', async () => {
    place();
    const result = await swap(['queue', 'lead']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('declares no model rule');
  });

  test('a caller that is not the owner or a lead is refused', async () => {
    place();
    setRule('*=!anthropic');
    const worker: Caller = { kind: 'seat', name: 'worker', pane: 'w1:p2', session: 'acme' };
    const result = await swap(['queue', 'lead'], worker);
    expect(result.code).toBe(1);
    expect(result.err).toContain('only the owner, the orchestrator or the operator');
  });
});

describe('team swap views', () => {
  test('the view prints each queued swap and says when nothing waits', async () => {
    place();
    setRule('*=!anthropic');
    const quiet = await swap([]);
    expect(quiet.code).toBe(0);
    expect(quiet.out).toContain('nothing queued');
    await swap(['queue', 'lead']);
    const listed = await swap([]);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain('lead: anthropic Claude Opus 5.5 -> deepseek DeepSeek Flash 4.0');
    expect(listed.out).toContain('waits for');
  });

  test('--rule lists the breach and the donor', async () => {
    place();
    setRule('*=!anthropic');
    const result = await swap(['--rule']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('rule: *=!anthropic (entity lab)');
    expect(result.out).toContain('acme/lead: role project coordinator, vendor anthropic -> claude-code DeepSeek Flash 4.0 from acme/worker');
  });

  test('--rule with -json prints the listing', async () => {
    place();
    setRule('*=!anthropic');
    const result = await swap(['--rule', '--json']);
    expect(result.code).toBe(0);
    const doc = assertMatchesOutputSchema<{
      schema: { name: string };
      status: string;
      breaches: Array<{ proposal: { donor: Record<string, string> } }>;
    }>(result.out, SWAP_OUTPUT_SCHEMA);
    expect(doc.schema.name).toBe('team.swap');
    expect(doc.status).toBe('rule');
    expect(doc.breaches).toHaveLength(1);
    expect(doc.breaches[0]!.proposal.donor).toMatchObject({ team: 'acme', seat: 'worker' });
  });

  test('a queued swap under --json matches the published schema', async () => {
    place();
    setRule('*=!anthropic');
    const result = await swap(['queue', 'lead', '--json']);
    expect(result.code).toBe(0);
    const doc = assertMatchesOutputSchema<{ status: string; seat: string }>(result.out, SWAP_OUTPUT_SCHEMA);
    expect(doc.status).toBe('queued');
    expect(doc.seat).toBe('lead');
  });

  test('a refusal under --json is the team.error envelope', async () => {
    place();
    setRule('*=!anthropic');
    const result = await swap(['queue', 'worker', '--json']);
    expect(result.code).toBe(1);
    assertJsonErrorShape(result.out, { id: 'swap.unchanged' });
  });
});

describe('team swap now and cancel', () => {
  test('the owner forces a queued swap and the log says so', async () => {
    place();
    setRule('*=!anthropic');
    await swap(['queue', 'lead']);
    const forced = await swap(['now', 'lead']);
    expect(forced.code).toBe(0);
    expect(forced.out).toContain('forced by owner');
    expect(queue().lead!.forced).toMatchObject({ by: 'owner', at: NOW.toISOString() });
  });

  test('the owner forces a swap that was not queued by taking the rule recipe', async () => {
    place();
    setRule('*=!anthropic');
    const forced = await swap(['now', 'lead']);
    expect(forced.code).toBe(0);
    expect(queue().lead!.forced?.by).toBe('owner');
    expect(queue().lead!.reason).toBe('owner');
  });

  test('a seat is refused `now`', async () => {
    place();
    setRule('*=!anthropic');
    const lead: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' };
    const result = await swap(['now', 'lead'], lead);
    expect(result.code).toBe(1);
    expect(result.err).toContain('only the owner forces a swap');
  });

  test('cancel removes the record and refused a second cancel', async () => {
    place();
    setRule('*=!anthropic');
    await swap(['queue', 'lead']);
    const cancelled = await swap(['cancel', 'lead']);
    expect(cancelled.code).toBe(0);
    expect(cancelled.out).toContain('swap cancelled: lead');
    expect(queue()).toEqual({});
    const again = await swap(['cancel', 'lead']);
    expect(again.code).toBe(1);
    expect(again.err).toContain('waits on no swap');
  });
});

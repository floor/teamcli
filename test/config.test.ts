// `team config`: the settings registry, read-only at the approved minimum. The scenes cover the
// listing, the level filter, a level with no keys, and the invocations the command refuses —
// and pin the exact table the registry prints.
import { describe, expect, test } from 'bun:test';
import { runConfig, USAGE } from '../src/commands/config.ts';
import { testIo } from './helpers.ts';
import { assertJsonErrorShape } from './helpers/output.ts';

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const io = testIo('/tmp');
  const code = await runConfig(argv, io);
  return { code, out: io.out, err: io.err };
}

const TABLE = [
  "  KEY             LEVELS  ALLOWED                                                          DEFAULT                 GOVERNED BY     APPLIES",
  "  model           seat    a model the seat's profile and the allowed-models policy accept  -                       allowed-models  restart that resumes",
  "  effort          seat    one of the CLI profile's effort levels                           -                       -               restart that resumes",
  "  nickname        seat    unique in the team, never lead                                   -                       -               at once",
  "  delivery_order  seat    delivery legs, tighten only                                      mcp-inbox, typed, drop  delivery-order  at once",
  "  human           seat    true or false                                                    false                   -               at once",
].join('\n') + '\n';

describe('team config keys', () => {
  test('lists the whole registry', async () => {
    const result = await run(['keys']);
    expect(result.code).toBe(0);
    expect(result.out).toBe(TABLE);
    expect(result.err).toBe('');
  });

  test('lists the seat keys for --level seat', async () => {
    const all = await run(['keys']);
    const seat = await run(['keys', 'seat']);
    expect(seat.code).toBe(0);
    expect(seat.out).toBe(all.out);
  });

  test('a level with no registered keys says so', async () => {
    for (const level of ['entity', 'project', 'team']) {
      const result = await run(['keys', level]);
      expect(result.code).toBe(0);
      expect(result.out).toBe(`no settings are registered at ${level} level\n`);
    }
  });

  test('--json carries the registry fields', async () => {
    const result = await run(['keys', '--json']);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out) as {
      schema: { name: string; version: number };
      format: number;
      level: string | null;
      keys: {
        key: string;
        levels: string[];
        type: string;
        allowed: string;
        default: unknown;
        governed_by: string | null;
        applies: string;
      }[];
    };
    expect(doc.schema).toEqual({ name: 'team.config-keys', version: 1 });
    expect(doc.format).toBe(1);
    expect(doc.level).toBeNull();
    expect(doc.keys.map((entry) => entry.key)).toEqual(['model', 'effort', 'nickname', 'delivery_order', 'human']);
    expect(doc.keys[0]).toEqual({
      key: 'model',
      levels: ['seat'],
      type: 'model',
      allowed: "a model the seat's profile and the allowed-models policy accept",
      default: null,
      governed_by: 'allowed-models',
      applies: 'restart-resume',
    });
    expect(doc.keys[3]!.default).toEqual(['mcp-inbox', 'typed', 'drop']);
    expect(doc.keys[4]!.default).toBe(false);
  });

  test('--json of a level with no keys is an empty list, not an error', async () => {
    const result = await run(['keys', 'team', '--json']);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out) as { level: string; keys: unknown[] };
    expect(doc.level).toBe('team');
    expect(doc.keys).toEqual([]);
  });
});

describe('refusals', () => {
  test('no subcommand', async () => {
    const result = await run([]);
    expect(result.code).toBe(2);
    expect(result.err).toBe(`team config: a subcommand is required (keys, get, set, unset, edit)\n${USAGE}`);
  });

  test('an unknown subcommand', async () => {
    const result = await run(['bogus']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('team config: unknown subcommand "bogus"');
  });

  test('a word that is not a level', async () => {
    const result = await run(['keys', 'machine']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('team config: "machine" is not a level (entity, project, team, seat)');
  });

  test('a third word', async () => {
    const result = await run(['keys', 'seat', 'extra']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('team config: unexpected "extra"');
  });

  test('an unknown option', async () => {
    const result = await run(['keys', '--nope']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('team config: unknown option --nope');
  });

  test('--json carries the refusal id', async () => {
    const result = await run(['keys', 'machine', '--json']);
    expect(result.code).toBe(2);
    assertJsonErrorShape(result.out, { id: 'config.invocation', messageContains: '"machine" is not a level' });
  });
});

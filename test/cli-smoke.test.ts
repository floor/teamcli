import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { commands } from '../src/cli.ts';

const cliEntry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const contractPath = fileURLToPath(new URL('../contract/cli.json', import.meta.url));

type ContractCommand = {
  name: string;
  hidden: boolean;
};

type ContractCli = {
  commands: ContractCommand[];
};

const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as ContractCli;
const visibleContractNames = contract.commands.filter((c) => !c.hidden).map((c) => c.name);
// Every command in contract/cli.json (plus anything in src/cli.ts's commands table so a newly
// added command cannot escape before contract generation), excluding only the hidden stdin-RPC
// conformance-adapter protocol.
const allCommandNames = Array.from(
  new Set([
    ...contract.commands.filter((c) => c.name !== 'conformance-adapter').map((c) => c.name),
    ...Object.keys(commands),
  ]),
).sort();

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

describe('CLI cold-entry smoke test across every command', () => {
  test('contract/cli.json covers every command in src/cli.ts', () => {
    expect(visibleContractNames.length).toBeGreaterThan(0);
    expect(new Set(visibleContractNames)).toEqual(new Set(Object.keys(commands)));
  });

  test('every command in the contract loads cleanly through src/cli.ts with --help and --json --help', async () => {
    const cases = allCommandNames.flatMap((name) => [
      { name, args: [name, '--help'] },
      { name, args: [name, '--json', '--help'] },
    ]);

    const results = await mapConcurrent(cases, 16, async ({ name, args }) => ({
      name,
      args,
      ...(await runCli(args)),
    }));

    for (const { name, args, code, stdout, stderr } of results) {
      expect(stderr, `${args.join(' ')} stderr`).not.toContain('before initialization');
      expect(stderr, `${args.join(' ')} stderr`).not.toMatch(/^\s*at\s+/m);
      expect(stderr, `${args.join(' ')} stderr`).toBe('');
      expect(code, `${args.join(' ')} exit code`).toBe(0);
      expect(stdout.trim().length, `${args.join(' ')} stdout non-empty`).toBeGreaterThan(0);
      if (name !== 'help') {
        expect(stdout, `${args.join(' ')} usage header`).toMatch(new RegExp(`^Usage: team ${name}\\b`));
      }
    }
  });
});

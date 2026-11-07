// Inert registration boundary for the independent runtime tests. No process runner is imported:
// launchctl words are interpreted in memory, and the real service manager is never contacted.
import { readFileSync } from 'node:fs';
import { darwinServiceManager } from '../../src/daemon/service-darwin.ts';
import type { ServiceRunner } from '../../src/daemon/service.ts';

export function runtimeWords(text: string): string[] {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? '';
  return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(m => m[1]!
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));
}

export function inertRuntimeManager(home: string) {
  const calls: string[][] = [];
  let active: string[] | null = null;
  const runner: ServiceRunner = (command, args) => {
    if (command !== 'launchctl') throw new Error(`unexpected adapter command ${command}`);
    calls.push([...args]);
    if (args[0] === 'bootout') { active = null; return { status: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'bootstrap') {
      if (active !== null) return { status: 23, stdout: '', stderr: 'synthetic already registered' };
      const path = args[2];
      if (!path?.startsWith(`${home}/`)) throw new Error('unit left the owned home');
      active = runtimeWords(readFileSync(path, 'utf8'));
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected adapter verb ${String(args[0])}`);
  };
  const manager = darwinServiceManager({ runner, uid: process.getuid?.() ?? 0, accountHome: home, sleep: () => {}, now: () => new Date('2026-11-01T12:00:00Z') });
  return { manager, calls, active: () => active };
}

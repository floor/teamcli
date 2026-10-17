// The CLIs version 0.1 knows. A seat's `cli` picks one; `processes` are the names its process
// runs under, which the caller check looks for among a command's ancestors.
export type Profile = { cli: string; processes: string[] };

export const PROFILES: Profile[] = [
  { cli: 'claude-code', processes: ['claude'] },
  { cli: 'codex', processes: ['codex'] },
  { cli: 'cursor', processes: ['cursor-agent'] },
  { cli: 'grok', processes: ['grok'] },
  { cli: 'antigravity', processes: ['agy'] },
  { cli: 'gemini', processes: ['gemini'] },
  // `muse` execs `muse-bin-<version>-<build>`, and macOS cuts a process name to 15 bytes
  // (`muse-bin-1.4.9-`): the name is a prefix, spelled with a trailing `*`.
  { cli: 'muse', processes: ['muse', 'muse-bin-*'] },
];

export const CLIS: string[] = PROFILES.map((profile) => profile.cli);

export const CLI_PROCESSES: string[] = PROFILES.flatMap((profile) => profile.processes);

/** Whether a process name is one of `patterns`. A pattern is the exact name, or a prefix with a
 *  single trailing `*` for a CLI whose process name carries a version the OS may cut short. */
export function processNameMatches(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern));
}

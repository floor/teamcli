import { readFileSync } from 'node:fs';

function manifest(): { version: string; description: string; license: string; homepage: string } {
  const text = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  return JSON.parse(text) as { version: string; description: string; license: string; homepage: string };
}

// The one place the CLI's version is read. `--version` prints it and `team init` pins the
// schema URL's tag to it, so the URL can never name a release the CLI doesn't report.
export function version(): string {
  return manifest().version;
}

// The one place the CLI's opening sentence is read: `--help` prints it first, and
// scripts/check-readmes.ts holds it against the READMEs' first lines and the description
// itself, so the places cannot drift apart.
export function description(): string {
  return manifest().description;
}

export function license(): string {
  return manifest().license;
}

export function homepage(): string {
  return manifest().homepage;
}

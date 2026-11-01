import { defaultFs, type FsReader } from '../lobby/gate.ts';
import type { YamlNode } from '../yaml.ts';
import type { Problem } from './types.ts';

// A team file never holds a credential. A value with a known key prefix, a private key or a URL
// with credentials refuses the file. A long random-looking string only warns: channel ids and
// slugs look like one. An absolute path that is a real directory is a location, not a value —
// a machine's temp path is long, dotless and absolute — but the shape alone silences nothing:
// a credential in path clothing (`/x/sk-…`) is not a directory, so it still warns.
const KEY_PREFIXES = [
  'sk-', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'glpat-', 'xoxb-', 'xoxp-', 'xoxa-', 'xoxs-',
  'AKIA', 'ASIA', 'AIza', 'lin_api_', 'npm_', 'shpat_', 'dckr_pat_',
];

export function findSecrets(root: YamlNode, fs: FsReader = defaultFs): { refused: Problem[]; warned: Problem[] } {
  const refused: Problem[] = [];
  const warned: Problem[] = [];
  walk(root, (value, line) => {
    for (const word of value.split(/[\s"'=,;]+/)) {
      if (isKeyShaped(word)) {
        refused.push({ line, message: 'a value shaped like a key or token: a team file never holds a credential' });
        return;
      }
    }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) {
      refused.push({ line, message: 'a private key: a team file never holds a credential' });
    } else if (URL_CREDENTIALS.test(value)) {
      refused.push({ line, message: 'a URL with credentials: a team file never holds a credential' });
    } else if (value.split(/\s+/).some((word) => looksRandom(word, fs))) {
      warned.push({ line, message: 'a long random-looking value: check it is not a credential' });
    }
  });
  return { refused, warned };
}

const URL_CREDENTIALS = /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i;

function isKeyShaped(word: string): boolean {
  return KEY_PREFIXES.some((prefix) => word.startsWith(prefix) && word.length >= prefix.length + 16);
}

/**
 * The same judgement `findSecrets` makes, applied to a line of a seat's screen: every word shaped
 * like a key, every private-key header, every URL's userinfo and every random-looking word becomes
 * `[masked]`. One source of truth for both callers — a value the team-file check refuses or warns
 * about is a value a peek never prints. The randomness rule is shared as it is, including its
 * limits: `looksRandom` measures the entropy of the characters present, so a hex commit id cannot
 * clear its threshold and a UUID usually does not either.
 */
export function maskSecretsLine(line: string, fs: FsReader = defaultFs): string {
  let masked = line.replace(URL_CREDENTIALS, (match) => match.replace(/[^\s/:@]+:[^\s/@]+@$/, '[masked]@'));
  masked = masked.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '[masked]');
  masked = replaceWords(masked, (word) => isKeyShaped(word));
  masked = replaceWords(masked, (word) => looksRandom(word, fs));
  return masked;
}

/** Replaces the words `shaped` accepts, keeping each separator exactly as it was. */
function replaceWords(line: string, shaped: (word: string) => boolean): string {
  return line.replace(/(^|[\s"'=,;])([^\s"'=,;]+)/g, (whole, separator: string, word: string) =>
    shaped(word) ? `${separator}[masked]` : whole,
  );
}

function walk(node: YamlNode, visit: (value: string, line: number) => void): void {
  if (node.kind === 'scalar') {
    if (typeof node.value === 'string') visit(node.value, node.line);
  } else if (node.kind === 'seq') {
    for (const item of node.items) walk(item, visit);
  } else {
    for (const entry of node.entries) walk(entry.value, visit);
  }
}

function looksRandom(word: string, fs: FsReader): boolean {
  if (word.length < 32 || (isAbsolutePath(word) && isDirectory(fs, word)) || !/^[A-Za-z0-9+/_=-]+$/.test(word)) return false;
  const counts = new Map<string, number>();
  for (const c of word) counts.set(c, (counts.get(c) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) entropy -= (count / word.length) * Math.log2(count / word.length);
  return entropy > 4;
}

/**
 * Two or more path segments, starting at the root. The shape alone exempts nothing: it only names
 * the words worth an lstat, and only a real directory is a location rather than a value.
 */
function isAbsolutePath(word: string): boolean {
  return /^\/[^/]+\//.test(word);
}

/** Fail closed: only a successful lstat that says directory exempts. Absence, a file, any error warns. */
function isDirectory(fs: FsReader, word: string): boolean {
  try {
    return fs.lstat(word).isDirectory();
  } catch {
    return false;
  }
}

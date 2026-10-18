// The packed package is what a user runs. `files` ships dist/, examples/, schema/, README.md and
// LICENSE, and npm always packs package.json. A path src/ reads at runtime that resolves outside
// that set works in a clone and fails when installed: the trust-answer path read
// test/fixtures/conformance.json exactly that way, and a packed build died on it with ENOENT.
//
// This walks every src/ module, blanks the comments, and checks the shapes that read a file beside
// the module: `new URL(spec, import.meta.url)`, a join on `__dirname` / `import.meta.dir` /
// `dirname(fileURLToPath(import.meta.url))`, and a read call handed a literal path. A path under
// src/ counts as shipped because tsc emits every module (and the build copies src/profiles' YAML
// and JSON); examples/ and schema/ ship as they are. Absolute paths (`/dev`, `/proc/<pid>`) are
// the machine's, not the package's, and are not judged.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(root, 'src');

/** Every .ts module under a directory, sorted. */
function modules(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...modules(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * The text with comments blanked — same length, newlines kept — and strings untouched, so a `//`
 * inside a string is text and a commented-out read is not a read.
 */
function withoutComments(text: string): string {
  const out: string[] = [];
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let at = from; at < to; at++) out.push(text[at] === '\n' ? '\n' : ' ');
  };
  while (i < text.length) {
    const char = text[i]!;
    if (char === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (char === "'" || char === '"' || char === '`') {
      let at = i + 1;
      while (at < text.length) {
        if (text[at] === '\\') {
          at += 2;
          continue;
        }
        if (text[at] === char) {
          at++;
          break;
        }
        at++;
      }
      out.push(text.slice(i, at));
      i = at;
    } else {
      out.push(char);
      i++;
    }
  }
  return out.join('');
}

/** The argument text of the call whose `(` sits at `open`, or null when it never closes. */
function callArguments(text: string, open: number): string | null {
  let depth = 0;
  for (let at = open; at < text.length; at++) {
    const char = text[at]!;
    if (char === "'" || char === '"' || char === '`') {
      at++;
      while (at < text.length) {
        if (text[at] === '\\') {
          at += 2;
          continue;
        }
        if (text[at] === char) break;
        at++;
      }
      continue;
    }
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return text.slice(open + 1, at);
    }
  }
  return null;
}

/** Every string literal in a piece of source, unescaped; template `${...}` stays as text. */
function literalsIn(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (char !== "'" && char !== '"' && char !== '`') {
      i++;
      continue;
    }
    let at = i + 1;
    let value = '';
    while (at < text.length) {
      const current = text[at]!;
      if (current === '\\') {
        value += text[at + 1] ?? '';
        at += 2;
        continue;
      }
      if (current === char) break;
      value += current;
      at++;
    }
    out.push(value);
    i = at + 1;
  }
  return out;
}

/** Whether a resolved path is one npm packs: package.json always, then `files` as it is laid out. */
function packed(target: string): boolean {
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  const parts = rel.split(sep);
  const first = parts[0] ?? '';
  if (first === 'package.json' || first === 'README.md' || first === 'LICENSE') return parts.length === 1;
  if (first === 'examples' || first === 'schema') return true;
  if (first !== 'src') return false;
  // tsc emits every module under src/; the build copies the data files in src/profiles only.
  if (rel.endsWith('.ts')) return true;
  try {
    if (statSync(target).isDirectory()) return true;
  } catch {
    // A missing directory says nothing; the shape rules below still decide.
  }
  return parts[1] === 'profiles' && (rel.endsWith('.yaml') || rel.endsWith('.json'));
}

/** Whether a literal names a path from where it sits (`./`, `../`), rather than a bare segment
 *  such as a file name a join appends after a dynamic one, or one branch of a ternary. */
function fromHere(literal: string): boolean {
  return literal.startsWith('./') || literal.startsWith('../');
}

const MODULE_URL = /new\s+URL\s*\(\s*(['"`])([\s\S]*?)\1\s*,\s*import\.meta\.url\s*\)/g;
const READ_CALL = /\b(?:readFileSync|readFile|openSync|createReadStream|readdirSync|statSync|lstatSync|existsSync|Bun\.file)\s*\(\s*(['"`])([^'"`]*)\1/g;
const JOIN_CALL = /\b(?:join|resolve)\s*\(/g;
const URL_BINDING = /const\s+([A-Za-z_$][\w$]*)\s*=\s*fileURLToPath\s*\(\s*import\.meta\.url\s*\)/g;

/** Every package-relative read in one module that resolves outside the packed set. */
export function problemsIn(file: string, source: string): string[] {
  const text = withoutComments(source);
  const from = dirname(file);
  const problems: string[] = [];
  const complain = (shape: string, target: string): void => {
    problems.push(`${relative(root, file)}: ${shape} resolves to ${relative(root, target)}, which the package does not ship`);
  };

  for (const match of text.matchAll(MODULE_URL)) {
    const spec = (match[2] ?? '').replace(/\$\{[^}]*\}/g, 'X');
    const target = resolve(from, spec);
    if (!packed(target)) complain(`new URL("${spec}", import.meta.url)`, target);
  }

  const bound = [...text.matchAll(URL_BINDING)].map((match) => match[1] ?? '').filter((name) => name !== '');
  for (const match of text.matchAll(JOIN_CALL)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const args = callArguments(text, open);
    if (args === null) continue;
    const beside = args.includes('__dirname') || args.includes('import.meta.dir')
      || bound.some((name) => new RegExp(`dirname\\(\\s*${name}\\s*\\)`).test(args));
    if (!beside) continue;
    for (const literal of literalsIn(args)) {
      // A bare segment names no path of its own: a join appends it after the dynamic part, and a
      // ternary's other branch never runs.
      if (!fromHere(literal)) continue;
      const target = resolve(from, literal);
      if (!packed(target)) complain(`${match[0]!.slice(0, -1).trim()}("${literal}")`, target);
    }
  }

  for (const match of text.matchAll(READ_CALL)) {
    const literal = match[2] ?? '';
    if (literal === '' || isAbsolute(literal)) continue;
    // A bare file name is read from the working directory, not beside the module; only a path
    // (`./`, `../`, or a folder-qualified name) can be a package read. A template that opens with
    // `${` names a runtime root (`/proc`, a home), not a path beside the module.
    if (literal.startsWith('${')) continue;
    if (!fromHere(literal) && !literal.includes('/')) continue;
    const target = resolve(from, literal);
    if (!packed(target)) complain(`read of "${literal}"`, target);
  }
  return problems;
}

test('every package-relative path src/ reads at runtime is in the packed files', () => {
  const problems = modules(srcDir).flatMap((file) => problemsIn(file, readFileSync(file, 'utf8')));
  expect(problems).toEqual([]);
});

test('the guard catches the trust-answer manifest read and passes a shipped sibling read', () => {
  const file = join(srcDir, 'profiles', 'trust-answer.ts');
  const old = "readFileSync(fileURLToPath(new URL('../../test/fixtures/conformance.json', import.meta.url)), 'utf8');";
  expect(problemsIn(file, old).join('\n')).toContain('test/fixtures/conformance.json');
  const sibling = "readFileSync(new URL('./efforts.json', import.meta.url), 'utf8');";
  expect(problemsIn(file, sibling)).toEqual([]);
  const comment = "// readFileSync(new URL('../../test/fixtures/conformance.json', import.meta.url))\nconst x = 1;\n";
  expect(problemsIn(file, comment)).toEqual([]);
});

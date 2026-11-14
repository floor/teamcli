// The entity's projects root, named in a team file by one word: `{root}`. Each entity has one
// projects root per machine — the folder its repositories sit directly under — and the machine's
// own entities file says where it is (`<entity>: { root: <folder> }`, read by
// `entityProjectsRoot` in src/entities.ts). A team file that writes `{root}/docs/…` in place of a
// machine's full path reads the same on every machine: the word is filled with this machine's
// folder when the file is read, in every value the file writes — a launch line, a rule, a seat's
// folder, a trust path, a brief — and nowhere in a key.
//
// The word follows the launch line's `{secret:<entry>}` precedent (src/launch/secret-words.ts):
// braces, which no shell reads as anything on their own. `${root}` is the shell's own variable
// and is left alone. A file that writes the word on a machine whose entity names no root is
// refused when it is read, with the command that sets one: a launch never runs a literal
// `{root}` path. A file that does not write the word is read exactly as before, and the entities
// file is not even opened for it.
import { entityProjectsRoot, entitiesPath } from '../entities.ts';
import { parseYaml, toValue, YamlError, type YamlNode, type YamlValue } from '../yaml.ts';
import type { Problem } from './types.ts';

/** The word, as a team file writes it. */
export const ROOT_WORD = '{root}';

/** Every place the word stands: not after a `$`, which makes it the shell's `${root}`. */
const WORD = /(?<!\$)\{root\}/g;

/** Whether a text writes the word. */
export function hasRootWord(text: string): boolean {
  WORD.lastIndex = 0;
  return WORD.test(text);
}

/** The text with every root word filled with `root`. A text without the word comes back as is. */
export function fillRootWord(text: string, root: string): string {
  return text.replace(WORD, () => root);
}

type StringScalar = Extract<YamlNode, { kind: 'scalar' }> & { value: string };

/** Every string value in the tree, in the order the file writes them, with the keys above it. */
function stringScalars(node: YamlNode, field: readonly string[] = [], out: Array<{ node: StringScalar; field: readonly string[] }> = []) {
  if (node.kind === 'scalar') {
    if (typeof node.value === 'string') out.push({ node: node as StringScalar, field });
  } else if (node.kind === 'seq') {
    node.items.forEach((item, index) => stringScalars(item, [...field, String(index)], out));
  } else {
    for (const entry of node.entries) stringScalars(entry.value, [...field, entry.key], out);
  }
  return out;
}

/** The file's own `entity:` word, read before any value is filled. */
function entityOf(root: YamlNode): string | null {
  if (root.kind !== 'map') return null;
  const field = root.entries.find((entry) => entry.key === 'entity');
  return field !== undefined && field.value.kind === 'scalar' && typeof field.value.value === 'string' && field.value.value.trim() !== ''
    ? field.value.value.trim()
    : null;
}

/** The command that sets the root, in the words a refusal names. */
export function setRootCommand(entity: string): string {
  return `team config set ${entity}.root <folder>`;
}

/**
 * Fills every root word in a parsed team file, in place, with the entity's projects root at
 * `home`, before any section reads the file. Returns the problems that keep the word from being
 * filled — the file names no entity, the entity's root word does not read, or it names none on
 * this machine — on the first line that writes the word; the tree is then left unfilled and the
 * file does not validate. A file with no root word returns no problem and reads nothing.
 */
export function fillRootWords(tree: YamlNode, home: string): Problem[] {
  const holding = stringScalars(tree).filter(({ node }) => hasRootWord(node.value));
  if (holding.length === 0 || tree.kind !== 'map') return [];
  const line = holding[0]!.node.line;
  const entity = entityOf(tree);
  if (entity === null) {
    return [{ line, message: `the file writes ${ROOT_WORD}, and names no entity: ${ROOT_WORD} is an entity's projects root, so the file needs \`entity:\`` }];
  }
  const read = entityProjectsRoot(home, entity);
  if (!read.ok) return [{ line, message: `${ROOT_WORD} cannot be filled: ${read.why} (${entitiesPath(home)})` }];
  if (read.root === null) {
    return [{ line, message: `the file writes ${ROOT_WORD}, and entity "${entity}" names no projects root on this machine: run \`${setRootCommand(entity)}\`` }];
  }
  for (const { node } of holding) {
    node.value = fillRootWord(node.value, read.root);
    node.raw = fillRootWord(node.raw, read.root);
  }
  return [];
}

/**
 * An entity's or project's rules (the owner's entities and projects files) with the word filled
 * with the entity's projects root at `home`. These rules are not a team file's and are not
 * validated with one, so a rule that writes the word where no root is named keeps it as written,
 * and `team doctor` names it (`rootWordFindings` in src/commands/doctor.ts). Rules without the word come back as they are.
 */
export function filledRules(rules: string[], home: string | undefined, entity: string | null): string[] {
  if (home === undefined || entity === null || !rules.some(hasRootWord)) return rules;
  const read = entityProjectsRoot(home, entity);
  if (!read.ok || read.root === null) return rules;
  const root = read.root;
  return rules.map((rule) => fillRootWord(rule, root));
}

/** Escapes a text for a regular expression. */
function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The ways a file can write the entity's projects root in full on this machine: the absolute path,
 * and the `~/…` and `$HOME/…` forms when it sits under the home. A form matches only as a whole
 * path: the next character ends the path or starts a segment, and the one before does not belong
 * to a longer path. A path into a hidden folder of the root (`~/.config/…` where the root is the
 * home itself, as on an entity's own server account) is the machine's, not a project's, and is
 * never read as inside the root: `{root}/.config` would name another folder on a machine whose
 * root is not its home.
 */
function rootForms(root: string, home: string): RegExp {
  const forms = [escaped(root)];
  const homeless = home.replace(/\/+$/, '');
  if (root === homeless || root.startsWith(`${homeless}/`)) {
    const rest = root.slice(homeless.length);
    forms.push(`~${escaped(rest)}`, `\\$HOME${escaped(rest)}`, `\\$\\{HOME\\}${escaped(rest)}`);
  }
  return new RegExp(`(?<![A-Za-z0-9_.~/$-])(?:${forms.join('|')})(?!/\\.)(?=$|[/\\s"'\`,;:)\\]}])`, 'g');
}

/** One value that writes the projects root in full. */
export type RootPathUse = { line: number; field: string; written: string };

/** The entity's root on this machine, or why there is nothing to compare against. */
function rootOn(home: string, entity: string | null): { ok: true; root: string; entity: string } | { ok: false; why: string } {
  if (entity === null) return { ok: false, why: `the team names no entity: ${ROOT_WORD} is an entity's projects root` };
  const read = entityProjectsRoot(home, entity);
  if (!read.ok) return { ok: false, why: read.why };
  if (read.root === null) return { ok: false, why: `entity "${entity}" names no projects root on this machine: run \`${setRootCommand(entity)}\`` };
  return { ok: true, root: read.root, entity };
}

/**
 * Every value of a team's text that writes this machine's projects root in full, where `{root}`
 * would read the same here and also on every other machine. Empty when the text does not parse,
 * the team names no entity, or the entity names no root: there is then no root to compare with.
 */
export function rootPathUses(text: string, home: string): RootPathUse[] {
  let tree: YamlNode;
  try {
    tree = parseYaml(text);
  } catch {
    return [];
  }
  const on = rootOn(home, entityOf(tree));
  if (!on.ok) return [];
  const forms = rootForms(on.root, home);
  const uses: RootPathUse[] = [];
  for (const { node, field } of stringScalars(tree)) {
    forms.lastIndex = 0;
    const match = forms.exec(node.value);
    if (match !== null) uses.push({ line: node.line, field: field.join('.'), written: match[0] });
  }
  return uses;
}

/** The doctor's words on one use. */
export function rootPathWarning(use: RootPathUse): string {
  return `${use.field} writes ${use.written}, the entity's projects root on this machine: write ${ROOT_WORD} in its place so the file reads the same on every machine (\`team migrate --root\` shows the rewrite)`;
}

/** One changed line of a rewrite. */
export type RootRewriteLine = { line: number; before: string; after: string };

/** A rewrite of a team's text, or why it cannot be made. */
export type RootRewrite =
  | { ok: true; text: string; changes: RootRewriteLine[]; root: string; entity: string }
  | { ok: false; why: string };

/** A value as one quoted YAML word: single quotes when it holds none, else double quotes. */
function quotedWord(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The value tree with every full root path in a string value written as the word. */
function rewrittenValue(value: YamlValue, forms: RegExp): YamlValue {
  if (typeof value === 'string') return value.replace(forms, ROOT_WORD);
  if (Array.isArray(value)) return value.map((item) => rewrittenValue(item, forms));
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: YamlValue } = {};
    for (const [key, item] of Object.entries(value)) out[key] = rewrittenValue(item, forms);
    return out;
  }
  return value;
}

/**
 * The team's text with every full projects-root path in a value rewritten as `{root}`, line by
 * line, so every comment, key and other value stays byte for byte. A value that would start with
 * the word is quoted, because YAML would read an unquoted `{` as a map. The rewrite is checked by
 * reading it back: it must parse to the same values with only those paths changed, else it is
 * refused and nothing is offered. Nothing is written here.
 */
export function planRootRewrite(text: string, home: string): RootRewrite {
  let tree: YamlNode;
  try {
    tree = parseYaml(text);
  } catch (error) {
    return { ok: false, why: `the team's text does not parse: ${error instanceof YamlError ? `line ${error.line}: ${error.message}` : String(error)}` };
  }
  const on = rootOn(home, entityOf(tree));
  if (!on.ok) return on;
  const forms = rootForms(on.root, home);
  const wanted = JSON.stringify(rewrittenValue(toValue(tree), forms));
  const attempt = (quoteAll: boolean): string | null => {
    const lines = text.split('\n');
    const cursor = new Map<number, number>();
    for (const { node } of stringScalars(tree)) {
      forms.lastIndex = 0;
      if (!forms.test(node.value)) continue;
      const index = node.line - 1;
      const line = lines[index];
      if (line === undefined) return null;
      const from = cursor.get(index) ?? 0;
      const at = line.indexOf(node.raw, from);
      if (at < 0) return null;
      let raw: string;
      if (node.quoted) {
        raw = node.raw.replace(forms, ROOT_WORD);
      } else {
        const plain = node.raw.replace(forms, ROOT_WORD);
        raw = quoteAll || plain.startsWith('{') ? quotedWord(node.value.replace(forms, ROOT_WORD)) : plain;
      }
      lines[index] = line.slice(0, at) + raw + line.slice(at + node.raw.length);
      cursor.set(index, at + raw.length);
    }
    const next = lines.join('\n');
    try {
      return JSON.stringify(toValue(parseYaml(next))) === wanted ? next : null;
    } catch {
      return null;
    }
  };
  const next = attempt(false) ?? attempt(true);
  if (next === null) return { ok: false, why: 'the rewrite does not read back as the same team with only its root paths changed: write {root} by hand' };
  const before = text.split('\n');
  const after = next.split('\n');
  const changes: RootRewriteLine[] = [];
  for (let i = 0; i < before.length; i += 1) {
    if (before[i] !== after[i]) changes.push({ line: i + 1, before: before[i] as string, after: after[i] as string });
  }
  return { ok: true, text: next, changes, root: on.root, entity: on.entity };
}

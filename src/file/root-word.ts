// The entity's folders, named in a team file by two words: `{root}` and `{worktrees}`. Each entity
// has one projects root per machine — the folder its repositories sit directly under — and one
// folder its worktrees sit in, `<root>/worktrees` unless the entry names another (a server keeps
// `~/worktrees` beside `~/repos`). The machine's own entities file says where both are
// (`<entity>: { root: <folder>, worktrees: <folder> }`, read by `entityFolders` in
// src/entities.ts). A team file that writes `{root}/docs/…` or `{worktrees}/site/…` in place of a
// machine's full path reads the same on every machine: the words are filled with this machine's
// folders when the file is read, in every value the file writes — a launch line, a rule, a seat's
// folder, a trust path, a brief — and nowhere in a key.
//
// The words follow the launch line's `{secret:<entry>}` precedent (src/launch/secret-words.ts):
// braces, which no shell reads as anything on their own. `${root}` and `${worktrees}` are the
// shell's own variables and are left alone. A file that writes a word on a machine whose entity
// names no such folder is refused when it is read, with the command that sets one: a launch never
// runs a literal `{root}` path. A file that writes neither word is read exactly as before, and the
// entities file is not even opened for it.
import { entityFolders, entitiesPath, type EntityFolders } from '../entities.ts';
import { parseYaml, toValue, YamlError, type YamlNode, type YamlValue } from '../yaml.ts';
import type { Problem } from './types.ts';

/** The projects root's word, as a team file writes it. */
export const ROOT_WORD = '{root}';

/** The worktrees folder's word, as a team file writes it. */
export const WORKTREES_WORD = '{worktrees}';

/** Every place a word stands: not after a `$`, which makes it the shell's `${root}`. */
const WORD = /(?<!\$)\{(root|worktrees)\}/g;

/** Whether a text writes either word. */
export function hasRootWord(text: string): boolean {
  WORD.lastIndex = 0;
  return WORD.test(text);
}

/** The words a text writes, each once. */
function wordsIn(text: string): Array<'root' | 'worktrees'> {
  const found = new Set<'root' | 'worktrees'>();
  for (const match of text.matchAll(WORD)) found.add(match[1] as 'root' | 'worktrees');
  return [...found];
}

/** The text with every root word filled with `root`; `{worktrees}` is left as it is. */
export function fillRootWord(text: string, root: string): string {
  return text.replace(WORD, (word, name: string) => (name === 'root' ? root : word));
}

/** The folders a word is filled with: null for one this machine does not name. */
export type FolderWords = { root: string | null; worktrees: string | null };

/** The text with every word filled from `folders`; a word with no folder is left as written. */
export function fillFolderWords(text: string, folders: FolderWords): string {
  return text.replace(WORD, (word, name: 'root' | 'worktrees') => folders[name] ?? word);
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

/** Why `word` cannot be filled for `entity` here, in the words a refusal names. */
function unnamed(word: 'root' | 'worktrees', entity: string): string {
  return word === 'root'
    ? `entity "${entity}" names no projects root on this machine: run \`${setRootCommand(entity)}\``
    : `entity "${entity}" names no worktrees folder on this machine, nor a projects root it would sit under: run \`team config set ${entity}.worktrees <folder>\` or \`${setRootCommand(entity)}\``;
}

/**
 * Fills every word in a parsed team file, in place, with the entity's folders at `home`, before
 * any section reads the file. Returns the problems that keep a word from being filled — the file
 * names no entity, the entity's folder word does not read, or it names no such folder on this
 * machine — on the first line that writes the word; the tree is then left unfilled and the file
 * does not validate. A file with no word returns no problem and reads nothing.
 */
export function fillRootWords(tree: YamlNode, home: string): Problem[] {
  const holding = stringScalars(tree).filter(({ node }) => hasRootWord(node.value));
  if (holding.length === 0 || tree.kind !== 'map') return [];
  const line = holding[0]!.node.line;
  const entity = entityOf(tree);
  if (entity === null) {
    return [{ line, message: `the file writes ${ROOT_WORD} or ${WORKTREES_WORD}, and names no entity: each is a folder of an entity, so the file needs \`entity:\`` }];
  }
  const read = entityFolders(home, entity);
  if (!read.ok) return [{ line, message: `${ROOT_WORD} cannot be filled: ${read.why} (${entitiesPath(home)})` }];
  for (const { node } of holding) {
    const missing = wordsIn(node.value).find((word) => read[word] === null);
    if (missing !== undefined) return [{ line: node.line, message: `the file writes {${missing}}, and ${unnamed(missing, entity)}` }];
  }
  for (const { node } of holding) {
    node.value = fillFolderWords(node.value, read);
    node.raw = fillFolderWords(node.raw, read);
  }
  return [];
}

/**
 * An entity's or project's rules (the owner's entities and projects files) with the words filled
 * with the entity's folders at `home`. These rules are not a team file's and are not validated
 * with one, so a rule that writes a word where no folder is named keeps it as written, and
 * `team doctor` names it (`rootWordFindings` in src/commands/doctor.ts). Rules without a word
 * come back as they are.
 */
export function filledRules(rules: string[], home: string | undefined, entity: string | null): string[] {
  if (home === undefined || entity === null || !rules.some(hasRootWord)) return rules;
  const read = entityFolders(home, entity);
  if (!read.ok) return rules;
  return rules.map((rule) => fillFolderWords(rule, read));
}

/**
 * A path-valued setting outside a team file (the `vault-root` policy) with its words filled: the
 * path, or why it cannot be — a word the entity names no folder for, the same refusal a team file
 * gets. A value with no word comes back as it is.
 */
export function filledPath(value: string, home: string, entity: string | null): { ok: true; path: string } | { ok: false; why: string } {
  if (!hasRootWord(value)) return { ok: true, path: value };
  if (entity === null) return { ok: false, why: `${value} names a folder of an entity, and no entity is named` };
  const read = entityFolders(home, entity);
  if (!read.ok) return { ok: false, why: read.why };
  const missing = wordsIn(value).find((word) => read[word] === null);
  if (missing !== undefined) return { ok: false, why: unnamed(missing, entity) };
  return { ok: true, path: fillFolderWords(value, read) };
}

/** Escapes a text for a regular expression. */
function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The spellings of the entity's folders, and the word each one stands for. */
type Forms = { pattern: RegExp; wordOf: Map<string, string> };

/**
 * The ways a file can write the entity's folders in full on this machine, each with the word it
 * stands for: the absolute path, and the `~/…` and `$HOME/…` forms when it sits under the home.
 * The worktrees folder comes first, so a worktree path under the root (`~/Code/acme/worktrees/…`)
 * is written as `{worktrees}/…`. A form matches only as a whole path: the next character ends the
 * path or starts a segment, and the one before does not belong to a longer path. A path into a
 * hidden folder of a folder is never read as inside it: with a root under the home (`~/Code/acme`,
 * `~/repos`) the home's `~/.config/…` is outside the root anyway, and an owner who sets the root
 * to the home itself would otherwise see `~/.config/…` rewritten as `{root}/.config/…`, another
 * folder on every machine whose root is not its home.
 */
function folderForms(folders: FolderWords, home: string): Forms | null {
  const homeless = home.replace(/\/+$/, '');
  const wordOf = new Map<string, string>();
  const ordered: Array<[string, string]> = [];
  if (folders.worktrees !== null) ordered.push([folders.worktrees, WORKTREES_WORD]);
  if (folders.root !== null) ordered.push([folders.root, ROOT_WORD]);
  if (ordered.length === 0) return null;
  const literals: string[] = [];
  for (const [folder, word] of ordered) {
    const spelled = [folder];
    if (folder === homeless || folder.startsWith(`${homeless}/`)) {
      const rest = folder.slice(homeless.length);
      spelled.push(`~${rest}`, `$HOME${rest}`, `\${HOME}${rest}`);
    }
    for (const literal of spelled) {
      if (wordOf.has(literal)) continue;
      wordOf.set(literal, word);
      literals.push(literal);
    }
  }
  // The longest spelling first, so a folder inside another is matched as itself.
  literals.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(?<![A-Za-z0-9_.~/$-])(?:${literals.map(escaped).join('|')})(?!/\\.)(?=$|[/\\s"'\`,;:)\\]}])`, 'g');
  return { pattern, wordOf };
}

/** A text with every full folder path written as its word. */
function withWords(text: string, forms: Forms): string {
  return text.replace(forms.pattern, (literal) => forms.wordOf.get(literal) ?? literal);
}

/** One value that writes one of the entity's folders in full. */
export type RootPathUse = { line: number; field: string; written: string; word: string };

/** The entity's folders on this machine, or why there is nothing to compare against. */
function foldersOn(home: string, entity: string | null): { ok: true; folders: FolderWords; entity: string; read: EntityFolders & { ok: true } } | { ok: false; why: string } {
  if (entity === null) return { ok: false, why: `the team names no entity: ${ROOT_WORD} is an entity's projects root` };
  const read = entityFolders(home, entity);
  if (!read.ok) return { ok: false, why: read.why };
  if (read.root === null && read.worktrees === null) return { ok: false, why: unnamed('root', entity) };
  return { ok: true, folders: { root: read.root, worktrees: read.worktrees }, entity, read };
}

/**
 * Every value of a team's text that writes one of this machine's folders of its entity in full,
 * where the word would read the same here and also on every other machine. Empty when the text
 * does not parse, the team names no entity, or the entity names no folder: there is then nothing
 * to compare with.
 */
export function rootPathUses(text: string, home: string): RootPathUse[] {
  let tree: YamlNode;
  try {
    tree = parseYaml(text);
  } catch {
    return [];
  }
  const on = foldersOn(home, entityOf(tree));
  if (!on.ok) return [];
  const forms = folderForms(on.folders, home);
  if (forms === null) return [];
  const uses: RootPathUse[] = [];
  for (const { node, field } of stringScalars(tree)) {
    forms.pattern.lastIndex = 0;
    const match = forms.pattern.exec(node.value);
    if (match !== null) uses.push({ line: node.line, field: field.join('.'), written: match[0], word: forms.wordOf.get(match[0]) ?? ROOT_WORD });
  }
  return uses;
}

/** The doctor's words on one use. */
export function rootPathWarning(use: RootPathUse): string {
  const what = use.word === WORKTREES_WORD ? "the entity's worktrees folder" : "the entity's projects root";
  return `${use.field} writes ${use.written}, ${what} on this machine: write ${use.word} in its place so the file reads the same on every machine (\`team migrate --root\` shows the rewrite)`;
}

/** One changed line of a rewrite. */
export type RootRewriteLine = { line: number; before: string; after: string };

/** A rewrite of a team's text, or why it cannot be made. */
export type RootRewrite =
  | { ok: true; text: string; changes: RootRewriteLine[]; root: string | null; worktrees: string | null; entity: string }
  | { ok: false; why: string };

/** A value as one quoted YAML word: single quotes when it holds none, else double quotes. */
function quotedWord(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The team's text with every full folder path in a value rewritten as `{root}` or `{worktrees}`,
 * line by line, so every comment, key and other value stays byte for byte. `lines`, when given,
 * limits the rewrite to the values those lines write. A value that would start with a word is
 * quoted, because YAML would read an unquoted `{` as a map. The rewrite is checked by reading it
 * back: it must parse to the same values with only those paths changed, else it is refused and
 * nothing is offered. Nothing is written here.
 */
export function planRootRewrite(text: string, home: string, lines?: ReadonlySet<number>): RootRewrite {
  let tree: YamlNode;
  let expected: YamlNode;
  try {
    tree = parseYaml(text);
    expected = parseYaml(text);
  } catch (error) {
    return { ok: false, why: `the team's text does not parse: ${error instanceof YamlError ? `line ${error.line}: ${error.message}` : String(error)}` };
  }
  const on = foldersOn(home, entityOf(tree));
  if (!on.ok) return on;
  const forms = folderForms(on.folders, home);
  if (forms === null) return { ok: false, why: unnamed('root', on.entity) };
  const chosen = (node: StringScalar): boolean => {
    if (lines !== undefined && !lines.has(node.line)) return false;
    forms.pattern.lastIndex = 0;
    return forms.pattern.test(node.value);
  };
  // What the rewrite must read back as: the same tree, with only the chosen values rewritten.
  const want = stringScalars(expected);
  stringScalars(tree).forEach(({ node }, index) => {
    if (chosen(node)) want[index]!.node.value = withWords(node.value, forms);
  });
  const wanted = JSON.stringify(toValue(expected));
  const attempt = (quoteAll: boolean): string | null => {
    const out = text.split('\n');
    const cursor = new Map<number, number>();
    for (const { node } of stringScalars(tree)) {
      if (!chosen(node)) continue;
      const index = node.line - 1;
      const line = out[index];
      if (line === undefined) return null;
      const from = cursor.get(index) ?? 0;
      const at = line.indexOf(node.raw, from);
      if (at < 0) return null;
      let raw: string;
      if (node.quoted) {
        raw = withWords(node.raw, forms);
      } else {
        const plain = withWords(node.raw, forms);
        raw = quoteAll || plain.startsWith('{') ? quotedWord(withWords(node.value, forms)) : plain;
      }
      out[index] = line.slice(0, at) + raw + line.slice(at + node.raw.length);
      cursor.set(index, at + raw.length);
    }
    const next = out.join('\n');
    try {
      return JSON.stringify(toValue(parseYaml(next))) === wanted ? next : null;
    } catch {
      return null;
    }
  };
  const next = attempt(false) ?? attempt(true);
  if (next === null) return { ok: false, why: 'the rewrite does not read back as the same team with only its folder paths changed: write {root} by hand' };
  const before = text.split('\n');
  const after = next.split('\n');
  const changes: RootRewriteLine[] = [];
  for (let i = 0; i < before.length; i += 1) {
    if (before[i] !== after[i]) changes.push({ line: i + 1, before: before[i] as string, after: after[i] as string });
  }
  return { ok: true, text: next, changes, root: on.folders.root, worktrees: on.folders.worktrees, entity: on.entity };
}

/**
 * The text an editor writes back with the words kept: in each line the edit added or changed, a
 * full path inside one of the entity's folders on this machine is written as `{root}/…` or
 * `{worktrees}/…` again, so a value an editor built from the team as read (where every word was
 * already filled) does not bake this machine's path into the record. Lines the edit left alone
 * are not touched, and a text that cannot be rewritten that way is returned as the editor made it.
 */
export function keptRootWords(before: string, after: string, home: string): string {
  if (before === after) return after;
  const left = new Map<string, number>();
  for (const line of before.split('\n')) left.set(line, (left.get(line) ?? 0) + 1);
  const changed = new Set<number>();
  after.split('\n').forEach((line, index) => {
    const count = left.get(line) ?? 0;
    if (count > 0) left.set(line, count - 1);
    else changed.add(index + 1);
  });
  if (changed.size === 0) return after;
  const plan = planRootRewrite(after, home, changed);
  return plan.ok ? plan.text : after;
}

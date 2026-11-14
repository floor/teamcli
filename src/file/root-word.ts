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
// The entities file is not signed, and any process of the owner's account can write it. So a
// folder is bound to the owner's signature where there is one: it is filled with its real path
// (every link resolved), and on a machine with a signed charter that real path must lie inside
// one of the charter's roots, or the file is refused. A machine with no charter fills the folder
// as written, and `team doctor` says the folders are bound to no signature there.
//
// The words follow the launch line's `{secret:<entry>}` precedent (src/launch/secret-words.ts):
// braces, which no shell reads as anything on their own. `${root}` and `${worktrees}` are the
// shell's own variables and are left alone. A folder holds no character a shell reads
// (`checkedRootPath`), so a filled launch line runs what it says. A file that writes a word on a
// machine whose entity names no such folder is refused when it is read, with the command that
// sets one: a launch never runs a literal `{root}` path. `team down` and `team status` read a
// team without filling what cannot be filled, so a team whose folder was removed can still be
// stopped. A file that writes neither word is read exactly as before.
import { boundRoot, pathInsideRoot } from '../charter/body.ts';
import { readCharter, type CharterRead } from '../charter/store.ts';
import type { OwnerSeatKeyStore } from '../client/owner-seat.ts';
import { canonicalFolder, entityFolders, entityRules, entitiesPath } from '../entities.ts';
import { projectRules } from '../registry/projects.ts';
import { parseYaml, toValue, YamlError, type YamlNode } from '../yaml.ts';
import type { Problem } from './types.ts';

/** The projects root's word, as a team file writes it. */
export const ROOT_WORD = '{root}';

/** The worktrees folder's word, as a team file writes it. */
export const WORKTREES_WORD = '{worktrees}';

type Word = 'root' | 'worktrees';

/** Every place a word stands: not after a `$`, which makes it the shell's `${root}`. */
const WORD = /(?<!\$)\{(root|worktrees)\}/g;

/** The same words, for a yes-or-no test: no `lastIndex` carried from one call to the next. */
const ANY_WORD = /(?<!\$)\{(root|worktrees)\}/;

/** Whether a text writes either word. */
export function hasRootWord(text: string): boolean {
  return ANY_WORD.test(text);
}

/** The words a text writes, each once. */
function wordsIn(text: string): Word[] {
  const found = new Set<Word>();
  // `matchAll` copies the pattern's `lastIndex`: a fresh pattern starts at the text's beginning.
  for (const match of text.matchAll(new RegExp(WORD.source, 'g'))) found.add(match[1] as Word);
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
  return text.replace(WORD, (word, name: Word) => folders[name] ?? word);
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

/** A top-level word of the file, read before any value is filled. */
function topWord(root: YamlNode, key: string): string | null {
  if (root.kind !== 'map') return null;
  const field = root.entries.find((entry) => entry.key === key);
  return field !== undefined && field.value.kind === 'scalar' && typeof field.value.value === 'string' && field.value.value.trim() !== ''
    ? field.value.value.trim()
    : null;
}

/** The command that sets the root, in the words a refusal names. */
export function setRootCommand(entity: string): string {
  return `team config set ${entity}.root <folder>`;
}

/** Why `word` cannot be filled for `entity` here, in the words a refusal names. */
function unnamed(word: Word, entity: string): string {
  return word === 'root'
    ? `entity "${entity}" names no projects root on this machine: run \`${setRootCommand(entity)}\``
    : `entity "${entity}" names no worktrees folder on this machine, nor a projects root it would sit under: run \`team config set ${entity}.worktrees <folder>\` or \`${setRootCommand(entity)}\``;
}

/** The charter, verified on every read: a verdict is never kept, since a file's size and times
 *  can be put back after its bytes change, and the signer's key can change beside it. */
function charterOn(home: string, store: OwnerSeatKeyStore | undefined): CharterRead {
  return store !== undefined ? readCharter(home, store) : readCharter(home);
}

/** How the folders are bound: to the charter's roots, or to nothing on a machine with none. */
export type FolderBinding = 'charter' | 'unsigned';

/**
 * The folders the words in `words` need, for `entity` at `home`, as they are filled: each one's
 * real path. On a machine with a signed charter each must exist and lie inside a charter root
 * that still resolves to what was signed; with no charter, a folder that does not exist yet is
 * filled as written. A charter that does not verify refuses every folder.
 */
export function resolvedFolders(
  home: string,
  entity: string,
  words: readonly Word[],
  store?: OwnerSeatKeyStore,
): { ok: true; folders: FolderWords; binding: FolderBinding } | { ok: false; why: string } {
  const read = entityFolders(home, entity);
  if (!read.ok) return { ok: false, why: `${read.why} (${entitiesPath(home)})` };
  const missing = words.find((word) => read[word] === null);
  if (missing !== undefined) return { ok: false, why: unnamed(missing, entity) };
  const charter = charterOn(home, store);
  if (charter.kind === 'invalid') {
    return { ok: false, why: `the owner charter does not verify (${charter.why}): the folders of entity "${entity}" are bound to it, and none is filled until the owner signs again with team setup --edit` };
  }
  const folders: FolderWords = { root: null, worktrees: null };
  for (const word of words) {
    const written = read[word] as string;
    const real = canonicalFolder(written, home);
    if (charter.kind === 'ok') {
      if (!real.ok) return { ok: false, why: `{${word}} of entity "${entity}": ${real.why}` };
      const inside = charter.charter.body.roots.some((root) => {
        const bound = boundRoot(root);
        return bound !== null && pathInsideRoot(bound, real.path);
      });
      if (!inside) {
        return { ok: false, why: `{${word}} of entity "${entity}" is ${real.path}, outside the owner charter's roots: the owner widens the charter with team setup --edit, or names a folder inside it` };
      }
      folders[word] = real.path;
    } else {
      if (!real.ok && !real.missing) return { ok: false, why: `{${word}} of entity "${entity}": ${real.why}` };
      folders[word] = real.ok ? real.path : written;
    }
  }
  return { ok: true, folders, binding: charter.kind === 'ok' ? 'charter' : 'unsigned' };
}

/** What a fill did: the problems that kept it from filling, the values it filled, and the
 *  folders it filled them with (each an absolute real path). */
export type FilledTree = { problems: Problem[]; nodes: Set<YamlNode>; folders: string[] };

/** How a read fills the words: `strict` refuses a word it cannot fill; `keep` (the reads of
 *  `team down` and `team status`) leaves such a word as written and refuses nothing. */
export type FillOptions = { unfilled?: 'strict' | 'keep'; ownerSeatStore?: OwnerSeatKeyStore };

/**
 * Fills every word in a parsed team file, in place, with the entity's folders at `home`, before
 * any section reads the file. Returns the problems that keep a word from being filled — the file
 * names no entity, the entity's folder word does not read, it names no such folder on this
 * machine, or the folder lies outside the owner's charter — on the first line that writes the
 * word; the tree is then left unfilled and the file does not validate. The entity's and home
 * project's rules are held to the same: a rule that writes a word the machine cannot fill refuses
 * the file too, so a seat never starts with a rule naming a folder it cannot find. A file with no
 * word, and no rule with one, returns no problem.
 */
export function fillRootWords(tree: YamlNode, home: string, options: FillOptions = {}): FilledTree {
  const empty: FilledTree = { problems: [], nodes: new Set(), folders: [] };
  if (tree.kind !== 'map') return empty;
  const keep = options.unfilled === 'keep';
  const holding = stringScalars(tree).filter(({ node }) => hasRootWord(node.value));
  const entity = topWord(tree, 'entity');
  const inherited = keep || entity === null ? [] : inheritedWords(home, entity, topWord(tree, 'in_project'));
  if (holding.length === 0 && inherited.length === 0) return empty;
  const line = holding[0]?.node.line ?? 0;
  if (entity === null) {
    return keep ? keptForReading(tree) : { ...empty, problems: [{ line, message: `the file writes ${ROOT_WORD} or ${WORKTREES_WORD}, and names no entity: each is a folder of an entity, so the file needs \`entity:\`` }] };
  }
  const needed = new Set<Word>(inherited);
  for (const { node } of holding) for (const word of wordsIn(node.value)) needed.add(word);
  const resolved = resolvedFolders(home, entity, [...needed], options.ownerSeatStore);
  if (!resolved.ok) {
    if (keep) return keptForReading(tree);
    const first = holding.find(({ node }) => wordsIn(node.value).length > 0);
    const where = first === undefined ? "the entity's or project's rules write" : 'the file writes';
    return { ...empty, problems: [{ line: first?.node.line ?? 0, message: `${where} ${[...needed].map((word) => `{${word}}`).join(' and ')}, and ${resolved.why}` }] };
  }
  const nodes = new Set<YamlNode>();
  for (const { node } of holding) {
    node.value = fillFolderWords(node.value, resolved.folders);
    node.raw = fillFolderWords(node.raw, resolved.folders);
    nodes.add(node);
  }
  const folders = [resolved.folders.root, resolved.folders.worktrees].filter((folder): folder is string => folder !== null);
  return { problems: [], nodes, folders };
}

/**
 * A team read to be stopped or shown (`keep`) whose words cannot be filled: every value keeps its
 * word as written, and a `trust` entry that writes one is left out of the read. A trust path is
 * for placing a seat, which such a read never does, and an entry that is not yet a path would make
 * the whole list read as an older form the reader refuses.
 */
function keptForReading(tree: YamlNode): FilledTree {
  if (tree.kind === 'map') {
    const trust = tree.entries.find((entry) => entry.key === 'trust');
    if (trust !== undefined && trust.value.kind === 'seq') {
      trust.value.items = trust.value.items.filter((item) => !(item.kind === 'scalar' && typeof item.value === 'string' && hasRootWord(item.value)));
    }
  }
  return { problems: [], nodes: new Set(), folders: [] };
}

/** The words the entity's and home project's rules write, each once. */
function inheritedWords(home: string, entity: string, project: string | null): Word[] {
  const found = new Set<Word>();
  for (const rule of [...entityRules(home, entity), ...projectRules(home, project)]) {
    for (const word of wordsIn(rule)) found.add(word);
  }
  return [...found];
}

/**
 * An entity's or project's rules (the owner's entities and projects files) with the words filled
 * with the entity's folders at `home`, bound the way a team file's are. A rule whose word cannot be
 * filled is kept as written here: the read of the team file has already refused it
 * (`fillRootWords`), and `team doctor` names it. Rules without a word come back as they are.
 */
export function filledRules(rules: string[], home: string | undefined, entity: string | null): string[] {
  if (home === undefined || entity === null || !rules.some(hasRootWord)) return rules;
  const words = [...new Set(rules.flatMap(wordsIn))];
  const resolved = resolvedFolders(home, entity, words);
  if (!resolved.ok) return rules;
  return rules.map((rule) => fillFolderWords(rule, resolved.folders));
}

/**
 * A path-valued setting outside a team file (the `vault-root` policy) with its words filled: the
 * path, or why it cannot be — a word the entity names no folder for, or a folder outside the
 * charter, the same refusal a team file gets. A value with no word comes back as it is.
 */
export function filledPath(value: string, home: string, entity: string | null): { ok: true; path: string } | { ok: false; why: string } {
  if (!hasRootWord(value)) return { ok: true, path: value };
  if (entity === null) return { ok: false, why: `${value} names a folder of an entity, and no entity is named` };
  const resolved = resolvedFolders(home, entity, wordsIn(value));
  if (!resolved.ok) return { ok: false, why: resolved.why };
  return { ok: true, path: fillFolderWords(value, resolved.folders) };
}

/** Whether the entity's folders on this machine are bound to no signature: there is no charter. */
export function foldersUnsigned(home: string, store?: OwnerSeatKeyStore): boolean {
  return charterOn(home, store).kind === 'absent';
}

/** Escapes a text for a regular expression. */
function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The spellings of the entity's folders, and the word each one stands for. */
type Forms = { pattern: RegExp; wordOf: Map<string, string> };

/**
 * The ways a file can write the entity's folders in full on this machine, each with the word it
 * stands for: the absolute path as written and as resolved, and the `~/…` and `$HOME/…` forms when
 * it sits under the home. The worktrees folder comes first, so a worktree path under the root
 * (`~/Code/acme/worktrees/…`) is written as `{worktrees}/…`. A form matches only as a whole path:
 * the next character ends the path or starts a segment, and the one before does not belong to a
 * longer path. A path into a hidden folder of a folder (`/.config`) is never read as inside it:
 * that is the machine's, not a project's.
 */
function folderForms(spellings: Array<[string, string]>, home: string): Forms | null {
  const homeless = home.replace(/\/+$/, '');
  const wordOf = new Map<string, string>();
  const literals: string[] = [];
  for (const [folder, word] of spellings) {
    const spelled = [folder];
    if (folder.startsWith(`${homeless}/`)) {
      const rest = folder.slice(homeless.length);
      spelled.push(`~${rest}`, `$HOME${rest}`, `\${HOME}${rest}`);
    }
    for (const literal of spelled) {
      if (wordOf.has(literal)) continue;
      wordOf.set(literal, word);
      literals.push(literal);
    }
  }
  if (literals.length === 0) return null;
  // The longest spelling first, so a folder inside another is matched as itself.
  literals.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(?<![A-Za-z0-9_.~/$-])(?:${literals.map(escaped).join('|')})(?!/\\.)(?=$|[/\\s"'\`,;:)\\]}])`, 'g');
  return { pattern, wordOf };
}

/** The fields whose values a shell reads: a launch line, a setup step, a check command. */
function isShellField(field: readonly string[]): boolean {
  return field.some((segment) => segment === 'launch' || segment === 'setup' || segment === 'check' || segment === 'command');
}

/** The shell's quoting at `index` of `text`: outside quotes, inside single or inside double. */
function quotingAt(text: string, index: number): 'none' | 'single' | 'double' {
  let state: 'none' | 'single' | 'double' = 'none';
  for (let i = 0; i < index; i += 1) {
    const c = text[i];
    if (state === 'single') {
      if (c === "'") state = 'none';
      continue;
    }
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (state === 'double') {
      if (c === '"') state = 'none';
      continue;
    }
    if (c === "'") state = 'single';
    else if (c === '"') state = 'double';
  }
  return state;
}

/**
 * Whether writing `literal` at `index` of a shell line as its word keeps what the line means. The
 * word is filled with an absolute path, which a shell reads the same in any quotes; so the
 * absolute spelling always keeps its meaning. `~/…` is a home path only where the shell expands
 * it — outside quotes, at the start of a word; inside quotes it is the text `~/…`. `$HOME/…` is
 * expanded outside quotes and inside double quotes, never inside single quotes or after a
 * backslash. Anywhere else the rewrite would change what the line runs, and the value is left.
 */
function shellKeepsMeaning(text: string, index: number, literal: string): boolean {
  if (literal.startsWith('/')) return true;
  if (text[index - 1] === '\\') return false;
  const quoting = quotingAt(text, index);
  if (literal.startsWith('~')) return quoting === 'none' && (index === 0 || /\s/.test(text[index - 1] as string));
  return quoting !== 'single';
}

/** One spelling found in a value, where it stands, whether it may be written as its word, and
 *  why not when it may not. */
type Found = { index: number; literal: string; word: string; keeps: boolean; why?: string };

/** Shell constructs the quote reading does not follow: a command or process substitution, a
 *  here-document, `eval`. A shell line holding one is never rewritten: what quotes a path stands in
 *  inside them is not read here, so no spelling in it is taken to keep its meaning. */
const UNREAD_SHELL = /\$\(|`|<\(|>\(|<<|\beval\b/;

function found(value: string, forms: Forms, shell: boolean): Found[] {
  const out: Found[] = [];
  const unread = shell && UNREAD_SHELL.test(value);
  for (const match of value.matchAll(new RegExp(forms.pattern.source, 'g'))) {
    const literal = match[0];
    const index = match.index ?? 0;
    const word = forms.wordOf.get(literal) ?? ROOT_WORD;
    if (unread) {
      out.push({ index, literal, word, keeps: false, why: 'the line holds a command substitution, a here-document or eval, which the rewrite does not read' });
      continue;
    }
    const keeps = !shell || shellKeepsMeaning(value, index, literal);
    out.push({ index, literal, word, keeps, ...(keeps ? {} : { why: 'the shell does not expand it there, so the word would change what the line runs' }) });
  }
  return out;
}

/** A text with each kept spelling written as its word, in order; `keeps` names which ones. */
function withWords(text: string, forms: Forms, keeps: readonly boolean[]): string | null {
  let ordinal = 0;
  let count = 0;
  const out = text.replace(new RegExp(forms.pattern.source, 'g'), (literal) => {
    const keep = keeps[ordinal];
    ordinal += 1;
    count += 1;
    return keep === true ? (forms.wordOf.get(literal) ?? literal) : literal;
  });
  return count === keeps.length ? out : null;
}

/** One value that writes one of the entity's folders in full. */
export type RootPathUse = { line: number; field: string; written: string; word: string };

/** The entity's folders on this machine, as every spelling a file might write them in. */
function foldersOn(home: string, entity: string | null): { ok: true; spellings: Array<[string, string]>; root: string | null; worktrees: string | null; entity: string } | { ok: false; why: string } {
  if (entity === null) return { ok: false, why: `the team names no entity: ${ROOT_WORD} is an entity's projects root` };
  const read = entityFolders(home, entity);
  if (!read.ok) return { ok: false, why: read.why };
  if (read.root === null && read.worktrees === null) return { ok: false, why: unnamed('root', entity) };
  const spellings: Array<[string, string]> = [];
  const add = (folder: string | null, word: string) => {
    if (folder === null) return;
    spellings.push([folder, word]);
    const real = canonicalFolder(folder, home);
    if (real.ok && real.path !== folder) spellings.push([real.path, word]);
  };
  add(read.worktrees, WORKTREES_WORD);
  add(read.root, ROOT_WORD);
  return { ok: true, spellings, root: read.root, worktrees: read.worktrees, entity };
}

/**
 * Every value of a team's text that writes one of this machine's folders of its entity in full,
 * where the word would read the same here and also on every other machine — and, in a shell
 * line, where writing the word keeps what the line runs. Empty when the text does not parse, the
 * team names no entity, or the entity names no folder: there is then nothing to compare with.
 */
export function rootPathUses(text: string, home: string): RootPathUse[] {
  let tree: YamlNode;
  try {
    tree = parseYaml(text);
  } catch {
    return [];
  }
  const on = foldersOn(home, topWord(tree, 'entity'));
  if (!on.ok) return [];
  const forms = folderForms(on.spellings, home);
  if (forms === null) return [];
  const uses: RootPathUse[] = [];
  for (const { node, field } of stringScalars(tree)) {
    const first = found(node.value, forms, isShellField(field)).find((one) => one.keeps);
    if (first !== undefined) uses.push({ line: node.line, field: field.join('.'), written: first.literal, word: first.word });
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

/** A spelling the rewrite left as written, and why. */
export type RootRewriteKept = { line: number; field: string; written: string; why: string };

/** A rewrite of a team's text, or why it cannot be made. */
export type RootRewrite =
  | { ok: true; text: string; changes: RootRewriteLine[]; kept: RootRewriteKept[]; root: string | null; worktrees: string | null; entity: string }
  | { ok: false; why: string };

/** A value as one quoted YAML word: single quotes when it holds none, else double quotes. */
function quotedWord(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The team's text with every full folder path in a value rewritten as `{root}` or `{worktrees}`,
 * line by line, so every comment, key and other value stays byte for byte. `lines`, when given,
 * limits the rewrite to the values those lines write. In a shell line (a launch line, a setup
 * step) a spelling is rewritten only where the word keeps what the line runs: `~/…` inside quotes
 * is the text `~/…` to the shell, and `$HOME/…` inside single quotes is the text `$HOME/…`, so
 * both are left and listed (`kept`). A value that would start with a word is quoted, because YAML
 * would read an unquoted `{` as a map. The rewrite is checked by reading it back: it must parse to
 * the same values with only those paths changed, else it is refused and nothing is offered.
 * Nothing is written here.
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
  const on = foldersOn(home, topWord(tree, 'entity'));
  if (!on.ok) return on;
  const forms = folderForms(on.spellings, home);
  if (forms === null) return { ok: false, why: unnamed('root', on.entity) };
  const kept: RootRewriteKept[] = [];
  // Each chosen value, with which of its spellings the rewrite writes as a word.
  const plans = new Map<StringScalar, boolean[]>();
  for (const { node, field } of stringScalars(tree)) {
    if (lines !== undefined && !lines.has(node.line)) continue;
    const spots = found(node.value, forms, isShellField(field));
    if (spots.length === 0) continue;
    for (const spot of spots) {
      if (!spot.keeps) kept.push({ line: node.line, field: field.join('.'), written: spot.literal, why: spot.why ?? 'the word would change what the line runs' });
    }
    if (spots.some((spot) => spot.keeps)) plans.set(node, spots.map((spot) => spot.keeps));
  }
  // What the rewrite must read back as: the same tree, with only the planned spellings rewritten.
  const want = stringScalars(expected);
  stringScalars(tree).forEach(({ node }, index) => {
    const keeps = plans.get(node);
    if (keeps === undefined) return;
    const rewritten = withWords(node.value, forms, keeps);
    if (rewritten !== null) want[index]!.node.value = rewritten;
  });
  const wanted = JSON.stringify(toValue(expected));
  const attempt = (quoteAll: boolean): string | null => {
    const out = text.split('\n');
    const cursor = new Map<number, number>();
    for (const { node } of stringScalars(tree)) {
      const keeps = plans.get(node);
      if (keeps === undefined) continue;
      const index = node.line - 1;
      const line = out[index];
      if (line === undefined) return null;
      const from = cursor.get(index) ?? 0;
      const at = line.indexOf(node.raw, from);
      if (at < 0) return null;
      let raw: string | null;
      if (node.quoted) {
        raw = withWords(node.raw, forms, keeps);
      } else {
        const plain = withWords(node.raw, forms, keeps);
        const value = withWords(node.value, forms, keeps);
        raw = plain === null || value === null ? null : quoteAll || plain.startsWith('{') ? quotedWord(value) : plain;
      }
      if (raw === null) return null;
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
  return { ok: true, text: next, changes, kept, root: on.root, worktrees: on.worktrees, entity: on.entity };
}

/**
 * The text an editor writes back with the words kept: in each line the edit added or changed, a
 * full path inside one of the entity's folders on this machine is written as `{root}/…` or
 * `{worktrees}/…` again — where, in a shell line, the word keeps what the line runs — so a value
 * an editor built from the team as read (where every word was already filled) does not bake this
 * machine's path into the record. Lines the edit left alone are not touched, and a text that
 * cannot be rewritten that way is returned as the editor made it.
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

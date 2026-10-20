// Writes the command contract: contract/cli.json and docs/reference/cli.md.
//
// Read from the definitions, not from a `--help` run. The commands are the
// table in src/cli.ts, plus every name that file compares to `name` and does
// not list. A command's usage lines are its exported USAGE string (the same
// string `--help` prints). Its flags are the names passed to readArgs, or
// check's VALUE_OPTIONS and FLAG_OPTIONS — the valued options and the switches
// that take no value. A command that parses more than one branch calls readArgs
// more than once: each call is then one form, and the command's own usage lines
// declare exactly those forms — every option in a call and its value/switch
// type must match one line, and every such line must match one call, so a form
// and its parser cannot drift apart. A single call keeps the older rule: a
// flag no usage text mentions is hidden — `--help` is in the program usage, so
// a command keeps it visible, while `-h` and `-V` are not written anywhere and
// stay hidden. Positionals are the <name> tokens
// of the usage lines; one that a line omits or wraps in brackets is optional.
// A bare word after the command is a subcommand, and the command must compare
// its first positional to that word. One required word after a positional is a
// literal, and the command must compare the positional after that one
// (`args.rest[1]`) to it. Nothing is repeatable: each parser stores
// one value per name.
//
// Every command also carries who may run it: the gate row the command-to-
// capability map (src/permissions/map.ts) holds for its word, kind and reason,
// and `unlisted` where the map holds no row — the map is closed, so its silence
// is not an admission and the contract never reads it as one.
//
//   bun scripts/contract.ts
//   bun scripts/contract.ts --check
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { COMMAND_GATES } from '../src/permissions/map.ts';

const JSON_REL = 'contract/cli.json';
const MARKDOWN_REL = 'docs/reference/cli.md';

type Flag = { name: string; takesValue: boolean; repeatable: boolean; hidden: boolean };
type Positional = { name: string; optional: boolean; repeatable: boolean };
/** Who may run one command, as the map states it: the gate's kind, the map's own sentence, and —
 *  where the module refuses a run with no terminal — the route its `detachedRefusal` prints. */
type Who = { gate: string; why: string; terminal?: { who: string; where: string } };
type Node = {
  name: string;
  hidden: boolean;
  usage: string[];
  flags: Flag[];
  positionals: Positional[];
  subcommands: Node[];
  /** A required word after a positional. Omitted when the command has none, so other commands' keys stay as they are. */
  literals?: string[];
  /** The who-may-run row: the command's own, or `command:subcommand` for a verb that gates
   *  differently. Omitted on the program, which is no word of its own. */
  who?: Who;
};
type Contract = { program: Node; commands: Node[] };

type Piece =
  | { kind: 'flag'; name: string; optional: boolean; takesValue: boolean }
  | { kind: 'positional'; name: string; optional: boolean }
  | { kind: 'word'; text: string; optional: boolean };

type ParsedLine = {
  line: string;
  subcommand: string | null;
  flags: { name: string; takesValue: boolean }[];
  positionals: { name: string; optional: boolean }[];
  literals: string[];
};

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function rootOf(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}

function load(root: string, rel: string, overrides?: ReadonlyMap<string, string>): string {
  const over = overrides?.get(rel);
  if (over !== undefined) return over;
  return readFileSync(join(root, rel), 'utf8');
}

function sourceOf(rel: string, text: string): ts.SourceFile {
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function literalStrings(node: ts.Expression, where: string): string[] {
  const expr = unwrap(node);
  if (!ts.isArrayLiteralExpression(expr)) throw new Error(`${where}: expected a string array`);
  return expr.elements.map((element, index) => {
    const item = unwrap(element);
    if (!ts.isStringLiteral(item) && !ts.isNoSubstitutionTemplateLiteral(item)) {
      throw new Error(`${where}: element ${index} is not a string`);
    }
    return item.text;
  });
}

function stringConst(source: ts.SourceFile, name: string, exported: boolean): string | null {
  for (const stmt of source.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const isExport = stmt.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (exported !== isExport) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== name || !decl.initializer) continue;
      const expr = unwrap(decl.initializer);
      if (!ts.isStringLiteral(expr) && !ts.isNoSubstitutionTemplateLiteral(expr)) {
        throw new Error(`${source.fileName}: ${name} must be a string with no interpolation`);
      }
      return expr.text;
    }
  }
  return null;
}

type OptionSet = { valued: string[]; flags: string[] };

/** Every option set the command itself parses: one per readArgs call, in source order. A command
 *  that parses different branches may call readArgs more than once; each call is then a form of
 *  its own, and commandNode matches the forms to the usage lines it declares. */
function optionLists(source: ts.SourceFile, rel: string): OptionSet[] {
  const read: OptionSet[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'readArgs') {
      const valuedNode = node.arguments[1];
      const flagsNode = node.arguments[2];
      if (!valuedNode || !flagsNode) throw new Error(`${rel}: readArgs needs its option lists`);
      read.push({
        valued: literalStrings(valuedNode, `${rel}: readArgs values`),
        flags: literalStrings(flagsNode, `${rel}: readArgs flags`),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  // A command that reads its own options without readArgs lists the valued ones in VALUE_OPTIONS
  // and, when it has any, its switches — taken with no value — in FLAG_OPTIONS beside it: check
  // is the one such command, its parse kept by hand for the old spelling's exact bytes.
  let values: string[] | null = null;
  let switches: string[] | null = null;
  const visitValues = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (node.name.text === 'VALUE_OPTIONS') values = literalStrings(node.initializer, `${rel}: VALUE_OPTIONS`);
      if (node.name.text === 'FLAG_OPTIONS') switches = literalStrings(node.initializer, `${rel}: FLAG_OPTIONS`);
    }
    ts.forEachChild(node, visitValues);
  };
  visitValues(source);
  if (read.length > 0 && (values || switches)) throw new Error(`${rel}: both readArgs and VALUE_OPTIONS/FLAG_OPTIONS`);
  if (values) return [{ valued: values, flags: switches ?? [] }];
  if (switches) throw new Error(`${rel}: FLAG_OPTIONS without VALUE_OPTIONS`);
  return read;
}

function isRest(expr: ts.Expression, index: string): boolean {
  const node = unwrap(expr);
  if (!ts.isElementAccessExpression(node) || !node.argumentExpression) return false;
  const prop = node.expression;
  if (!ts.isPropertyAccessExpression(prop) || !ts.isIdentifier(prop.expression)) return false;
  if (prop.expression.text !== 'args' || prop.name.text !== 'rest') return false;
  return ts.isNumericLiteral(node.argumentExpression) && node.argumentExpression.text === index;
}

function isRestZero(expr: ts.Expression): boolean {
  return isRest(expr, '0');
}

/** Words the command compares to the variable holding its first positional. */
function sourceSubcommands(source: ts.SourceFile): Set<string> {
  const holders = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isRestZero(node.initializer)) {
      holders.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const names = new Set<string>();
  const compare = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      const left = unwrap(node.left);
      const right = unwrap(node.right);
      const literal = ts.isStringLiteral(left) ? left : ts.isStringLiteral(right) ? right : null;
      const ident = ts.isIdentifier(left) ? left : ts.isIdentifier(right) ? right : null;
      if (literal && ident && holders.has(ident.text) && literal.text !== '') names.add(literal.text);
    }
    ts.forEachChild(node, compare);
  };
  compare(source);
  return names;
}

/** Words the command compares to the variable holding `args.rest[1]`. */
function sourceRestLiterals(source: ts.SourceFile): Set<string> {
  const holders = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isRest(node.initializer, '1')) {
      holders.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const names = new Set<string>();
  const compare = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      const left = unwrap(node.left);
      const right = unwrap(node.right);
      const literal = ts.isStringLiteral(left) ? left : ts.isStringLiteral(right) ? right : null;
      const ident = ts.isIdentifier(left) ? left : ts.isIdentifier(right) ? right : null;
      if (literal && ident && holders.has(ident.text) && literal.text !== '') names.add(literal.text);
    }
    ts.forEachChild(node, compare);
  };
  compare(source);
  return names;
}

function usageLines(usage: string): string[] {
  const lines: string[] = [];
  for (const raw of usage.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const text = trimmed.startsWith('Usage:') ? trimmed.slice('Usage:'.length).trim() : trimmed;
    if (text.startsWith('team ') || text === 'team') lines.push(text);
  }
  return lines;
}

function piecesOf(line: string, rel: string): Piece[] {
  const chunks: { text: string; optional: boolean }[] = [];
  let index = 0;
  while (index < line.length) {
    while (line[index] === ' ') index += 1;
    if (index >= line.length) break;
    if (line[index] === '[') {
      const end = line.indexOf(']', index);
      if (end < 0) throw new Error(`${rel}: unclosed bracket in ${line}`);
      chunks.push({ text: line.slice(index + 1, end).trim(), optional: true });
      index = end + 1;
      continue;
    }
    let end = index;
    while (end < line.length && line[end] !== ' ' && line[end] !== '[') end += 1;
    chunks.push({ text: line.slice(index, end), optional: false });
    index = end;
  }

  const raw: Piece[] = [];
  for (const chunk of chunks) {
    const parts = chunk.text.split(/\s+/).filter((part) => part.length > 0);
    if (parts.length > 2) {
      // `team next [--mine | --release]` names two flags in one bracket. A pipe is the join, not a word.
      if (!parts.every((part) => part === '|' || part.startsWith('--'))) throw new Error(`${rel}: cannot read "${chunk.text}" in ${line}`);
      for (const part of parts) {
        if (part !== '|') raw.push(piece(part, chunk.optional, rel, line));
      }
      continue;
    }
    for (const part of parts) raw.push(piece(part, chunk.optional, rel, line));
  }

  const merged: Piece[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const current = raw[i] as Piece;
    const next = raw[i + 1];
    if (current.kind === 'flag' && next?.kind === 'positional') {
      merged.push({ kind: 'flag', name: current.name, optional: current.optional, takesValue: true });
      i += 1;
    } else {
      merged.push(current);
    }
  }
  return merged;
}

function piece(part: string, optional: boolean, rel: string, line: string): Piece {
  if (part.startsWith('--')) {
    if (!/^--[A-Za-z0-9-]+$/.test(part)) throw new Error(`${rel}: bad flag ${part} in ${line}`);
    return { kind: 'flag', name: part, optional, takesValue: false };
  }
  if (/^-[A-Za-z0-9]$/.test(part)) return { kind: 'flag', name: part, optional, takesValue: false };
  if (part.startsWith('<') && part.endsWith('>') && part.length > 2 && !part.slice(1, -1).includes('<')) {
    return { kind: 'positional', name: part.slice(1, -1), optional };
  }
  if (/^[A-Za-z0-9-]+$/.test(part)) return { kind: 'word', text: part, optional };
  throw new Error(`${rel}: cannot read ${part} in ${line}`);
}

function parseCommandLine(line: string, command: string, rel: string): ParsedLine {
  const parts = piecesOf(line, rel);
  const team = parts[0];
  const name = parts[1];
  if (team?.kind !== 'word' || team.text !== 'team' || name?.kind !== 'word' || name.text !== command) {
    throw new Error(`${rel}: usage line is not for ${command}: ${line}`);
  }
  let subcommand: string | null = null;
  let start = 2;
  const third = parts[2];
  if (third?.kind === 'word') {
    if (third.optional) throw new Error(`${rel}: bracketed word "${third.text}" in ${line}`);
    subcommand = third.text;
    start = 3;
  }
  const flags: ParsedLine['flags'] = [];
  const positionals: ParsedLine['positionals'] = [];
  const literals: string[] = [];
  for (const part of parts.slice(start)) {
    if (part.kind === 'word') {
      if (positionals.length === 0) throw new Error(`${rel}: unexpected "${part.text}" in ${line}`);
      if (part.optional) throw new Error(`${rel}: bracketed word "${part.text}" in ${line}`);
      if (literals.length > 0) throw new Error(`${rel}: unexpected "${part.text}" in ${line}`);
      literals.push(part.text);
      continue;
    }
    if (part.kind === 'flag') flags.push({ name: part.name, takesValue: part.takesValue });
    else positionals.push({ name: part.name, optional: part.optional });
  }
  return { line, subcommand, flags, positionals, literals };
}

function parseProgramLine(line: string, rel: string): { flags: ParsedLine['flags']; positionals: ParsedLine['positionals'] } {
  const parts = piecesOf(line, rel);
  const team = parts[0];
  if (team?.kind !== 'word' || team.text !== 'team') throw new Error(`${rel}: program usage does not start with team: ${line}`);
  const flags: ParsedLine['flags'] = [];
  const positionals: ParsedLine['positionals'] = [];
  for (const part of parts.slice(1)) {
    if (part.kind === 'word') {
      if (part.optional && part.text === 'options') continue;
      throw new Error(`${rel}: unexpected "${part.text}" in ${line}`);
    }
    if (part.kind === 'flag') flags.push({ name: part.name, takesValue: part.takesValue });
    else positionals.push({ name: part.name, optional: part.optional });
  }
  return { flags, positionals };
}

function tokenIn(text: string, token: string): boolean {
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(token, from);
    if (at < 0) return false;
    const before = text[at - 1] ?? '';
    const after = text[at + token.length] ?? '';
    if (!/[A-Za-z0-9-]/.test(before) && !/[A-Za-z0-9-]/.test(after)) return true;
    from = at + 1;
  }
  return false;
}

function repeatable(root: string, overrides?: ReadonlyMap<string, string>): false {
  const args = load(root, 'src/args.ts', overrides);
  const check = load(root, 'src/commands/check.ts', overrides);
  if (!args.includes('args.values[name] = value') || !args.includes('args.flags.add(name)')) {
    throw new Error('src/args.ts no longer stores one value per option, so repeatable cannot be decided');
  }
  if (!check.includes('values[option] = value')) {
    throw new Error('src/commands/check.ts no longer stores one value per option, so repeatable cannot be decided');
  }
  return false;
}

function mergePositionals(lines: ParsedLine[]): Positional[] {
  const order: string[] = [];
  const optional = new Map<string, boolean>();
  const seen = new Map<string, number>();
  for (const line of lines) {
    const onLine = new Set<string>();
    for (const positional of line.positionals) {
      if (onLine.has(positional.name)) throw new Error(`positional ${positional.name} is repeated on ${line.line}`);
      onLine.add(positional.name);
      if (!optional.has(positional.name)) order.push(positional.name);
      optional.set(positional.name, (optional.get(positional.name) ?? false) || positional.optional);
    }
    for (const name of onLine) seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  for (const name of order) {
    if ((seen.get(name) ?? 0) < lines.length) optional.set(name, true);
  }
  return order.map((name) => ({ name, optional: optional.get(name) ?? false, repeatable: false }));
}

function sortFlags(flags: Flag[]): Flag[] {
  return [...flags].sort((a, b) => cmp(a.name, b.name));
}

function definedFlags(sets: OptionSet[], rel: string): Map<string, boolean> {
  const defined = new Map<string, boolean>();
  for (const lists of sets) {
    const own = new Map<string, boolean>();
    for (const name of lists.valued) {
      const token = `--${name}`;
      if (own.has(token)) throw new Error(`${rel}: ${token} is listed twice`);
      own.set(token, true);
    }
    for (const name of lists.flags) {
      const token = `--${name}`;
      if (own.has(token)) throw new Error(`${rel}: ${token} is both a value and a boolean`);
      own.set(token, false);
    }
    // The union is only the actual parser sets: a name one branch reads as a value and another
    // reads as a switch is a contradiction, not two spellings of one option.
    for (const [token, takesValue] of own) {
      const prior = defined.get(token);
      if (prior !== undefined && prior !== takesValue) throw new Error(`${rel}: ${token} is both a value and a boolean`);
      defined.set(token, takesValue);
    }
  }
  return defined;
}

/** One form's exact shape: every option name with its value/switch type, in one canonical order.
 *  Bracket optionality is not part of it — a bracketed flag is accepted exactly as the parser
 *  reads it, so the form is the set of options and their types, not how the line marks them. */
function formSignature(flags: readonly { name: string; takesValue: boolean }[]): string {
  return flags
    .map((flag) => `${flag.name}=${flag.takesValue ? 'value' : 'switch'}`)
    .sort(cmp)
    .join(' ');
}

/** A command that parses more than one branch: its calls and its own usage lines must declare the
 *  same forms, both ways. A parser shape no line declares, a line no call parses, or two calls or
 *  two lines with the same shape (which call a run takes would be unstated) is an error — the
 *  multiple-call error is never swallowed without the forms themselves matching. */
function checkOptionForms(sets: OptionSet[], ownLines: ParsedLine[], rel: string): void {
  if (sets.length < 2) return;
  const fromUsage = new Map<string, string>();
  for (const line of ownLines) {
    const signature = formSignature(line.flags);
    const prior = fromUsage.get(signature);
    if (prior !== undefined) throw new Error(`${rel}: usage lines "${prior}" and "${line.line}" declare the same form`);
    fromUsage.set(signature, line.line);
  }
  const fromParser = new Set<string>();
  for (const set of sets) {
    const signature = formSignature([
      ...set.valued.map((name) => ({ name: `--${name}`, takesValue: true })),
      ...set.flags.map((name) => ({ name: `--${name}`, takesValue: false })),
    ]);
    if (fromParser.has(signature)) throw new Error(`${rel}: two readArgs calls declare the same form: ${signature || 'no options'}`);
    fromParser.add(signature);
    if (!fromUsage.has(signature)) throw new Error(`${rel}: a readArgs call (${signature || 'no options'}) has no usage line declaring that form`);
  }
  for (const [signature, line] of fromUsage) {
    if (!fromParser.has(signature)) throw new Error(`${rel}: usage line "${line}" declares a form no readArgs call parses (${signature || 'no options'})`);
  }
}

function flagsOn(lines: ParsedLine[], extra: Flag[], rel: string): Flag[] {
  const map = new Map<string, Flag>();
  for (const line of lines) {
    for (const flag of line.flags) {
      const prior = map.get(flag.name);
      if (prior && prior.takesValue !== flag.takesValue) throw new Error(`${rel}: ${flag.name} disagrees with itself`);
      map.set(flag.name, { name: flag.name, takesValue: flag.takesValue, repeatable: false, hidden: false });
    }
  }
  for (const flag of extra) {
    if (map.has(flag.name)) throw new Error(`${rel}: ${flag.name} is already on the usage line`);
    map.set(flag.name, flag);
  }
  return sortFlags([...map.values()]);
}

function helpFlags(tokens: readonly string[], texts: readonly string[]): Flag[] {
  return tokens.map((name) => ({
    name,
    takesValue: false,
    repeatable: false,
    hidden: !texts.some((text) => tokenIn(text, name)),
  }));
}

function commandNode(
  name: string,
  hidden: boolean,
  rel: string,
  text: string,
  help: readonly string[],
  programUsage: string,
): Node {
  const source = sourceOf(rel, text);
  const usage = stringConst(source, 'USAGE', true);
  if (!hidden && usage === null) throw new Error(`${rel}: missing exported USAGE`);
  const lists = optionLists(source, rel);
  if (!hidden && lists.length === 0) throw new Error(`${rel}: no readArgs or VALUE_OPTIONS`);
  const defined = definedFlags(lists, rel);
  const lines = usage === null ? [] : usageLines(usage).map((line) => parseCommandLine(line, name, rel));
  const fromUsage = new Set(lines.flatMap((line) => (line.subcommand === null ? [] : [line.subcommand])));
  const fromSource = sourceSubcommands(source);
  for (const sub of fromUsage) {
    if (!fromSource.has(sub)) throw new Error(`${rel}: usage names subcommand "${sub}" but the command never compares its first positional to it`);
  }
  const literals = [...new Set(lines.flatMap((line) => line.literals))].sort(cmp);
  const fromLiterals = sourceRestLiterals(source);
  for (const word of literals) {
    if (!fromLiterals.has(word)) throw new Error(`${rel}: usage names literal "${word}" but the command never compares args.rest[1] to it`);
  }

  const seen = new Map<string, boolean>();
  for (const line of lines) {
    for (const flag of line.flags) {
      const takes = defined.get(flag.name);
      if (takes === undefined) throw new Error(`${rel}: ${flag.name} is in the usage but not an option`);
      if (takes !== flag.takesValue) throw new Error(`${rel}: ${flag.name} does not match the option list`);
      seen.set(flag.name, flag.takesValue);
    }
  }
  const hiddenFlags: Flag[] = [];
  for (const [flag, takesValue] of defined) {
    if (!seen.has(flag)) hiddenFlags.push({ name: flag, takesValue, repeatable: false, hidden: true });
  }

  const texts = usage === null ? [] : [usage, programUsage];
  const extra = [...hiddenFlags, ...helpFlags(help, texts)];
  const ownLines = lines.filter((line) => line.subcommand === null);
  checkOptionForms(lists, ownLines, rel);
  const subcommands = [...fromSource].sort(cmp).map((sub): Node => {
    const subLines = lines.filter((line) => line.subcommand === sub);
    return withWho(
      {
        name: sub,
        hidden: subLines.length === 0,
        usage: subLines.map((line) => line.line),
        flags: flagsOn(subLines, helpFlags(help, texts), rel),
        positionals: mergePositionals(subLines),
        subcommands: [],
      },
      `${name}:${sub}`,
    );
  });

  const node: Node = {
    name,
    hidden,
    usage: lines.map((line) => line.line),
    flags: flagsOn(ownLines, extra, rel),
    positionals: mergePositionals(ownLines),
    subcommands,
  };
  if (literals.length > 0) node.literals = literals;
  return node;
}

function nameEquals(expr: ts.Expression): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      const left = unwrap(node.left);
      const right = unwrap(node.right);
      if (ts.isIdentifier(left) && left.text === 'name' && ts.isStringLiteral(right)) found.push(right.text);
      if (ts.isIdentifier(right) && right.text === 'name' && ts.isStringLiteral(left)) found.push(left.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(expr);
  return found;
}

function importSpec(node: ts.Node): string | null {
  let found: string | null = null;
  const visit = (current: ts.Node): void => {
    if (ts.isCallExpression(current) && current.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = current.arguments[0];
      if (arg && ts.isStringLiteral(arg)) found = arg.text;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function srcPath(spec: string): string {
  if (!spec.startsWith('./') || !spec.endsWith('.ts')) throw new Error(`unexpected import ${spec}`);
  return `src/${spec.slice(2)}`;
}

function includesOf(source: ts.SourceFile, ident: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'includes' &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === ident
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) found.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** An identifier, or a quoted command that needs a hyphen (`'ask-show'`). */
function propertyKey(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) && /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(name.text)) return name.text;
  return null;
}

function tableOf(source: ts.SourceFile): { name: string; rel: string }[] {
  let found: { name: string; rel: string }[] | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'commands' && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      found = node.initializer.properties.map((property) => {
        if (!ts.isPropertyAssignment(property)) throw new Error('src/cli.ts: command table has an unexpected entry');
        const key = propertyKey(property.name);
        if (key === null) throw new Error('src/cli.ts: command table has an unexpected entry');
        const spec = importSpec(property.initializer);
        if (!spec) throw new Error(`src/cli.ts: ${key} does not import a command`);
        return { name: key, rel: srcPath(spec) };
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error('src/cli.ts: missing commands table');
  return found;
}

type Hidden = { name: string; rel: string | null };

function dispatcher(source: ts.SourceFile): { flags: string[]; helpWords: string[]; hidden: Hidden[] } {
  const flags: string[] = [];
  const helpWords: string[] = [];
  const hidden: Hidden[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      const literals = nameEquals(node.expression);
      if (literals.length > 0) {
        const spec = importSpec(node.thenStatement);
        for (const literal of literals) {
          if (literal.startsWith('-')) flags.push(literal);
          else if (spec) hidden.push({ name: literal, rel: srcPath(spec) });
          else helpWords.push(literal);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { flags, helpWords, hidden };
}

function emptyNode(name: string, hidden: boolean, usage: string[]): Node {
  return { name, hidden, usage, flags: [], positionals: [], subcommands: [] };
}

/**
 * The word's who-may-run row. The map holds one for every command and every subcommand, and its
 * kind and `why` are copied as they stand — the contract repeats the decision record, it does
 * not reword it. A word the map does not name stops generation: the map is closed on purpose (a
 * word it does not name is refused by the resolver, not judged), so a command added to the CLI
 * without a row must never reach the adapter as a tool. Naming the word here is the failure.
 */
function whoOf(key: string): Who {
  const gate = COMMAND_GATES[key];
  if (gate === undefined) {
    throw new Error(`the command-to-capability map holds no row for "${key}": every command and subcommand the contract exposes needs one`);
  }
  // The terminal requirement is copied with the row: the module's `detachedRefusal` reads the
  // same route, so a run with no terminal is refused exactly as the command refuses it.
  return gate.terminal === undefined
    ? { gate: gate.kind, why: gate.why }
    : { gate: gate.kind, why: gate.why, terminal: gate.terminal };
}

function withWho(node: Node, key: string = node.name): Node {
  node.who = whoOf(key);
  return node;
}

export function extract(root: string = rootOf(), overrides?: ReadonlyMap<string, string>): Contract {
  const once = repeatable(root, overrides);
  const cliText = load(root, 'src/cli.ts', overrides);
  const cli = sourceOf('src/cli.ts', cliText);
  const programUsage = stringConst(cli, 'USAGE', false);
  if (programUsage === null) throw new Error('src/cli.ts: missing USAGE');
  const programLines = usageLines(programUsage);
  if (programLines.length !== 1) throw new Error('src/cli.ts: expected one program usage line');
  const programLine = programLines[0] as string;
  const programParsed = parseProgramLine(programLine, 'src/cli.ts');
  const dispatch = dispatcher(cli);
  const after = [...new Set(includesOf(cli, 'rest'))].sort(cmp);
  const table = tableOf(cli);

  const programFlags: Flag[] = [...new Set(dispatch.flags)].sort(cmp).map((name) => ({
    name,
    takesValue: false,
    repeatable: once,
    hidden: !tokenIn(programUsage, name),
  }));
  for (const flag of programParsed.flags) {
    if (!programFlags.some((known) => known.name === flag.name)) {
      throw new Error(`src/cli.ts: usage names ${flag.name} but the program does not accept it`);
    }
  }

  const commands: Node[] = table.map((entry) =>
    withWho(commandNode(entry.name, false, entry.rel, load(root, entry.rel, overrides), after, programUsage)),
  );
  for (const entry of dispatch.hidden) {
    if (table.some((command) => command.name === entry.name)) throw new Error(`src/cli.ts: ${entry.name} is listed and hidden`);
    commands.push(
      withWho(
        entry.rel
          ? commandNode(entry.name, true, entry.rel, load(root, entry.rel, overrides), [], programUsage)
          : emptyNode(entry.name, true, []),
      ),
    );
  }
  for (const word of [...new Set(dispatch.helpWords)].sort(cmp)) {
    if (commands.some((command) => command.name === word)) throw new Error(`src/cli.ts: ${word} is already a command`);
    commands.push(withWho(emptyNode(word, true, [programLine])));
  }
  commands.sort((a, b) => cmp(a.name, b.name));

  return {
    program: {
      name: 'team',
      hidden: false,
      usage: [programLine],
      flags: programFlags,
      positionals: programParsed.positionals.map((positional) => ({ ...positional, repeatable: once })),
      subcommands: [],
    },
    commands,
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(cmp)) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

function yn(value: boolean): string {
  return value ? 'yes' : 'no';
}

function cell(value: string): string {
  return value.replaceAll('|', '\\|');
}

function renderNode(node: Node, level: number): string[] {
  const lines: string[] = [];
  lines.push(`${'#'.repeat(level)} \`${node.name}\``, '', `Hidden: ${yn(node.hidden)}`, '');
  if (node.usage.length === 0) lines.push('Usage: none', '');
  else lines.push('Usage:', '', ...node.usage.map((line) => `    ${line}`), '');
  if (node.literals && node.literals.length > 0) lines.push(`Literal: ${node.literals.map((word) => `\`${word}\``).join(', ')}`, '');
  if (node.who) {
    lines.push(`${'#'.repeat(level + 1)} Who may run it`, '', `\`${node.who.gate}\` — ${node.who.why}`, '');
    if (node.who.terminal) {
      lines.push(`A run with no terminal is refused: only ${node.who.terminal.who} runs this, from ${node.who.terminal.where}`, '');
    }
  }
  lines.push(`${'#'.repeat(level + 1)} Flags`, '');
  if (node.flags.length === 0) lines.push('None.', '');
  else {
    lines.push('| Flag | Takes a value | Repeatable | Hidden |', '| --- | --- | --- | --- |');
    for (const flag of node.flags) {
      lines.push(`| \`${cell(flag.name)}\` | ${yn(flag.takesValue)} | ${yn(flag.repeatable)} | ${yn(flag.hidden)} |`);
    }
    lines.push('');
  }
  lines.push(`${'#'.repeat(level + 1)} Positionals`, '');
  if (node.positionals.length === 0) lines.push('None.', '');
  else {
    lines.push('| Name | Optional | Repeatable |', '| --- | --- | --- |');
    for (const positional of node.positionals) {
      lines.push(`| \`${cell(positional.name)}\` | ${yn(positional.optional)} | ${yn(positional.repeatable)} |`);
    }
    lines.push('');
  }
  for (const sub of node.subcommands) lines.push(...renderNode(sub, level + 1));
  return lines;
}

function markdownFrom(contract: Contract): string {
  const body = [
    '# CLI reference',
    '',
    'Generated from `contract/cli.json` by `scripts/contract.ts`. This file is checked in; `bun run contract:check` builds both from the command definitions and fails when either copy differs.',
    '',
    ...renderNode(contract.program, 2),
    ...contract.commands.flatMap((command) => renderNode(command, 2)),
  ];
  return `${body.join('\n').replace(/\n+$/, '')}\n`;
}

export function renderContract(root: string = rootOf(), overrides?: ReadonlyMap<string, string>): { json: string; markdown: string } {
  const json = `${JSON.stringify(sortKeys(extract(root, overrides)), null, 2)}\n`;
  const markdown = markdownFrom(JSON.parse(json) as Contract);
  return { json, markdown };
}

function firstDifference(rel: string, produced: string, checkedIn: string): string {
  const got = produced.split('\n');
  const have = checkedIn.split('\n');
  const count = Math.max(got.length, have.length);
  for (let index = 0; index < count; index += 1) {
    if (got[index] !== have[index]) {
      return `${rel}:${index + 1}: definitions produce ${JSON.stringify(got[index] ?? '')}, file has ${JSON.stringify(have[index] ?? '')}`;
    }
  }
  return `${rel} differs from the command definitions`;
}

export function checkContract(root: string = rootOf(), overrides?: ReadonlyMap<string, string>): { ok: boolean; message: string } {
  const rendered = renderContract(root, overrides);
  const problems: string[] = [];
  const files = [
    [JSON_REL, rendered.json],
    [MARKDOWN_REL, rendered.markdown],
  ] as const;
  for (const [rel, produced] of files) {
    let checkedIn: string;
    try {
      checkedIn = readFileSync(join(root, rel), 'utf8');
    } catch {
      problems.push(`${rel} is missing`);
      continue;
    }
    if (checkedIn !== produced) problems.push(firstDifference(rel, produced, checkedIn));
  }
  if (problems.length > 0) return { ok: false, message: `${problems.join('\n')}\ncontract:check: failed` };
  return { ok: true, message: 'contract:check: contract/cli.json and docs/reference/cli.md are current' };
}

function writeContract(root: string): void {
  const rendered = renderContract(root);
  for (const [rel, text] of [
    [JSON_REL, rendered.json],
    [MARKDOWN_REL, rendered.markdown],
  ] as const) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  console.log('contract: wrote contract/cli.json and docs/reference/cli.md');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] !== undefined && args[0] !== '--check')) {
    console.error('Usage: bun scripts/contract.ts [--check]');
    process.exitCode = 2;
  } else {
    try {
      if (args[0] === '--check') {
        const result = checkContract();
        if (result.ok) console.log(result.message);
        else {
          console.error(result.message);
          process.exitCode = 1;
        }
      } else writeContract(rootOf());
    } catch (error) {
      console.error(`contract: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}

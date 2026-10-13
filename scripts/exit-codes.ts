// The exit-code contract. `contract/exit-codes.json` lists every way a command ends.
// `docs/reference/exit-codes.md` is generated from that list.
//
// The gate keeps that list complete against ordinary changes to the commands (a new return, a
// new exit, a changed code). It reads the forms this codebase uses and refuses anything else.
// It is not a proof against code written to deceive it (`eval`, a patched `process`, a dynamic
// property name).
//
// A returned expression is a numeric literal with a marker, a conditional whose branches are
// both such, or an `await`/call of a function the gate has walked. That callee needs at least
// one return, and every path through it must end in a return or a throw. Type assertions and
// non-null assertions are looked through. The callee is the nearest binding walking outward
// from the call. Only a function declaration, a `const` initialised with a function, or an
// import is followed. A `const { name } = await import('literal')` is that module's export.
// A parameter, a `let` or `var`, any other `const`, any other destructured binding, a
// catch or loop binding, a class, an enum or a namespace is refused, and so is a binding that
// hides a function or an import further out. The same name in two functions is the one in
// scope at the call. In `src/cli.ts` the only `.default()` that is not itself an exit
// is `command.default`, where `command` is the awaited load from the `commands` table and that
// binding is the nearest one of its name at the call.
//
// A file under `src/commands/` is a command. The gate walks its default export when that
// export is a function in the file: a default function, a function expression, or a name
// declared there. A re-export, a default that names an import, and a file with no default
// are refused. The `commands` table and those files are one-to-one: a key equals its
// module's basename, no two keys load one file, and every file has one key. The contract's
// command names are those keys. A mismatch names the key and the file.
//
// Accepted, and anything else is refused:
// - a commands-table entry `name: () => import('./commands/<name>.ts')`, where `name` is an identifier
//   or a string literal whose text is a hyphenated command (`'ask-show'`). A quoted word with no
//   hyphen is still refused, so the table cannot hide an alias behind quotes.
// - a command's default export that is a function declared in that file
// - `return` of a marked numeric literal, a conditional of those, or a call the gate has walked
// - `process.exit` and plain `process.exitCode =` of a marked numeric literal
// - the two publishes of a code already returned: `process.exitCode = code` on `main(...).then`, and
//   `process.exitCode = reportFailure(...)` only when that call is the `reportFailure` declared in `src/cli.ts`
// - no `var`: a declaration fails the check, with the file, the line and the name: the exit-code gate doesn't model var scoping; use let or const
// - a function declaration inside a block, other than the top of a function body or a module, fails when a returned call would resolve to it
//
// A `break` or `continue` nested inside a `switch` or a loop means that statement does not always
// complete, except a `break` or `continue` that is itself a statement of a `case`. A write to
// `process.exitCode` other than plain `=` (`||=`, `??=`, `&&=`, `+=`, `++`, `process['exitCode']`,
// a destructuring target, `Object.assign(process, …)`, `Reflect.set` or `Object.defineProperty`)
// is refused. A shared helper is walked once for each command that reaches it. `reportFailure`'s
// returned codes are read by that same analysis; if they are not numeric literals, the check fails.
//
// The gate catches mistakes in ordinary command code; it isn't proof against code written to evade it.
//
// Every `process.exit` and every write to `process.exitCode` under `src/` is scanned, including
// module scope. A numeric literal on plain `=` is a site and needs a marker. `process.exit()` with
// no argument, a write that is not a literal, or any other way of writing `exitCode`, is an error.
// Two publishes are not sites: `process.exitCode = code` in the `.then` callback of `main`, and
// `process.exitCode = reportFailure(...)` for the declaration in `src/cli.ts`.
//
// A `throw` with its own marker is a row. An unmarked `throw` a run function can reach outside
// a try that catches it is covered by `team.command-threw`.
//
//   bun scripts/exit-codes.ts --check
//   bun scripts/exit-codes.ts --write
//   bun scripts/exit-codes.ts --shared
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const contractPath = join(root, 'contract', 'exit-codes.json');
const pagePath = join(root, 'docs', 'reference', 'exit-codes.md');

export type ExitRow = {
  code: number;
  command: string;
  id: string;
  meaning: string;
  trigger: string;
};

type Contract = { format: 1; rows: ExitRow[] };

export type ExitSite = {
  codes: number[];
  command: string;
  file: string;
  ids: string[];
  line: number;
};

const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const MARKER = /\/\/\s*exit:\s*([a-z0-9]+(?:[.-][a-z0-9]+)*)\s*$/;
const UNROOTED = "a command file whose default export the contract can't read";
const TABLE_FORM = "a commands-table entry the contract can't read";

type CommandFile = { command: string; file: string };
type TableEntry = { key: string; line: number; spec: string };

export type CheckInput = {
  contractText?: string;
  files?: ReadonlyMap<string, string>;
  page?: string;
};

function textOf(file: string, files?: ReadonlyMap<string, string>): string {
  const over = files?.get(file);
  if (over !== undefined) return over;
  return readFileSync(join(root, file), 'utf8');
}

function sourceOf(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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

/** Numeric codes a return can end on, or null when the return is not an exit. */
function exitCodes(expression: ts.Expression): number[] | null {
  const expr = unwrap(expression);
  if (ts.isNumericLiteral(expr)) {
    const code = Number(expr.text);
    return Number.isInteger(code) ? [code] : null;
  }
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(expr.operand)) {
    return null;
  }
  if (!ts.isConditionalExpression(expr)) return null;
  const whenTrue = exitCodes(expr.whenTrue);
  const whenFalse = exitCodes(expr.whenFalse);
  if (!whenTrue || !whenFalse) return null;
  return [...new Set([...whenTrue, ...whenFalse])].sort((a, b) => a - b);
}

function markerIds(source: ts.SourceFile, ranges: readonly ts.CommentRange[]): string[] {
  const ids: string[] = [];
  for (const range of ranges) {
    const hit = MARKER.exec(source.text.slice(range.pos, range.end));
    if (hit?.[1]) ids.push(hit[1]);
  }
  return ids;
}

function attachedIds(source: ts.SourceFile, node: ts.Node): string[] {
  const start = node.getStart(source);
  const leading = commentsAbove(source.text, start);
  const trailing = ts.getTrailingCommentRanges(source.text, node.end) ?? [];
  return [...leading, ...markerIds(source, trailing)];
}

/** `// exit:` comments on the lines immediately above a statement. */
function commentsAbove(text: string, start: number): string[] {
  const ids: string[] = [];
  let lineEnd = start;
  while (lineEnd > 0 && text[lineEnd - 1] !== '\n') lineEnd--;
  let cursor = lineEnd;
  while (cursor > 0) {
    const prev = text.lastIndexOf('\n', cursor - 2);
    const line = text.slice(prev + 1, cursor - 1);
    if (line.trim() === '') {
      cursor = prev + 1;
      if (prev < 0) break;
      continue;
    }
    const hit = MARKER.exec(line);
    if (!hit?.[1]) break;
    ids.unshift(hit[1]);
    if (prev < 0) break;
    cursor = prev + 1;
  }
  return ids;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function isProcess(expression: ts.Expression, name: string): boolean {
  const expr = unwrap(expression);
  return ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'process' && expr.name.text === name;
}

/** `process.exitCode`, `process['exitCode']`, or an element access on `process` whose name is not a literal. */
function isExitCodeTarget(expression: ts.Expression): boolean {
  if (isProcess(expression, 'exitCode')) return true;
  const expr = unwrap(expression);
  if (!ts.isElementAccessExpression(expr)) return false;
  const recv = unwrap(expr.expression);
  if (!ts.isIdentifier(recv) || recv.text !== 'process') return false;
  const arg = expr.argumentExpression;
  if (!arg) return true;
  const name = unwrap(arg);
  if (!ts.isStringLiteral(name)) return true;
  return name.text === 'exitCode';
}

function containsExitCodeTarget(node: ts.Node): boolean {
  let hit = false;
  const visit = (current: ts.Node): void => {
    if (hit || (current !== node && isFunc(current))) return;
    if (ts.isExpression(current) && isExitCodeTarget(current)) {
      hit = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return hit;
}

/** `Object.assign(process, …)`, or `Reflect.set` / `Object.defineProperty` writing `exitCode`. */
function writesExitCodeByCall(node: ts.CallExpression): boolean {
  const expr = unwrap(node.expression);
  if (!ts.isPropertyAccessExpression(expr) || !ts.isIdentifier(expr.expression)) return false;
  const owner = expr.expression.text;
  const method = expr.name.text;
  const first = node.arguments[0];
  if (!first) return false;
  const target = unwrap(first);
  if (!ts.isIdentifier(target) || target.text !== 'process') return false;
  if (owner === 'Object' && method === 'assign') return true;
  if (!((owner === 'Reflect' && method === 'set') || (owner === 'Object' && method === 'defineProperty'))) return false;
  const prop = node.arguments[1];
  if (!prop) return true;
  const name = unwrap(prop);
  if (!ts.isStringLiteral(name)) return true;
  return name.text === 'exitCode';
}

function callName(expression: ts.Expression): string | null {
  const expr = unwrap(expression);
  if (!ts.isCallExpression(expr)) return null;
  const called = unwrap(expr.expression);
  return ts.isIdentifier(called) ? called.text : null;
}

function numericArgument(expression: ts.Expression): number | null {
  const expr = unwrap(expression);
  if (!ts.isNumericLiteral(expr)) return null;
  const code = Number(expr.text);
  return Number.isInteger(code) ? code : null;
}

const UNREADABLE = "exit expression the contract can't read: return a marked literal or a covered call";

type ExitFunc = ts.FunctionLikeDeclaration;

export type CoveredThrow = { file: string; line: number; id: string };

export type Analysis = {
  coveredThrows: CoveredThrow[];
  sites: ExitSite[];
  unreadable: string[];
};

function isFunc(node: ts.Node): node is ExitFunc {
  return ts.isFunctionLike(node);
}

function unwrapExit(node: ts.Expression): ts.Expression {
  let current = unwrap(node);
  while (ts.isAwaitExpression(current)) current = unwrap(current.expression);
  return current;
}

/** Visit a function without entering nested functions. */
function visitOwn(fn: ts.Node, on: (node: ts.Node) => void): void {
  const visit = (node: ts.Node): void => {
    if (node !== fn && isFunc(node)) return;
    on(node);
    ts.forEachChild(node, visit);
  };
  visit(fn);
}

function insideCatchingTry(node: ts.Node): boolean {
  let current = node.parent;
  while (current) {
    if (ts.isTryStatement(current) && current.catchClause) {
      const block = current.tryBlock;
      if (node.getStart() >= block.getStart() && node.getEnd() <= block.getEnd()) return true;
    }
    current = current.parent;
  }
  return false;
}

function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = join(dirname(from), spec).replaceAll('\\', '/');
  return base.endsWith('.ts') ? base : `${base}.ts`;
}

function commandFor(list: readonly CommandFile[], file: string, inherited: string): string {
  return list.find((item) => item.file === file)?.command ?? inherited;
}

/** `() => import('<literal>')` only. Parentheses and assertions around it are looked through. */
function plainImport(expr: ts.Expression): string | null {
  const arrow = unwrap(expr);
  if (!ts.isArrowFunction(arrow)) return null;
  if (arrow.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.AsyncKeyword)) return null;
  if (ts.isBlock(arrow.body)) return null;
  const call = unwrap(arrow.body);
  if (!ts.isCallExpression(call) || call.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
  if (call.arguments.length !== 1) return null;
  const spec = call.arguments[0];
  if (!spec || !ts.isStringLiteral(spec)) return null;
  return spec.text;
}

function tableMemberName(prop: ts.ObjectLiteralElementLike): string {
  if (ts.isSpreadAssignment(prop)) return 'spread';
  if (ts.isShorthandPropertyAssignment(prop)) return prop.name.text;
  const name = prop.name;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return 'computed';
  return 'entry';
}

/** An identifier, or a quoted command that needs a hyphen (`'ask-show'`). A quoted word with no hyphen is not a key. */
function commandKey(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) && /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(name.text)) return name.text;
  return null;
}

/**
 * The exported `commands` object. Only `name: () => import('<literal>')` is an entry,
 * and `name` is an identifier or a hyphenated string literal. Every other member is a
 * problem, named at its line.
 */
function commandTable(text: string): { entries: TableEntry[]; problems: string[] } {
  const source = sourceOf('src/cli.ts', text);
  const entries: TableEntry[] = [];
  const problems: string[] = [];
  let found = false;
  for (const stmt of source.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    if (!stmt.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== 'commands') continue;
      found = true;
      if (!decl.initializer) {
        problems.push(`src/cli.ts:${lineOf(source, decl)}: commands: ${TABLE_FORM}`);
        continue;
      }
      const obj = unwrap(decl.initializer);
      if (!ts.isObjectLiteralExpression(obj)) {
        problems.push(`src/cli.ts:${lineOf(source, decl.initializer)}: commands: ${TABLE_FORM}`);
        continue;
      }
      for (const prop of obj.properties) {
        const line = lineOf(source, prop);
        if (ts.isPropertyAssignment(prop)) {
          const key = commandKey(prop.name);
          if (key !== null) {
            const spec = plainImport(prop.initializer);
            if (spec !== null) {
              entries.push({ key, spec, line });
              continue;
            }
          }
        }
        problems.push(`src/cli.ts:${line}: ${tableMemberName(prop)}: ${TABLE_FORM}`);
      }
    }
  }
  if (!found) problems.push(`src/cli.ts:1: commands: ${TABLE_FORM}`);
  return { entries, problems };
}

function moduleBase(file: string): string {
  const slash = file.lastIndexOf('/');
  const base = slash >= 0 ? file.slice(slash + 1) : file;
  return base.endsWith('.ts') ? base.slice(0, -3) : base;
}

function commandFiles(extra?: ReadonlyMap<string, string>): CommandFile[] {
  const names = new Set(
    readdirSync(join(root, 'src', 'commands')).filter((name) => name.endsWith('.ts')),
  );
  const keysByName = new Map<string, string[]>();
  for (const entry of commandTable(textOf('src/cli.ts', extra)).entries) {
    const target = resolveSpec('src/cli.ts', entry.spec);
    if (!target?.startsWith('src/commands/') || !target.endsWith('.ts')) continue;
    const name = target.slice('src/commands/'.length);
    if (name.includes('/')) continue;
    if (!names.has(name) && !extra?.has(target)) continue;
    names.add(name);
    const keys = keysByName.get(name) ?? [];
    keys.push(entry.key);
    keysByName.set(name, keys);
  }
  return [
    { command: 'team', file: 'src/cli.ts' },
    { command: 'conformance-adapter', file: 'src/conformance/adapter.ts' },
    ...[...names].sort().map((name) => {
      const keys = keysByName.get(name) ?? [];
      const command = keys.length === 1 && keys[0] ? keys[0] : name.slice(0, -3);
      return { command, file: `src/commands/${name}` };
    }),
  ];
}

function defaultExportAt(source: ts.SourceFile): ts.Node {
  for (const stmt of source.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.DefaultKeyword)) return stmt;
    if (ts.isExportAssignment(stmt)) return stmt;
    if (!ts.isExportDeclaration(stmt) || !stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) continue;
    if (stmt.exportClause.elements.some((el) => el.name.text === 'default')) return stmt;
  }
  return source;
}

function filesUnderSrc(extra?: ReadonlyMap<string, string>): string[] {
  const found = new Set<string>();
  const walk = (rel: string): void => {
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      const next = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith('.ts')) found.add(next);
    }
  };
  walk('src');
  if (extra) {
    for (const key of extra.keys()) {
      if (key.startsWith('src/') && key.endsWith('.ts')) found.add(key);
    }
  }
  return [...found].sort();
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const found: string[] = [];
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) found.push(...bindingNames(el.name));
  }
  return found;
}

/** A binding this node introduces for `name`. The nearest node walking outward is the one in scope. */
type ChainHit =
  | { kind: 'function'; func: ExitFunc }
  | { kind: 'const'; init: ts.Expression }
  | { kind: 'dynamic'; spec: string; exportName: string }
  | { kind: 'other' };

/** `const { name } = await import('literal')` names that module's export. Any other pattern does not. */
function importBinding(decl: ts.VariableDeclaration, name: string, init: ts.Expression): { spec: string; exportName: string } | null {
  if (!ts.isObjectBindingPattern(decl.name)) return null;
  const awaited = ts.isAwaitExpression(init) ? unwrap(init.expression) : init;
  if (!ts.isCallExpression(awaited) || awaited.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
  const specNode = awaited.arguments[0];
  if (!specNode || !ts.isStringLiteral(specNode)) return null;
  for (const el of decl.name.elements) {
    if (!ts.isIdentifier(el.name) || el.name.text !== name || el.dotDotDotToken) continue;
    const exportName = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
    return { spec: specNode.text, exportName };
  }
  return null;
}

function hitsInNode(node: ts.Node, name: string): ChainHit[] {
  const hits: ChainHit[] = [];
  const pushDecl = (decl: ts.VariableDeclaration, loop: boolean): void => {
    if (!bindingNames(decl.name).includes(name)) return;
    const init = decl.initializer ? unwrap(decl.initializer) : null;
    const list = decl.parent;
    const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
    const dynamic = !loop && isConst && init ? importBinding(decl, name, init) : null;
    if (dynamic) hits.push({ kind: 'dynamic', spec: dynamic.spec, exportName: dynamic.exportName });
    else if (!loop && isConst && ts.isIdentifier(decl.name) && init && isFunc(init)) hits.push({ kind: 'function', func: init });
    else if (!loop && isConst && ts.isIdentifier(decl.name) && decl.initializer) hits.push({ kind: 'const', init: decl.initializer });
    else hits.push({ kind: 'other' });
  };
  if (ts.isFunctionLike(node)) {
    if (ts.isFunctionExpression(node) && node.name?.text === name) hits.push({ kind: 'function', func: node });
    for (const param of node.parameters) {
      if (bindingNames(param.name).includes(name)) hits.push({ kind: 'other' });
    }
  }
  if (ts.isCatchClause(node) && node.variableDeclaration && bindingNames(node.variableDeclaration.name).includes(name)) {
    hits.push({ kind: 'other' });
  }
  if ((ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) && node.initializer && ts.isVariableDeclarationList(node.initializer)) {
    for (const decl of node.initializer.declarations) pushDecl(decl, true);
  }
  const statements = ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node)
    ? node.statements
    : ts.isCaseClause(node) || ts.isDefaultClause(node)
      ? node.statements
      : undefined;
  if (statements) {
    for (const stmt of statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) hits.push({ kind: 'function', func: stmt });
      if (ts.isClassDeclaration(stmt) && stmt.name?.text === name) hits.push({ kind: 'other' });
      if (ts.isEnumDeclaration(stmt) && stmt.name.text === name) hits.push({ kind: 'other' });
      if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name) && stmt.name.text === name) hits.push({ kind: 'other' });
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) pushDecl(decl, false);
      }
    }
  }
  return hits;
}

/** A `var` list has none of the block-scoped flags. `using` and `await using` are not `var`. */
function isVarList(list: ts.VariableDeclarationList): boolean {
  const scoped = ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using;
  return (list.flags & scoped) === 0;
}

/** Directly in a module, or the body block of a function. A declaration in an `if` or nested block is not. */
function isBodyLevelFunction(decl: ts.FunctionDeclaration): boolean {
  const parent = decl.parent;
  if (ts.isSourceFile(parent) || ts.isModuleBlock(parent)) return true;
  if (!ts.isBlock(parent)) return false;
  const owner = parent.parent;
  if (!owner) return false;
  if (
    ts.isFunctionDeclaration(owner) ||
    ts.isFunctionExpression(owner) ||
    ts.isArrowFunction(owner) ||
    ts.isMethodDeclaration(owner) ||
    ts.isConstructorDeclaration(owner) ||
    ts.isGetAccessorDeclaration(owner) ||
    ts.isSetAccessorDeclaration(owner)
  ) {
    return owner.body === parent;
  }
  return false;
}

/**
 * A function declaration of `name` inside a nested block of the function that holds `at`.
 * The walk does not model hoisting, so a returned call of that name is refused.
 */
function nestedBlockFunction(name: string, at: ts.Node): boolean {
  let owner: ts.Node | undefined = at.parent;
  while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
  const root = owner ?? at.getSourceFile();
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && !isBodyLevelFunction(node)) {
      found = true;
      return;
    }
    if (node !== root && isFunc(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function chainHits(name: string, at: ts.Node): ChainHit[] {
  const hits: ChainHit[] = [];
  let current: ts.Node | undefined = at.parent;
  while (current) {
    hits.push(...hitsInNode(current, name));
    current = current.parent;
  }
  return hits;
}

/** The initializer of the nearest `const` of `name`. A nearer binding, or one that hides a function, is not it. */
function nearestConstInit(name: string, at: ts.Node): ts.Expression | null {
  const hits = chainHits(name, at);
  if (hits.slice(1).some((hit) => hit.kind === 'function' || hit.kind === 'dynamic')) return null;
  const first = hits[0];
  if (!first || first.kind !== 'const') return null;
  return first.init;
}

/** `command.default` only when `command` is the awaited load from the commands table. */
function isCommandDispatcher(expr: ts.CallExpression): boolean {
  const called = unwrap(expr.expression);
  if (!ts.isPropertyAccessExpression(called) || called.name.text !== 'default') return false;
  const recv = unwrap(called.expression);
  if (!ts.isIdentifier(recv)) return false;
  const loaded = nearestConstInit(recv.text, expr);
  if (!loaded) return false;
  const awaited = unwrapExit(loaded);
  if (!ts.isCallExpression(awaited)) return false;
  const callee = unwrap(awaited.expression);
  if (!ts.isIdentifier(callee)) return false;
  const loader = nearestConstInit(callee.text, expr);
  if (!loader) return false;
  const access = unwrap(loader);
  if (!ts.isElementAccessExpression(access)) return false;
  const table = unwrap(access.expression);
  return ts.isIdentifier(table) && table.text === 'commands';
}

/** The `.then` of `main` forwarding its code, or the one known `reportFailure` declaration. */
function isPublishedExitCode(expr: ts.BinaryExpression, knownReport: (call: ts.CallExpression) => boolean): boolean {
  const right = unwrap(expr.right);
  if (ts.isCallExpression(right) && knownReport(right)) return true;
  if (!ts.isIdentifier(right)) return false;
  let fn: ts.Node | undefined = expr.parent;
  while (fn && !isFunc(fn)) fn = fn.parent;
  if (!fn || !isFunc(fn)) return false;
  const param = fn.parameters[0];
  if (!param || !ts.isIdentifier(param.name) || param.name.text !== right.text) return false;
  const call = fn.parent;
  if (!call || !ts.isCallExpression(call) || call.arguments[0] !== fn) return false;
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'then') return false;
  const recv = unwrap(callee.expression);
  if (!ts.isCallExpression(recv)) return false;
  const called = unwrap(recv.expression);
  return ts.isIdentifier(called) && called.text === 'main';
}

function alwaysCompletes(node: ts.Node): boolean {
  if (ts.isFunctionLike(node)) return false;
  if (ts.isBlock(node)) {
    for (const stmt of node.statements) if (alwaysCompletes(stmt)) return true;
    return false;
  }
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
  if (ts.isIfStatement(node)) {
    if (!node.elseStatement) return false;
    return alwaysCompletes(node.thenStatement) && alwaysCompletes(node.elseStatement);
  }
  if (ts.isTryStatement(node)) {
    if (node.finallyBlock && alwaysCompletes(node.finallyBlock)) return true;
    if (!alwaysCompletes(node.tryBlock)) return false;
    return node.catchClause ? alwaysCompletes(node.catchClause.block) : true;
  }
  if (ts.isSwitchStatement(node)) return switchCompletes(node);
  if (ts.isLabeledStatement(node)) return alwaysCompletes(node.statement);
  return false;
}

/** A `break` or `continue` nested in this statement. A nested function's own breaks are not counted. */
function containsAbrupt(node: ts.Node): boolean {
  let hit = false;
  const visit = (current: ts.Node): void => {
    if (hit || (current !== node && isFunc(current))) return;
    if (ts.isBreakStatement(current) || ts.isContinueStatement(current)) {
      hit = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return hit;
}

function switchCompletes(sw: ts.SwitchStatement): boolean {
  const clauses = sw.caseBlock.clauses;
  if (!clauses.some((clause) => ts.isDefaultClause(clause))) return false;
  let fallsInto = false;
  const exits: boolean[] = [];
  for (let i = clauses.length - 1; i >= 0; i--) {
    const clause = clauses[i];
    if (!clause) continue;
    let kind: 'exit' | 'break' | 'fall' = 'fall';
    for (const stmt of clause.statements) {
      if (ts.isBreakStatement(stmt) || ts.isContinueStatement(stmt)) {
        kind = 'break';
        break;
      }
      // A conditional `break` or a `break` inside a loop is not a path the gate can finish.
      if (containsAbrupt(stmt)) return false;
      if (ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt) || alwaysCompletes(stmt)) {
        kind = 'exit';
        break;
      }
    }
    const exitsHere: boolean = kind === 'exit' || (kind === 'fall' && fallsInto);
    exits[i] = exitsHere;
    fallsInto = kind === 'break' ? false : exitsHere;
  }
  return exits.every(Boolean);
}

/** A followed callee has a return, and no path falls off its end. */
function returnsCovered(func: ExitFunc): boolean {
  if (ts.isArrowFunction(func) && func.body && !ts.isBlock(func.body)) return true;
  const body = func.body;
  if (!body || !ts.isBlock(body)) return false;
  if (ownReturns(func).length === 0) return false;
  return alwaysCompletes(body);
}

function allMarkers(text: string): { id: string; line: number }[] {
  const out: { id: string; line: number }[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const hit = MARKER.exec(lines[i] ?? '');
    if (hit?.[1]) out.push({ id: hit[1], line: i + 1 });
  }
  return out;
}

/**
 * The gate follows each returned call and requires that callee to be fully covered too.
 * A throw with no row of its own is covered by `team.command-threw`.
 */
export function analyze(files?: ReadonlyMap<string, string>): Analysis {
  const list = commandFiles(files);
  const parsed = new Map<string, ts.SourceFile>();
  const named = new Map<string, Map<string, ExitFunc>>();
  const imported = new Map<string, Map<string, { file: string; exportName: string }>>();
  const sites: ExitSite[] = [];
  const unreadable: string[] = [];
  const coveredThrows: CoveredThrow[] = [];
  const returnSeen = new Set<string>();
  const throwSeen = new Set<string>();
  let thrown: number[] = [];

  const unreadFiles = new Set<string>();
  function unread(file: string): void {
    if (unreadFiles.has(file)) return;
    unreadFiles.add(file);
    unreadable.push(`${file}:1: the contract can't read this file`);
  }

  function load(file: string): ts.SourceFile | null {
    const hit = parsed.get(file);
    if (hit) return hit;
    let text: string;
    try {
      text = textOf(file, files);
    } catch {
      unread(file);
      return null;
    }
    const source = sourceOf(file, text);
    parsed.set(file, source);
    return source;
  }

  function functionsIn(source: ts.SourceFile): Map<string, ExitFunc> {
    const hit = named.get(source.fileName);
    if (hit) return hit;
    const map = new Map<string, ExitFunc>();
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name && !map.has(node.name.text)) map.set(node.name.text, node);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const init = unwrap(node.initializer);
        if (isFunc(init) && !map.has(node.name.text)) map.set(node.name.text, init);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    named.set(source.fileName, map);
    return map;
  }

  function moduleBindings(source: ts.SourceFile, file: string): Map<string, { file: string; exportName: string }> {
    const hit = imported.get(file);
    if (hit) return hit;
    const map = new Map<string, { file: string; exportName: string }>();
    for (const stmt of source.statements) {
      if (!ts.isImportDeclaration(stmt) || stmt.importClause?.isTypeOnly || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const target = resolveSpec(file, stmt.moduleSpecifier.text);
      const clause = stmt.importClause;
      if (!target || !clause) continue;
      if (clause.name) map.set(clause.name.text, { file: target, exportName: 'default' });
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          if (el.isTypeOnly || !ts.isIdentifier(el.name)) continue;
          const exportName = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
          map.set(el.name.text, { file: target, exportName });
        }
      }
    }
    imported.set(file, map);
    return map;
  }

  function exportedFunction(source: ts.SourceFile, name: string): ExitFunc | null {
    if (name !== 'default') return functionsIn(source).get(name) ?? null;
    for (const stmt of source.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.DefaultKeyword)) return stmt;
      if (!ts.isExportAssignment(stmt)) continue;
      const expr = unwrap(stmt.expression);
      if (isFunc(expr)) return expr;
      if (ts.isIdentifier(expr)) return functionsIn(source).get(expr.text) ?? null;
    }
    return null;
  }

  function loadExport(file: string, name: string): { file: string; func: ExitFunc } | null {
    const source = load(file);
    if (!source) return null;
    const func = exportedFunction(source, name);
    return func ? { file, func } : null;
  }

  function resolveCall(
    call: ts.CallExpression,
    file: string,
    source: ts.SourceFile,
  ): { file: string; func: ExitFunc } | { unreadable: string } | null {
    const called = unwrap(call.expression);
    if (!ts.isIdentifier(called)) return null;
    const name = called.text;
    if (nestedBlockFunction(name, call)) return { unreadable: name };
    const hits: (ChainHit | { kind: 'import'; file: string; exportName: string })[] = chainHits(name, call);
    const imported = moduleBindings(source, file).get(name);
    if (imported) hits.push({ kind: 'import', file: imported.file, exportName: imported.exportName });
    if (hits.length === 0) return null;
    const followable = (hit: (typeof hits)[number]): boolean => hit.kind === 'function' || hit.kind === 'import' || hit.kind === 'dynamic';
    // The nearest binding wins. A parameter, a let, a non-function const, or any other binding is
    // not followed, and neither is a binding that hides a function or an import further out.
    if (hits.slice(1).some(followable) || !followable(hits[0]!)) return { unreadable: name };
    const first = hits[0]!;
    if (first.kind === 'function') return { file, func: first.func };
    if (first.kind === 'import') return loadExport(first.file, first.exportName);
    if (first.kind === 'dynamic') {
      const target = resolveSpec(file, first.spec);
      return target ? loadExport(target, first.exportName) : { unreadable: name };
    }
    return { unreadable: name };
  }

  function reject(file: string, source: ts.SourceFile, node: ts.Node): void {
    unreadable.push(`${file}:${lineOf(source, node)}: ${UNREADABLE}`);
  }

  function classify(expr: ts.Expression, file: string, fn: ts.Node, at: ts.Node, command: string, fromArrow: boolean): void {
    const source = load(file);
    if (!source) return;
    const unwrapped = unwrapExit(expr);
    const codes = exitCodes(unwrapped);
    if (codes) {
      if (fromArrow) reject(file, source, at);
      else sites.push({ command, file, line: lineOf(source, at), codes, ids: attachedIds(source, at) });
      return;
    }
    if (ts.isConditionalExpression(unwrapped)) {
      classify(unwrapped.whenTrue, file, fn, at, command, fromArrow);
      classify(unwrapped.whenFalse, file, fn, at, command, fromArrow);
      return;
    }
    if (ts.isCallExpression(unwrapped)) {
      if (file === 'src/cli.ts' && isCommandDispatcher(unwrapped)) return;
      const resolved = resolveCall(unwrapped, file, source);
      if (resolved && 'unreadable' in resolved) {
        unreadable.push(`${file}:${lineOf(source, at)}: ${resolved.unreadable}: ${UNREADABLE}`);
        return;
      }
      if (!resolved) {
        reject(file, source, at);
        return;
      }
      walkReturns(resolved.file, resolved.func, commandFor(list, resolved.file, command));
      return;
    }
    reject(file, source, at);
  }

  function walkReturns(file: string, func: ExitFunc, command: string): void {
    const source = load(file);
    if (!source) return;
    const key = `${command}\0${file}:${func.getStart(source)}`;
    if (returnSeen.has(key)) return;
    returnSeen.add(key);
    if (!returnsCovered(func)) reject(file, source, func);
    if (ts.isArrowFunction(func) && !ts.isBlock(func.body)) classify(func.body, file, func, func.body, command, true);
    for (const ret of ownReturns(func)) {
      if (!ret.expression) {
        reject(file, source, ret);
        continue;
      }
      classify(ret.expression, file, func, ret, command, false);
    }
  }

  function knownReport(call: ts.CallExpression): boolean {
    const source = call.getSourceFile();
    const file = source.fileName.replaceAll('\\', '/');
    const resolved = resolveCall(call, file.startsWith('src/') ? file.slice(file.indexOf('src/')) : file, source);
    if (!resolved || !('func' in resolved) || resolved.file !== 'src/cli.ts') return false;
    const cli = load('src/cli.ts');
    const known = cli ? functionsIn(cli).get('reportFailure') : undefined;
    return known !== undefined && known === resolved.func;
  }

  function scanExits(file: string): void {
    const source = load(file);
    if (!source) return;
    const command = commandFor(list, file, 'team');
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isProcess(node.expression, 'exit')) {
        const arg = node.arguments[0];
        const code = arg ? numericArgument(arg) : null;
        if (arg && code !== null) {
          sites.push({ command, file, line: lineOf(source, node), codes: [code], ids: attachedIds(source, node) });
        } else {
          reject(file, source, node);
        }
      }
      if (ts.isCallExpression(node) && writesExitCodeByCall(node)) reject(file, source, node);
      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
        isExitCodeTarget(node.operand)
      ) {
        reject(file, source, node);
      }
      if (ts.isBinaryExpression(node) && containsExitCodeTarget(node.left)) {
        const plain = node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isProcess(node.left, 'exitCode');
        if (plain && !isPublishedExitCode(node, knownReport)) {
          const code = numericArgument(node.right);
          if (code !== null && callName(node.right) === null) {
            sites.push({ command, file, line: lineOf(source, node), codes: [code], ids: attachedIds(source, node) });
          } else {
            reject(file, source, node);
          }
        } else if (!plain) {
          reject(file, source, node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  function walkThrows(file: string, func: ExitFunc, command: string): void {
    const source = load(file);
    if (!source) return;
    const key = `${command}\0${file}:${func.getStart(source)}`;
    if (throwSeen.has(key)) return;
    throwSeen.add(key);
    const visit = (node: ts.Node): void => {
      if (node !== func && isFunc(node)) {
        walkThrows(file, node, command);
        return;
      }
      if (ts.isThrowStatement(node)) {
        const ids = attachedIds(source, node);
        if (ids.length === 0) {
          if (!insideCatchingTry(node)) coveredThrows.push({ file, line: lineOf(source, node), id: 'team.command-threw' });
        } else {
          sites.push({ command: commandFor(list, file, command), file, line: lineOf(source, node), codes: [...thrown], ids });
        }
      } else if (ts.isCallExpression(node) && !insideCatchingTry(node)) {
        const resolved = resolveCall(node, file, source);
        if (resolved && 'func' in resolved) {
          walkThrows(resolved.file, resolved.func, commandFor(list, resolved.file, command));
        }
        for (const arg of node.arguments) {
          const value = unwrap(arg);
          if (isFunc(value)) walkThrows(file, value, command);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(func);
  }

  function literalCodes(expr: ts.Expression, file: string, fn: ts.Node, stack: Set<string>): number[] | null {
    const source = load(file);
    if (!source) return null;
    const unwrapped = unwrapExit(expr);
    const direct = exitCodes(unwrapped);
    if (direct) return direct;
    if (ts.isConditionalExpression(unwrapped)) {
      const left = literalCodes(unwrapped.whenTrue, file, fn, stack);
      const right = literalCodes(unwrapped.whenFalse, file, fn, stack);
      if (!left || !right) return null;
      return [...new Set([...left, ...right])].sort((a, b) => a - b);
    }
    if (!ts.isCallExpression(unwrapped)) return null;
    const resolved = resolveCall(unwrapped, file, source);
    if (!resolved || !('func' in resolved)) return null;
    return functionCodes(resolved.file, resolved.func, stack);
  }

  function functionCodes(file: string, func: ExitFunc, stack: Set<string>): number[] | null {
    const source = load(file);
    if (!source) return null;
    const key = `${file}:${func.getStart(source)}`;
    if (stack.has(key)) return null;
    stack.add(key);
    if (!returnsCovered(func)) return null;
    const codes = new Set<number>();
    const take = (value: ts.Expression): boolean => {
      const got = literalCodes(value, file, func, stack);
      if (!got || got.length === 0) return false;
      for (const code of got) codes.add(code);
      return true;
    };
    if (ts.isArrowFunction(func) && func.body && !ts.isBlock(func.body) && !take(func.body)) return null;
    for (const ret of ownReturns(func)) {
      if (!ret.expression || !take(ret.expression)) return null;
    }
    return codes.size ? [...codes].sort((a, b) => a - b) : null;
  }

  const cliSource = load('src/cli.ts');
  const report = cliSource ? functionsIn(cliSource).get('reportFailure') : undefined;
  const thrownCodes = report ? functionCodes('src/cli.ts', report, new Set()) : null;
  if (!thrownCodes) {
    unreadable.push(`src/cli.ts:${report && cliSource ? lineOf(cliSource, report) : 1}: reportFailure's return can't be read`);
  }
  thrown = thrownCodes ?? [];

  const walked = new Set<string>();
  for (const item of list) {
    const source = load(item.file);
    if (!source) continue;
    if (item.file === 'src/cli.ts') {
      for (const name of ['main', 'reportFailure']) {
        const func = functionsIn(source).get(name);
        if (!func) {
          unreadable.push(`src/cli.ts:1: ${name} is not a function the contract can read`);
          continue;
        }
        walkReturns(item.file, func, item.command);
        walkThrows(item.file, func, item.command);
      }
      continue;
    }
    const func = exportedFunction(source, 'default');
    if (!func) {
      unreadable.push(`${item.file}:${lineOf(source, defaultExportAt(source))}: ${UNROOTED}`);
      continue;
    }
    if (item.file.startsWith('src/commands/')) walked.add(item.file);
    walkReturns(item.file, func, item.command);
    walkThrows(item.file, func, item.command);
  }
  const discovered = new Set(list.filter((item) => item.file.startsWith('src/commands/')).map((item) => item.file));
  const byFile = new Map<string, TableEntry[]>();
  const table = commandTable(textOf('src/cli.ts', files));
  for (const problem of table.problems) unreadable.push(problem);
  for (const entry of table.entries) {
    const target = resolveSpec('src/cli.ts', entry.spec);
    if (!target || !discovered.has(target)) {
      const shown = target || entry.spec || 'an unreadable module';
      unreadable.push(`src/cli.ts:${entry.line}: ${entry.key} loads ${shown}: an entry in the commands table whose module the gate didn't walk`);
      continue;
    }
    const group = byFile.get(target) ?? [];
    group.push(entry);
    byFile.set(target, group);
    if (entry.key !== moduleBase(target)) {
      unreadable.push(`src/cli.ts:${entry.line}: ${entry.key} loads ${target}, and the key is not the module's name`);
    }
  }
  for (const [file, group] of byFile) {
    if (group.length < 2) continue;
    const keys = group.map((entry) => entry.key).join(' and ');
    unreadable.push(`src/cli.ts:${group[0]?.line ?? 1}: ${keys} load ${file}`);
  }
  for (const file of [...walked].sort()) {
    const group = byFile.get(file) ?? [];
    if (group.length === 1 && group[0]?.key === moduleBase(file)) continue;
    if (group.length > 0) continue;
    const source = load(file);
    const at = source ? exportedFunction(source, 'default') ?? source : source;
    unreadable.push(`${file}:${source && at ? lineOf(source, at) : 1}: a walked file that is in no table entry`);
  }
  for (const file of filesUnderSrc(files)) {
    scanExits(file);
    const source = load(file);
    if (!source) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclarationList(node) && isVarList(node)) {
        for (const decl of node.declarations) {
          for (const name of bindingNames(decl.name)) {
            unreadable.push(
              `${file}:${lineOf(source, decl)}: ${name}: the exit-code gate doesn't model var scoping; use let or const`,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  coveredThrows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { sites, unreadable, coveredThrows };
}

function ownReturns(fn: ts.Node): ts.ReturnStatement[] {
  const out: ts.ReturnStatement[] = [];
  visitOwn(fn, (node) => {
    if (ts.isReturnStatement(node)) out.push(node);
  });
  return out;
}

export function exitSites(files?: ReadonlyMap<string, string>): ExitSite[] {
  return analyze(files).sites;
}

function byRow(a: ExitRow, b: ExitRow): number {
  return a.command.localeCompare(b.command) || a.code - b.code || a.id.localeCompare(b.id);
}

export function render(rows: readonly ExitRow[]): string {
  const sorted = [...rows].sort(byRow);
  const lines = [
    '# Exit codes',
    '',
    'Each row is one way a command ends. `0` means the work finished, `1` means the command refused or a step failed, and `2` means the invocation or a file could not be read. One `return` can be several rows when several different failures leave through it. A thrown error ends as `1`.',
    '',
    'The check keeps this list complete against ordinary changes to the commands (a new return, a new exit, a changed code); it reads the forms this codebase uses and refuses anything else; it is not a proof against code written to deceive it (`eval`, a patched `process`, a dynamic property name). The gate catches mistakes in ordinary command code; it isn\'t proof against code written to evade it.',
    '',
    '| Id | Command | Code | Meaning | Example |',
    '| --- | --- | --- | --- | --- |',
    ...sorted.map((row) => `| \`${row.id}\` | \`${row.command}\` | ${row.code} | ${row.meaning.replaceAll('|', '\\|')} | \`${row.trigger.replaceAll('|', '\\|')}\` |`),
    '',
  ];
  return lines.join('\n');
}

function canonical(contract: Contract): string {
  const rows = [...contract.rows].sort(byRow).map((row) => ({
    code: row.code,
    command: row.command,
    id: row.id,
    meaning: row.meaning,
    trigger: row.trigger,
  }));
  return `${JSON.stringify({ format: 1 as const, rows }, null, 2)}\n`;
}

export function loadContract(text = readFileSync(contractPath, 'utf8')): Contract {
  return JSON.parse(text) as Contract;
}

/**
 * Same failure under different codes, then the different failures that share a code
 * inside one command. Meanings match as written.
 */
export function sharedReport(rows: readonly ExitRow[]): string {
  const byMeaning = new Map<string, ExitRow[]>();
  for (const row of rows) {
    const list = byMeaning.get(row.meaning) ?? [];
    list.push(row);
    byMeaning.set(row.meaning, list);
  }
  const across: string[] = [];
  for (const meaning of [...byMeaning.keys()].sort()) {
    const group = byMeaning.get(meaning) ?? [];
    const codes = [...new Set(group.map((row) => row.code))];
    if (codes.length < 2) continue;
    const where = [...group].sort(byRow).map((row) => `${row.command} ${row.code}`);
    across.push(`- ${meaning}: ${where.join(', ')}`);
  }
  const within: string[] = [];
  const commands = [...new Set(rows.map((row) => row.command))].sort();
  for (const command of commands) {
    const codes = [...new Set(rows.filter((row) => row.command === command).map((row) => row.code))].sort((a, b) => a - b);
    for (const code of codes) {
      const meanings = [...new Set(rows
        .filter((row) => row.command === command && row.code === code)
        .sort(byRow)
        .map((row) => row.meaning))];
      if (meanings.length < 2) continue;
      within.push(`- ${command} ${code}: ${meanings.join('; ')}`);
    }
  }
  return [
    'Same failure, different codes:',
    ...(across.length ? across : ['- (none)']),
    '',
    'Within one command:',
    ...(within.length ? within : ['- (none)']),
    '',
  ].join('\n');
}

/** Empty when every exit site has its rows and the page matches. */
export function problems(input: CheckInput = {}): string[] {
  const contractText = input.contractText ?? readFileSync(contractPath, 'utf8');
  const page = input.page ?? readFileSync(pagePath, 'utf8');
  const out: string[] = [];
  let contract: Contract;
  try {
    contract = JSON.parse(contractText) as Contract;
  } catch (error) {
    return [`contract/exit-codes.json: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (contract.format !== 1) out.push('contract/exit-codes.json: format must be 1');
  if (!Array.isArray(contract.rows)) return [...out, 'contract/exit-codes.json: rows must be a list'];
  if (canonical(contract) !== contractText) out.push('contract/exit-codes.json: not in canonical order');

  const seen = new Set<string>();
  for (const row of contract.rows) {
    if (!row.id || !ID.test(row.id)) out.push(`contract/exit-codes.json: ${row.command} ${row.code} needs an id`);
    if (row.id && !row.id.startsWith(`${row.command}.`)) {
      out.push(`contract/exit-codes.json: ${row.id} does not start with ${row.command}.`);
    }
    if (seen.has(row.id)) out.push(`contract/exit-codes.json: ${row.id} is listed twice`);
    seen.add(row.id);
    if (!Number.isInteger(row.code) || row.code < 0) out.push(`contract/exit-codes.json: ${row.id} has a bad code`);
    if (!row.meaning || !row.trigger) out.push(`contract/exit-codes.json: ${row.id} needs a meaning and a trigger`);
  }
  if (render(contract.rows) !== page) out.push('docs/reference/exit-codes.md: differs from the contract');

  const known = new Set<string>(['team', 'conformance-adapter']);
  for (const entry of commandTable(textOf('src/cli.ts', input.files)).entries) {
    if (entry.key) known.add(entry.key);
  }
  for (const row of contract.rows) {
    if (!known.has(row.command)) out.push(`contract/exit-codes.json: ${row.command} is not a command`);
  }

  const analysis = analyze(input.files);
  for (const line of analysis.unreadable) out.push(line);
  const sites = analysis.sites;
  const claimed = new Map<string, { file: string; line: number }>();
  for (const site of sites) {
    const where = `${site.file}:${site.line}`;
    if (site.ids.length === 0) out.push(`${where}: exit site has no row`);
    for (const id of site.ids) {
      const prior = claimed.get(id);
      if (prior) out.push(`${where}: ${id} is also marked at ${prior.file}:${prior.line}`);
      else claimed.set(id, { file: site.file, line: site.line });
      const row = contract.rows.find((item) => item.id === id);
      if (!row) {
        out.push(`${where}: ${id} has no contract row`);
        continue;
      }
      if (row.command !== site.command) out.push(`${where}: ${id} is marked on ${site.command}, the row says ${row.command}`);
      if (!site.codes.includes(row.code)) {
        out.push(`${where}: ${id} says code ${row.code}, the site returns ${site.codes.join(' or ')}`);
      }
    }
    for (const code of site.codes) {
      const covers = site.ids.some((id) => contract.rows.some((row) => row.id === id && row.code === code));
      if (!covers) out.push(`${where}: returns ${code}, which no row of this site lists`);
    }
  }

  const listed = commandFiles(input.files);
  const texts = new Map(listed.map((item) => [item.file, textOf(item.file, input.files)]));
  for (const item of listed) {
    for (const marker of allMarkers(texts.get(item.file) ?? '')) {
      if (!claimed.has(marker.id)) out.push(`${item.file}:${marker.line}: ${marker.id} is not on an exit site`);
    }
  }
  for (const row of contract.rows) {
    if (row.id && !claimed.has(row.id)) out.push(`contract/exit-codes.json: ${row.id} has no exit site`);
  }
  return out;
}

function main(): void {
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check');
  const shared = process.argv.includes('--shared');
  if (!write && !check && !shared) {
    process.stderr.write('Usage: bun scripts/exit-codes.ts --check|--write|--shared\n');
    process.exitCode = 2;
    return;
  }
  const contract = loadContract();
  if (write) writeFileSync(pagePath, render(contract.rows));
  if (shared) process.stdout.write(sharedReport(contract.rows));
  if (check) {
    const found = problems();
    if (found.length) {
      process.stderr.write(`${found.join('\n')}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write('exit-codes: ok\n');
  }
}

if (import.meta.main) main();

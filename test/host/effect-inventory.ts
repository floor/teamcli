// The hosted send path's effect inventory (review round 1, finding 1 and decision B): the static
// import closure of the warm send host's entry, and every place in it that can change something
// outside the process. Used by test/host/effect-inventory.test.ts; `bun test/host/effect-inventory.ts`
// prints the live inventory.
//
// What it collects, per module of the closure (static imports, re-exports, literal dynamic imports
// and literal `require`s, followed through relative specifiers):
//   - raw imports of a file-changing `node:fs` / `node:fs/promises` name (they must come from the
//     guarded modules instead), and namespace/default imports of those modules and of
//     `node:child_process`;
//   - call sites of the process, socket and network starters (`node:child_process`, `node:net`,
//     `node:http(s)`, `fetch`, `process.kill`, `process.chdir`, `Bun.*`);
//   - non-literal dynamic imports and requires;
//   - every package and builtin the closure imports.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { GUARDED_FS_NAMES } from '../../src/host/guarded-fs.ts';
import { GUARDED_FS_PROMISES_NAMES } from '../../src/host/guarded-fs-promises.ts';

export const ROOT = resolve(import.meta.dir, '..', '..');
export const ENTRY = 'src/host/main.ts';

const FS_GUARDED = new Set<string>(GUARDED_FS_NAMES);
const FSP_GUARDED = new Set<string>(GUARDED_FS_PROMISES_NAMES);
const STARTERS: Record<string, Set<string>> = {
  'node:child_process': new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']),
  'node:net': new Set(['connect', 'createConnection', 'createServer']),
  'node:http': new Set(['request', 'get', 'createServer']),
  'node:https': new Set(['request', 'get']),
  'node:tls': new Set(['connect']),
};

/** Generic runners: a call to one of these is listed like a raw starter, with its first argument,
 *  because the runner itself runs whatever it is given. */
const RUNNERS: Record<string, Set<string>> = {
  'src/herdr.ts': new Set(['run', 'runAsync', 'runMeasured', 'runAsyncMeasured', 'capture', 'captureMeasured', 'captureExec', 'paneExec', 'resultOf']),
  'src/child.ts': new Set(['execText']),
};
/** herdr subcommands that only read: a herdr runner call whose literal arguments start with one
 *  of these is a read by construction. */
export const HERDR_READS = ['agent list', 'pane process-info', 'pane get', 'workspace list', 'pane list', 'pane read', 'session list'];

export type Site = { key: string; what: string; file: string; line: number; guarded: boolean };
export type Inventory = {
  files: string[];
  rawFsImports: string[];
  namespaceImports: string[];
  sites: Site[];
  dynamic: string[];
  /** Closure modules that bind C functions through `bun:ffi` (statically or by require). */
  ffi: string[];
  packages: Map<string, string[]>;
  builtins: Map<string, string[]>;
};

function resolveLocal(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const c of [base.replace(/\.js$/, '.ts'), base, `${base}.ts`, `${base}.js`, join(base, 'index.ts'), join(base, 'index.js')]) {
    if (/\.(ts|js|mjs|cjs)$/.test(c) && existsSync(c)) return c;
  }
  throw new Error(`unresolved import ${spec} from ${relative(ROOT, from)}`);
}

/** The name a site is listed under: the nearest named function, method or variable around it;
 *  and the body searched for an earlier guard: the innermost function around the site. */
function ownerName(node: ts.Node): { name: string; body: ts.Node | null } {
  let body: ts.Node | null = null;
  let p: ts.Node | undefined = node.parent;
  while (p !== undefined) {
    if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)) {
      const name = p.name?.getText() ?? '(anonymous)';
      const cls = ts.isClassLike(p.parent) && p.parent.name ? `${p.parent.name.getText()}.` : '';
      return { name: `${cls}${name}`, body: p };
    }
    if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
      body ??= p;
      const q: ts.Node = p.parent;
      if ((ts.isVariableDeclaration(q) || ts.isPropertyAssignment(q) || ts.isPropertyDeclaration(q)) && q.initializer === p) {
        return { name: q.name.getText(), body: q };
      }
    }
    p = p.parent;
  }
  return { name: '(module)', body };
}

/** Whether `hostedCommit(` is called in the owner's body before this site (source order). */
function guardedBefore(body: ts.Node | null, site: ts.Node): boolean {
  if (body === null) return false;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || n.getStart() >= site.getStart()) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'hostedCommit') {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

export function inventory(entry: string = ENTRY): Inventory {
  const seen = new Set<string>();
  // The profile modules a profile names are loaded by path at run time (src/profiles/module-loader.ts),
  // so the inventory walks them as entries of their own.
  const profiles = join(ROOT, 'src', 'profiles');
  const named = new Set<string>();
  for (const f of readdirSync(profiles)) {
    if (!f.endsWith('.yaml')) continue;
    for (const m of readFileSync(join(profiles, f), 'utf8').matchAll(/^\s*[a-z_]*module:\s*['"]?([^'"\s]+)/gm)) named.add(resolve(profiles, m[1]!));
  }
  const stack = [resolve(ROOT, entry), ...named];
  const out: Inventory = {
    files: [], rawFsImports: [], namespaceImports: [], sites: [], dynamic: [], ffi: [],
    packages: new Map(), builtins: new Map(),
  };
  const note = (m: Map<string, string[]>, k: string, f: string) => {
    const list = m.get(k) ?? [];
    if (!list.includes(f)) list.push(f);
    m.set(k, list);
  };
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const rel = relative(ROOT, file);
    const source = readFileSync(file, 'utf8');
    if (source.includes("'bun:ffi'") || source.includes('"bun:ffi"') || source.includes("'node:ffi'")) out.ffi.push(rel);
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    // local name -> [module, imported name]
    const bound = new Map<string, [string, string]>();
    // local name -> what, for a variable whose initializer names a starter (`const f = x.fetch ?? fetch`)
    const aliases = new Map<ts.Node, Map<string, string>>();
    const scopeOf = (x: ts.Node): ts.Node => {
      let s: ts.Node | undefined = x.parent;
      while (s !== undefined && !ts.isFunctionLike(s) && !ts.isSourceFile(s)) s = s.parent;
      return s ?? sf;
    };
    const aliasOf = (id: ts.Identifier): string | null => {
      let s: ts.Node | undefined = id;
      while (s !== undefined) {
        if (ts.isFunctionLike(s) || ts.isSourceFile(s)) {
          const hit = aliases.get(s)?.get(id.text);
          if (hit !== undefined) return hit;
        }
        s = s.parent;
      }
      return null;
    };
    /** An identifier that names a key, a declaration or a type, not a value reference. */
    const notAValue = (x: ts.Identifier): boolean => {
      const p = x.parent;
      if ((ts.isPropertySignature(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)
        || ts.isMethodSignature(p) || ts.isFunctionDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)
        || ts.isVariableDeclaration(p) || ts.isPropertyAccessExpression(p)) && (p as { name?: ts.Node }).name === x) return true;
      let q: ts.Node | undefined = p;
      while (q !== undefined && !ts.isStatement(q) && !ts.isFunctionLike(q)) {
        if (ts.isTypeNode(q)) return true;
        q = q.parent;
      }
      return false;
    };
    /** What a reference to this identifier starts: an imported starter, the relay package, the
     *  global fetch, or a local alias of one. */
    const starterOf = (id: ts.Identifier): string | null => {
      const b = bound.get(id.text);
      if (b && STARTERS[b[0]]?.has(b[1])) return `${b[0]}.${b[1]}`;
      if (b && /packages\/relay\//.test(b[0]) && b[1] !== 'capabilities' && /^[a-z]/.test(b[1])) return `relay.${b[1]}`;
      if (id.text === 'fetch' && !bound.has('fetch')) return 'fetch';
      return aliasOf(id);
    };
    const startersIn = (node: ts.Node): string[] => {
      const found: string[] = [];
      const walk = (x: ts.Node): void => {
        if (ts.isFunctionLike(x)) return;
        // A call's result is not the starter: `const child = spawn(…)` names a child, not spawn.
        if (ts.isCallExpression(x) || ts.isNewExpression(x) || ts.isAwaitExpression(x) || ts.isTypeOfExpression(x)) return;
        if (ts.isIdentifier(x) && !notAValue(x)) {
          const s = starterOf(x);
          if (s !== null) found.push(s);
        }
        ts.forEachChild(x, walk);
      };
      walk(node);
      return found;
    };
    const site = (n: ts.Node, what: string): void => {
      const o = ownerName(n);
      const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
      out.sites.push({ key: `${rel}#${o.name}`, what, file: rel, line, guarded: guardedBefore(o.body, n) });
    };
    const follow = (spec: string): void => {
      if (spec.startsWith('.')) {
        const x = resolveLocal(file, spec);
        if (x !== null) stack.push(x);
      } else if (spec.startsWith('node:') || spec.startsWith('bun:')) {
        note(out.builtins, spec, rel);
      } else {
        note(out.packages, spec, rel);
      }
    };
    const visit = (n: ts.Node): void => {
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        const spec = n.moduleSpecifier.text;
        const typeOnly = ts.isImportDeclaration(n) ? n.importClause?.isTypeOnly === true : n.isTypeOnly;
        if (!typeOnly) follow(spec);
        if (ts.isImportDeclaration(n) && n.importClause && !typeOnly) {
          const c = n.importClause;
          const fsLike = spec === 'node:fs' || spec === 'node:fs/promises' || spec === 'node:child_process' || spec === 'fs' || spec === 'child_process';
          if (c.name && fsLike) out.namespaceImports.push(`${rel}: default import of ${spec}`);
          const nb = c.namedBindings;
          if (nb && ts.isNamespaceImport(nb) && fsLike) out.namespaceImports.push(`${rel}: namespace import of ${spec}`);
          if (nb && ts.isNamedImports(nb)) {
            for (const el of nb.elements) {
              if (el.isTypeOnly) continue;
              const imported = (el.propertyName ?? el.name).text;
              const from = spec.startsWith('.') ? relative(ROOT, resolveLocal(file, spec) ?? spec) : spec;
              bound.set(el.name.text, [from, imported]);
              if ((spec === 'node:fs' || spec === 'fs') && FS_GUARDED.has(imported)) out.rawFsImports.push(`${rel}: ${imported} from ${spec}`);
              if ((spec === 'node:fs/promises' || spec === 'fs/promises') && FSP_GUARDED.has(imported)) out.rawFsImports.push(`${rel}: ${imported} from ${spec}`);
            }
          }
        }
        if (ts.isExportDeclaration(n) && (spec === 'node:fs' || spec === 'node:fs/promises' || spec === 'node:child_process')) {
          out.namespaceImports.push(`${rel}: re-export from ${spec}`);
        }
      }
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && !ts.isFunctionLike(n.initializer)) {
        const named = startersIn(n.initializer);
        if (named.length > 0) {
          const scope = scopeOf(n);
          const map = aliases.get(scope) ?? new Map<string, string>();
          map.set(n.name.text, named[0]!);
          aliases.set(scope, map);
        }
      }
      if (ts.isIdentifier(n) && !ts.isImportSpecifier(n.parent) && !ts.isImportClause(n.parent) && !ts.isNamespaceImport(n.parent)
        && !ts.isShorthandPropertyAssignment(n.parent) === true && !notAValue(n)) {
        const s = starterOf(n);
        if (s !== null) {
          // A reference that is not the callee of a call: passed or stored as a value.
          let p: ts.Node = n;
          while (ts.isParenthesizedExpression(p.parent) || ts.isBinaryExpression(p.parent) || ts.isConditionalExpression(p.parent)) p = p.parent;
          const callee = ts.isCallExpression(p.parent) && p.parent.expression === p;
          const aliasInit = ts.isVariableDeclaration(p.parent) && p.parent.initializer === p;
          if (!callee && !aliasInit) site(n, `value ${s}`);
        }
      }
      if (ts.isCallExpression(n)) {
        const e = n.expression;
        const arg = n.arguments[0];
        if (e.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(e) && e.text === 'require')) {
          if (arg && ts.isStringLiteral(arg)) {
            follow(arg.text);
            if (ts.isIdentifier(e) && ['node:fs', 'node:fs/promises', 'node:child_process', 'fs', 'child_process'].includes(arg.text)) {
              out.namespaceImports.push(`${rel}: require of ${arg.text}`);
            }
          } else {
            out.dynamic.push(`${rel}#${ownerName(n).name}`);
          }
        }
        let what: string | null = null;
        if (ts.isIdentifier(e)) {
          const b = bound.get(e.text);
          if (b && STARTERS[b[0]]?.has(b[1])) what = `${b[0]}.${b[1]}`;
          if (b && /packages\/relay\//.test(b[0])) what = `relay.${b[1]}`;
          if (e.text === 'fetch' && !bound.has('fetch')) what = 'fetch';
          if (what === null) what = aliasOf(e);
          const runnerHere = RUNNERS[rel]?.has(e.text) === true && !bound.has(e.text);
          const runnerThere = b !== undefined && RUNNERS[b[0]]?.has(b[1]) === true;
          if (runnerHere || runnerThere) {
            const first = n.arguments.find((a) => ts.isArrayLiteralExpression(a));
            const words = first && ts.isArrayLiteralExpression(first)
              ? first.elements.slice(0, 2).map((x) => (ts.isStringLiteral(x) ? x.text : '?')).join(' ')
              : '';
            const herdrTool = n.arguments[0] && ts.isStringLiteral(n.arguments[0]) ? n.arguments[0].text : '';
            const isRead = HERDR_READS.includes(words) && (rel === 'src/herdr.ts' || herdrTool === 'herdr');
            // A runner calling another runner of its own file is listed through its own callers.
            const insideRunner = RUNNERS[rel]?.has(ownerName(n).name) === true;
            if (!isRead && !insideRunner) {
              what = `runner.${e.text}(${words || (first ? '…' : n.arguments[0]?.getText().slice(0, 30) ?? '')})`;
            }
          }
        } else if (ts.isParenthesizedExpression(e) || ts.isBinaryExpression(e) || ts.isConditionalExpression(e)) {
          const named = startersIn(e);
          if (named.length > 0) what = `${named[0]} (indirect)`;
        } else if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
          const obj = e.expression.text;
          const prop = e.name.text;
          const probe = prop === 'kill' && n.arguments[1] !== undefined && ts.isNumericLiteral(n.arguments[1]) && n.arguments[1].text === '0';
          if (obj === 'process' && ((prop === 'kill' && !probe) || prop === 'chdir')) what = `process.${prop}`;
          if (obj === 'Bun' && ['write', 'spawn', 'spawnSync', '$', 'connect', 'listen', 'serve'].includes(prop)) what = `Bun.${prop}`;
        }
        if (what !== null) {
          const o = ownerName(n);
          const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
          out.sites.push({ key: `${rel}#${o.name}`, what, file: rel, line, guarded: guardedBefore(o.body, n) });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  out.files = [...seen].map((f) => relative(ROOT, f)).sort();
  return out;
}

if (import.meta.main) {
  const inv = inventory();
  console.log(`files ${inv.files.length}`);
  console.log('raw fs imports:', inv.rawFsImports);
  console.log('namespace imports:', inv.namespaceImports);
  console.log('dynamic:', inv.dynamic);
  console.log('packages:', [...inv.packages.keys()]);
  console.log('builtins:', [...inv.builtins.keys()].sort().join(' '));
  const byKey = new Map<string, Site[]>();
  for (const s of inv.sites) byKey.set(`${s.key} ${s.what}`, [...(byKey.get(`${s.key} ${s.what}`) ?? []), s]);
  for (const [k, list] of [...byKey].sort()) console.log(`${list[0]!.guarded ? 'G' : '-'} ${k} x${list.length} (:${list.map((s) => s.line).join(',')})`);
}

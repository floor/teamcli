// Reads a TOML document for the records TeamCLI writes: the syntax TOML 1.0 gives each
// construct is checked, so a file that does not parse is refused instead of rewritten. The
// reader is written in the shipped build's own dialect, with no runtime global: the build
// compiles against Node's types and its output runs under `node dist/cli.js`, where a Bun-only
// reader is not available.
//
// A value is read as TOML gives it: strings are decoded (escapes, both multi-line forms, the
// first newline trimmed), integers and floats become numbers, `true` and `false` become
// booleans, arrays and tables become arrays and objects. A date or time is kept as its token
// text, and a table is a plain keyed object; nothing in the sandbox file reads either.
export type TomlTable = Record<string, unknown>;

const DATE = '\\d{4}-\\d{2}-\\d{2}';
const TIME = '\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?';
const OFFSET = '(?:[Zz]|[+-]\\d{2}:\\d{2})';
const DATE_TIME = new RegExp(`^(${DATE})(?:[Tt](${TIME}))?(${OFFSET})?$`);
const LOCAL_DATE = new RegExp(`^${DATE}$`);
const LOCAL_TIME = new RegExp(`^${TIME}$`);
const INTEGER = /^[+-]?(?:0|[1-9](?:_?\d)*)$/;
const HEX_INTEGER = /^0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$/;
const OCT_INTEGER = /^0o[0-7](?:_?[0-7])*$/;
const BIN_INTEGER = /^0b[01](?:_?[01])*$/;
const FLOAT = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?$/;
const INFINITY = /^[+-]?inf$/;
const NOT_A_NUMBER = /^[+-]?nan$/;
const BARE_KEY = /[A-Za-z0-9_-]/;
const VALUE_END = /[ \t\r\n#,\]}]/;

/** A year, month and day that exist: TOML dates are real calendar dates, leap years included. */
function calendarDate(text: string): boolean {
  const [year, month, day] = text.split('-').map(Number) as [number, number, number];
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

/** Hours, minutes and seconds in their ranges (a second of 60 is a leap second). */
function clockTime(text: string): boolean {
  const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(text);
  if (match === null) return false;
  return Number(match[1]) < 24 && Number(match[2]) < 60 && Number(match[3]) <= 60;
}

/** An offset: `Z` for UTC, else its hours and minutes in their ranges. */
function offsetTime(text: string): boolean {
  if (text === 'Z' || text === 'z') return true;
  const match = /^[+-](\d{2}):(\d{2})$/.exec(text);
  if (match === null) return false;
  return Number(match[1]) < 24 && Number(match[2]) < 60;
}

/** A document, read once. The reader keeps the tables it has already defined, so a file that
 *  defines a table or a key twice is refused rather than read into one of them. */
class Document {
  private readonly text: string;
  private at = 0;
  private readonly root: TomlTable = Object.create(null) as TomlTable;
  private current: TomlTable = this.root;
  /** Inline tables: self-contained, so neither a header nor a dotted key may extend one. */
  private readonly sealed = new WeakSet<object>();
  /** Tables a `[header]` opened; opening one of them again is a redefinition. */
  private readonly defined = new WeakSet<object>();
  /** Tables a dotted key created; a header cannot open one of them either. */
  private readonly dotted = new WeakSet<object>();
  /** Arrays a `[[header]]` appends to; every other array is a plain value. */
  private readonly lists = new WeakSet<object>();

  constructor(text: string) {
    this.text = text;
  }

  read(): TomlTable {
    for (;;) {
      this.skipSpaces();
      const char = this.peek();
      if (char === undefined) return this.root;
      if (char === '\n') {
        this.at++;
        continue;
      }
      if (char === '\r') {
        this.newline();
        continue;
      }
      if (char === '#') {
        this.comment();
        continue;
      }
      if (char === '[') {
        this.header();
        continue;
      }
      this.keyValue(this.current);
      this.endOfLine();
    }
  }

  /** `[table]` or `[[array-of-tables]]`, on a line of its own. */
  private header(): void {
    this.at++;
    const list = this.peek() === '[';
    if (list) this.at++;
    this.skipSpaces();
    const path = this.keyPath();
    this.skipSpaces();
    this.want(']');
    if (list) this.want(']');
    this.current = list ? this.openList(path) : this.openTable(path);
    this.endOfLine();
  }

  private openTable(path: readonly string[]): TomlTable {
    const name = path.join('.');
    const parent = this.below(path.slice(0, -1));
    const last = path[path.length - 1]!;
    const existing = parent[last];
    if (existing !== undefined) {
      this.tableValue(existing, name);
      if (this.defined.has(existing as object) || this.dotted.has(existing as object)) {
        this.fail(`the table ${name} once, not twice`);
      }
      this.defined.add(existing as object);
      return existing as TomlTable;
    }
    const table = Object.create(null) as TomlTable;
    this.defined.add(table);
    parent[last] = table;
    return table;
  }

  private openList(path: readonly string[]): TomlTable {
    const parent = this.below(path.slice(0, -1));
    const last = path[path.length - 1]!;
    const existing = parent[last];
    let list: unknown[];
    if (existing === undefined) {
      list = [];
      this.lists.add(list);
      parent[last] = list;
    } else {
      if (!Array.isArray(existing) || !this.lists.has(existing)) {
        this.fail(`an array of tables at ${path.join('.')}`);
      }
      list = existing;
    }
    const table = Object.create(null) as TomlTable;
    list.push(table);
    return table;
  }

  /** The table a path names, opening intermediate tables as TOML does. A header may walk
   *  through an array of tables to its last element. */
  private below(path: readonly string[]): TomlTable {
    let table = this.root;
    for (const segment of path) {
      const existing = table[segment];
      if (existing === undefined) {
        const created = Object.create(null) as TomlTable;
        table[segment] = created;
        table = created;
        continue;
      }
      if (this.sealed.has(existing as object)) this.fail(`something other than an inline table at ${segment}`);
      if (Array.isArray(existing)) {
        if (!this.lists.has(existing)) this.fail(`something other than an array of tables at ${segment}`);
        const last = existing[existing.length - 1];
        if (typeof last !== 'object' || last === null) this.fail(`a table in ${segment}`);
        table = last as TomlTable;
        continue;
      }
      if (typeof existing !== 'object' || existing === null) this.fail(`something other than a plain value at ${segment}`);
      table = existing as TomlTable;
    }
    return table;
  }

  private keyValue(table: TomlTable): void {
    const path = this.keyPath();
    this.skipSpaces();
    this.want('=');
    this.skipSpaces();
    const value = this.value();
    this.assign(table, path, value);
  }

  /** Puts a value under a key path, opening intermediate tables. A key already defined is an
   *  error; a dotted key cannot extend an inline table or redefine a table a header opened. */
  private assign(table: TomlTable, path: readonly string[], value: unknown): void {
    let target = table;
    for (const segment of path.slice(0, -1)) {
      const existing = target[segment];
      if (existing === undefined) {
        const created = Object.create(null) as TomlTable;
        this.dotted.add(created);
        target[segment] = created;
        target = created;
        continue;
      }
      if (this.sealed.has(existing as object)) this.fail(`something other than an inline table at ${segment}`);
      // A dotted key may extend a table it (or another dotted key) opened; a table a header
      // opened is defined in that form and a dotted key cannot define it again.
      if (this.defined.has(existing as object)) this.fail(`a table, not a dotted key, at ${segment}`);
      if (Array.isArray(existing) || typeof existing !== 'object' || existing === null) {
        this.fail(`something other than a plain value at ${segment}`);
      }
      target = existing as TomlTable;
    }
    const last = path[path.length - 1]!;
    if (Object.prototype.hasOwnProperty.call(target, last)) {
      this.fail(`the key ${path.join('.')} once, not twice`);
    }
    target[last] = value;
  }

  /** A table a header may open: an object, never an inline table, never a plain value. */
  private tableValue(value: unknown, name: string): void {
    if (this.sealed.has(value as object)) this.fail(`something other than an inline table at ${name}`);
    if (Array.isArray(value)) this.fail(`a table at ${name}, not an array`);
    if (typeof value !== 'object' || value === null) this.fail(`a table at ${name}, not a plain value`);
  }

  private value(): unknown {
    const char = this.peek();
    if (char === undefined) this.fail('a value');
    if (char === '"' || char === "'") return this.string();
    if (char === '[') return this.array();
    if (char === '{') return this.inline();
    return this.scalar();
  }

  private string(): string {
    if (this.peek() === '"') {
      return this.text.startsWith('"""', this.at) ? this.multiline('"', true) : this.basic();
    }
    return this.text.startsWith("'''", this.at) ? this.multiline("'", false) : this.literal();
  }

  private basic(): string {
    this.at++;
    let out = '';
    for (;;) {
      const char = this.text[this.at];
      if (char === undefined) this.fail('the end of a basic string');
      this.at++;
      if (char === '"') return out;
      if (char === '\\') {
        out += this.escape(false);
        continue;
      }
      this.singleLine(char);
      out += char;
    }
  }

  private literal(): string {
    this.at++;
    let out = '';
    for (;;) {
      const char = this.text[this.at];
      if (char === undefined) this.fail('the end of a literal string');
      this.at++;
      if (char === "'") return out;
      this.singleLine(char);
      out += char;
    }
  }

  private multiline(quote: string, escapes: boolean): string {
    this.at += 3;
    // The newline right after the opening delimiter is trimmed.
    if (this.peek() === '\r') this.newline();
    else if (this.peek() === '\n') this.at++;
    let out = '';
    for (;;) {
      const char = this.text[this.at];
      if (char === undefined) this.fail('the end of a multi-line string');
      if (char === quote) {
        let run = 0;
        while (this.text[this.at + run] === quote) run++;
        if (run < 3) {
          out += quote.repeat(run);
          this.at += run;
          continue;
        }
        // The last three quotes close the string; one or two before them are content.
        if (run > 5) this.fail('at most two quote characters before the closing delimiter');
        out += quote.repeat(run - 3);
        this.at += run;
        return out;
      }
      this.at++;
      if (char === '\r') {
        if (this.text[this.at] !== '\n') this.fail('a carriage return and a line feed');
        this.at++;
        out += '\n';
        continue;
      }
      if (escapes && char === '\\') {
        out += this.escape(true);
        continue;
      }
      this.control(char);
      out += char;
    }
  }

  /** The text an escape spells. A backslash that ends a line in a multi-line string trims the
   *  line and the whitespace after it. */
  private escape(multiline: boolean): string {
    const char = this.text[this.at];
    if (char === undefined) this.fail('the end of an escape');
    if (multiline && (char === ' ' || char === '\t' || char === '\n' || char === '\r')) {
      const lineEnd = /^[ \t]*\r?\n/.exec(this.text.slice(this.at));
      if (lineEnd === null) this.fail(`the escape \\${char}`);
      this.at += lineEnd[0].length;
      for (;;) {
        const next = this.peek();
        if (next === ' ' || next === '\t' || next === '\n') {
          this.at++;
          continue;
        }
        if (next === '\r') {
          this.newline();
          continue;
        }
        return '';
      }
    }
    this.at++;
    switch (char) {
      case 'b':
        return '\b';
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'f':
        return '\f';
      case 'r':
        return '\r';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case 'u':
        return this.unicode(4);
      case 'U':
        return this.unicode(8);
      default:
        this.fail(`the escape \\${char}`);
    }
  }

  private unicode(size: number): string {
    const digits = this.text.slice(this.at, this.at + size);
    if (digits.length !== size || !/^[0-9A-Fa-f]+$/.test(digits)) this.fail('a Unicode escape of hex digits');
    this.at += size;
    const code = Number.parseInt(digits, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) this.fail('a Unicode scalar value');
    return String.fromCodePoint(code);
  }

  /** A character in a single-line string: no newline, no control character other than tab. */
  private singleLine(char: string): void {
    if (char === '\n' || char === '\r') this.fail('a single-line string');
    this.control(char);
  }

  private control(char: string): void {
    const code = char.codePointAt(0)!;
    // A single-line string refuses a newline before this check; a multi-line string keeps it.
    if ((code < 0x20 && char !== '\t' && char !== '\n') || code === 0x7f) this.fail('a printable string');
  }

  /** An array: values between brackets, commas between them, newlines and comments anywhere. */
  private array(): unknown[] {
    this.at++;
    const items: unknown[] = [];
    for (;;) {
      this.space();
      if (this.peek() === ']') {
        this.at++;
        return items;
      }
      items.push(this.value());
      this.space();
      const char = this.peek();
      if (char === ',') {
        this.at++;
        continue;
      }
      if (char === ']') {
        this.at++;
        return items;
      }
      this.fail(`a comma or ']' after an array value`);
    }
  }

  /** An inline table: key-value pairs between braces, self-contained, on one line. */
  private inline(): TomlTable {
    this.at++;
    const table = Object.create(null) as TomlTable;
    this.sealed.add(table);
    this.skipSpaces();
    if (this.peek() === '}') {
      this.at++;
      return table;
    }
    for (;;) {
      this.skipSpaces();
      const path = this.keyPath();
      this.skipSpaces();
      this.want('=');
      this.skipSpaces();
      const value = this.value();
      this.assign(table, path, value);
      this.skipSpaces();
      const char = this.peek();
      if (char === ',') {
        this.at++;
        continue;
      }
      if (char === '}') {
        this.at++;
        return table;
      }
      this.fail(`a comma or '}' after an inline table key`);
    }
  }

  /** A value written as one bare token: a boolean, a number, a date or a time. */
  private scalar(): unknown {
    const start = this.at;
    this.token();
    const first = this.text.slice(start, this.at);
    let written = first;
    // A date and a time may be separated by a space instead of `T`.
    if (LOCAL_DATE.test(first) && this.peek() === ' ') {
      const after = this.text.slice(this.at + 1, this.at + 9);
      if (/^\d{2}:\d{2}:\d{2}/.test(after)) {
        this.at++;
        const from = this.at;
        this.token();
        written = `${first}T${this.text.slice(from, this.at)}`;
      }
    }
    if (written === 'true') return true;
    if (written === 'false') return false;
    const dateTime = DATE_TIME.exec(written);
    if (dateTime !== null) {
      const [, date, time, offset] = dateTime;
      // An offset belongs to a date and a time; a date alone is local.
      if (!calendarDate(date!) || (time === undefined && offset !== undefined)) this.fail(`a date and time, not ${written}`);
      if (time !== undefined && !clockTime(time)) this.fail(`a time, not ${time}`);
      if (offset !== undefined && !offsetTime(offset)) this.fail(`an offset, not ${offset}`);
      return written;
    }
    if (LOCAL_TIME.test(written)) {
      if (!clockTime(written)) this.fail(`a time, not ${written}`);
      return written;
    }
    if (INTEGER.test(written)) return Number.parseInt(written.replaceAll('_', ''), 10);
    if (HEX_INTEGER.test(written)) return Number.parseInt(written.slice(2).replaceAll('_', ''), 16);
    if (OCT_INTEGER.test(written)) return Number.parseInt(written.slice(2).replaceAll('_', ''), 8);
    if (BIN_INTEGER.test(written)) return Number.parseInt(written.slice(2).replaceAll('_', ''), 2);
    if (FLOAT.test(written) && /[.eE]/.test(written)) return Number(written.replaceAll('_', ''));
    if (INFINITY.test(written)) return written.startsWith('-') ? -Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY;
    if (NOT_A_NUMBER.test(written)) return Number.NaN;
    this.fail(`a value`);
  }

  private token(): void {
    const start = this.at;
    while (this.at < this.text.length && !VALUE_END.test(this.text[this.at]!)) this.at++;
    if (this.at === start) this.fail('a value');
  }

  private keyPath(): string[] {
    const path = [this.key()];
    for (;;) {
      const mark = this.at;
      this.skipSpaces();
      if (this.peek() !== '.') {
        this.at = mark;
        return path;
      }
      this.at++;
      this.skipSpaces();
      path.push(this.key());
    }
  }

  private key(): string {
    const char = this.peek();
    if (char === '"') return this.basic();
    if (char === "'") return this.literal();
    const start = this.at;
    while (this.at < this.text.length && BARE_KEY.test(this.text[this.at]!)) this.at++;
    if (this.at === start) this.fail('a key');
    return this.text.slice(start, this.at);
  }

  /** What follows a key-value or a header: spaces, an optional comment, then a newline or the
   *  end of the document. */
  private endOfLine(): void {
    this.skipSpaces();
    if (this.peek() === '#') this.comment();
    const char = this.peek();
    if (char === undefined) return;
    if (char === '\n') {
      this.at++;
      return;
    }
    if (char === '\r') {
      this.newline();
      return;
    }
    this.fail(`the end of the line`);
  }

  private space(): void {
    for (;;) {
      const char = this.peek();
      if (char === ' ' || char === '\t' || char === '\n') {
        this.at++;
        continue;
      }
      if (char === '\r') {
        this.newline();
        continue;
      }
      if (char === '#') {
        this.comment();
        continue;
      }
      return;
    }
  }

  private skipSpaces(): void {
    while (this.peek() === ' ' || this.peek() === '\t') this.at++;
  }

  private comment(): void {
    while (this.at < this.text.length && this.text[this.at] !== '\n' && this.text[this.at] !== '\r') this.at++;
  }

  private newline(): void {
    if (this.text[this.at] !== '\r') this.fail('a line end');
    this.at++;
    if (this.text[this.at] !== '\n') this.fail('a line feed after a carriage return');
    this.at++;
  }

  private want(char: string): void {
    if (this.peek() !== char) this.fail(`'${char}'`);
    this.at++;
  }

  private peek(): string | undefined {
    return this.text[this.at];
  }

  private fail(what: string): never {
    const line = this.text.slice(0, this.at).split('\n').length;
    throw new Error(`line ${line}: expected ${what}`);
  }
}

/** The document as tables of their values. A document that does not parse throws; the caller
 *  leaves the file as it is rather than writing through a guess. */
export function parseToml(text: string): TomlTable {
  return new Document(text).read();
}

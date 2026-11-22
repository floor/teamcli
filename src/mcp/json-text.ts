// Edit only an owned JSON value. All unrelated source bytes, including whitespace, survive.
type Span = { start: number; end: number; properties?: Map<string, { keyStart: number; value: Span }>; elements?: Span[] };
function tree(text: string): Span {
  JSON.parse(text); // The scanner operates only on strict, valid JSON.
  let at = 0;
  const space = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  function string(): void { at++; while (at < text.length) { const c = text[at++]; if (c === '\\') at++; else if (c === '"') return; } throw new Error('invalid JSON string'); }
  function value(): Span {
    space(); const start = at; const node: Span = { start, end: start };
    if (text[at] === '{') {
      at++; space(); node.properties = new Map();
      while (text[at] !== '}') {
        const keyStart = at; string(); const key = JSON.parse(text.slice(keyStart, at)) as string;
        if (node.properties.has(key)) throw new Error('duplicate JSON key');
        space(); at++; const child = value(); node.properties.set(key, { keyStart, value: child }); space();
        if (text[at] !== ',') break; at++; space();
      }
      at++;
    } else if (text[at] === '[') {
      at++; space(); node.elements = [];
      while (text[at] !== ']') { node.elements.push(value()); space(); if (text[at] !== ',') break; at++; space(); }
      at++;
    } else if (text[at] === '"') string();
    else while (at < text.length && !/[\s,}\]]/.test(text[at]!)) at++;
    node.end = at; return node;
  }
  return value();
}
function atPath(root: Span, path: readonly string[]): Span | undefined {
  let node: Span | undefined = root;
  for (const key of path) node = node?.properties?.get(key)?.value;
  return node;
}
export function jsonValueText(text: string, path: readonly string[]): string | undefined {
  const node = atPath(tree(text), path); return node === undefined ? undefined : text.slice(node.start, node.end);
}
export function setJsonValue(text: string, path: readonly string[], raw: string | undefined): string {
  if (path.length === 0) throw new Error('a JSON field is required');
  const root = tree(text); const parent = atPath(root, path.slice(0, -1)); const key = path.at(-1)!;
  if (parent === undefined) {
    if (raw === undefined) return text;
    return setJsonValue(text, path.slice(0, -1), `{${JSON.stringify(key)}:${raw}}`);
  }
  if (parent.properties === undefined) throw new Error('the JSON field parent must be an object');
  const found = parent.properties.get(key);
  if (found !== undefined && raw !== undefined) return text.slice(0, found.value.start) + raw + text.slice(found.value.end);
  if (found === undefined) {
    if (raw === undefined) return text;
    const end = parent.end - 1;
    return text.slice(0, end) + (parent.properties.size === 0 ? '' : ',') + JSON.stringify(key) + ':' + raw + text.slice(end);
  }
  const fields = [...parent.properties.values()]; const index = fields.indexOf(found);
  let start = found.keyStart; let end = found.value.end;
  if (index + 1 < fields.length) end = fields[index + 1]!.keyStart;
  else if (index > 0) start = fields[index - 1]!.value.end;
  return text.slice(0, start) + text.slice(end);
}
export function addJsonName(text: string, key: string, name: string): string {
  const node = atPath(tree(text), [key]);
  if (node === undefined) return setJsonValue(text, [key], JSON.stringify([name]));
  if (node.elements === undefined) throw new Error('the approval list must be an array');
  if (node.elements.some((v) => JSON.parse(text.slice(v.start, v.end)) === name)) return text;
  return text.slice(0, node.end - 1) + (node.elements.length === 0 ? '' : ',') + JSON.stringify(name) + text.slice(node.end - 1);
}
export function removeJsonName(text: string, key: string, name: string, originallyAbsent: boolean): string {
  const node = atPath(tree(text), [key]);
  if (node === undefined) return text;
  if (node.elements === undefined) throw new Error('the approval list must be an array');
  const hits = node.elements.filter((v) => JSON.parse(text.slice(v.start, v.end)) === name);
  if (hits.length === 0) return text;
  if (hits.length !== 1) throw new Error('the setup approval name is no longer unique');
  const found = hits[0]!; const index = node.elements.indexOf(found);
  if (node.elements.length === 1 && originallyAbsent) return setJsonValue(text, [key], undefined);
  let start = found.start; let end = found.end;
  if (index + 1 < node.elements.length) end = node.elements[index + 1]!.start;
  else if (index > 0) start = node.elements[index - 1]!.end;
  return text.slice(0, start) + text.slice(end);
}

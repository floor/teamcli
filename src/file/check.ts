import type { YamlEntry, YamlNode } from '../yaml.ts';
import type { Deprecation, Problem } from './types.ts';

export type Fields = Map<string, YamlEntry>;

export class Check {
  problems: Problem[] = [];
  warnings: Problem[] = [];
  /** Fields the file still reads and no longer acts on; `team check` prints them, nothing else. */
  deprecations: Deprecation[] = [];

  fail(line: number, message: string): void {
    this.problems.push({ line, message });
  }

  // The fields of a map, with every field outside `known` reported.
  fields(node: YamlNode | undefined, where: string, known: string[]): Fields {
    const fields: Fields = new Map();
    if (!node) return fields;
    if (node.kind !== 'map') {
      if (!(node.kind === 'scalar' && node.value === null)) this.fail(node.line, `${where} must be a map of fields`);
      return fields;
    }
    for (const entry of node.entries) {
      if (known.includes(entry.key)) fields.set(entry.key, entry);
      else this.fail(entry.line, `unknown field "${entry.key}" in ${where}`);
    }
    return fields;
  }

  text(entry: YamlEntry | undefined, name: string): string | undefined {
    if (!entry) return undefined;
    const node = entry.value;
    if (node.kind === 'scalar' && typeof node.value === 'string' && node.value !== '') return node.value;
    this.fail(node.line, `${name} must be text${node.kind === 'scalar' && node.value !== null && node.value !== '' ? ': quote it' : ''}`);
    return undefined;
  }

  required(entry: YamlEntry | undefined, name: string, line: number): string | undefined {
    if (!entry) this.fail(line, `${name} is required`);
    return this.text(entry, name);
  }

  oneOf<T extends string>(entry: YamlEntry | undefined, name: string, values: T[]): T | undefined {
    if (!entry) return undefined;
    const node = entry.value;
    if (node.kind === 'scalar' && typeof node.value === 'string' && (values as string[]).includes(node.value)) {
      return node.value as T;
    }
    this.fail(node.line, `${name} must be one of: ${values.join(', ')}`);
    return undefined;
  }

  flag(entry: YamlEntry | undefined, name: string): boolean {
    if (!entry) return false;
    const node = entry.value;
    if (node.kind === 'scalar' && typeof node.value === 'boolean' && !node.quoted) return node.value;
    this.fail(node.line, `${name} must be true or false`);
    return false;
  }

  whole(entry: YamlEntry | undefined, name: string, least: number): number | undefined {
    if (!entry) return undefined;
    const node = entry.value;
    if (node.kind === 'scalar' && typeof node.value === 'number' && Number.isInteger(node.value) && node.value >= least) {
      return node.value;
    }
    this.fail(node.line, `${name} must be a whole number, ${least} or more`);
    return undefined;
  }

  number(entry: YamlEntry | undefined, name: string): number | undefined {
    if (!entry) return undefined;
    const node = entry.value;
    if (node.kind === 'scalar' && typeof node.value === 'number' && Number.isFinite(node.value) && node.value > 0) {
      return node.value;
    }
    this.fail(node.line, `${name} must be a number above 0`);
    return undefined;
  }

  // A value with its unit, such as 120s, 25% or 10GB.
  measure(entry: YamlEntry | undefined, name: string, units: Record<string, number>, example: string): number | undefined {
    if (!entry) return undefined;
    const node = entry.value;
    const raw = node.kind === 'scalar' ? node.raw : '';
    const match = /^([0-9]+(?:\.[0-9]+)?)([A-Za-z%]+)$/.exec(raw);
    const unit = match?.[2];
    if (match && unit !== undefined && unit in units && node.kind === 'scalar' && !node.quoted) {
      return Number(match[1]) * (units[unit] as number);
    }
    this.fail(node.line, `${name} needs a value with its unit (${Object.keys(units).join(', ')}), such as ${example}`);
    return undefined;
  }

  list(entry: YamlEntry | undefined, name: string): { value: string; line: number }[] {
    if (!entry) return [];
    const node = entry.value;
    if (node.kind !== 'seq') {
      if (!(node.kind === 'scalar' && node.value === null)) this.fail(node.line, `${name} must be a list`);
      return [];
    }
    const out: { value: string; line: number }[] = [];
    for (const item of node.items) {
      if (item.kind === 'scalar' && typeof item.value === 'string' && item.value !== '') {
        out.push({ value: item.value, line: item.line });
      } else {
        this.fail(item.line, `each item of ${name} must be text${item.kind === 'map' ? ': quote a line that contains ": "' : ''}`);
      }
    }
    return out;
  }
}

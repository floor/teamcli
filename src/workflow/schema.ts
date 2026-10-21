// parseWorkflow: the definition schema v1 — closed key sets, identifier rule, wait combinations,
// the two vocabularies and the annotation assertions. Whole-graph rules (references, reachability,
// ambiguity, hooks) belong to B2's checker; this file only says what a single file must look like.

import { isEventKind } from '../bus/kinds.ts';
import { parseYaml, YamlError, type YamlEntry, type YamlNode } from '../yaml.ts';
import { definitionId } from './canonical.ts';
import { isSignalName, type SignalName } from './signals.ts';
import type {
  Capability,
  Finding,
  ParseWorkflowResult,
  Workflow,
  WorkflowEffect,
  WorkflowLibraryEntry,
  WorkflowState,
  WorkflowTransition,
  WorkflowWait,
} from './types.ts';

type MapNode = Extract<YamlNode, { kind: 'map' }>;
type SeqNode = Extract<YamlNode, { kind: 'seq' }>;

const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/;

/** The closed eight capability words (draft 6 §2.2). */
const CAPABILITIES: ReadonlySet<string> = new Set<string>([
  'write',
  'read',
  'review',
  'gate',
  'merge',
  'deploy',
  'act-as',
  'use-broker',
]);

const TOP_KEYS: ReadonlySet<string> = new Set([
  'workflow',
  'version',
  'initial',
  'on',
  'inputs',
  'states',
  'transitions',
  'effects',
  'library',
  'error',
]);
const STATE_KEYS: ReadonlySet<string> = new Set(['on-enter', 'on-leave', 'uses', 'wait']);
const WAIT_KEYS: ReadonlySet<string> = new Set(['for', 'role', 'at']);
const TRANSITION_KEYS: ReadonlySet<string> = new Set(['from', 'to', 'on', 'guard', 'role']);
const EFFECT_KEYS: ReadonlySet<string> = new Set(['run', 'role', 'capability', 'act-as', 'reach']);
const LIBRARY_KEYS: ReadonlySet<string> = new Set(['mechanics', 'settings']);

function refuse(findings: Finding[], code: string, line: number, message: string): undefined {
  findings.push({ level: 'refusal', code, line, message });
  return undefined;
}

function fieldsOf(entries: YamlEntry[]): Map<string, YamlEntry> {
  return new Map(entries.map((entry) => [entry.key, entry] as const));
}

function closedKeys(
  findings: Finding[],
  entries: YamlEntry[],
  allowed: ReadonlySet<string>,
  where: string,
): void {
  for (const entry of entries) {
    if (!allowed.has(entry.key)) {
      refuse(findings, 'schema.key', entry.line, `${where}: unknown key "${entry.key}"`);
    }
  }
}

function asMap(findings: Finding[], node: YamlNode, what: string): MapNode | undefined {
  if (node.kind !== 'map') return refuse(findings, 'schema.type', node.line, `${what} must be a mapping`);
  return node;
}

function asSeq(findings: Finding[], node: YamlNode, what: string): SeqNode | undefined {
  if (node.kind !== 'seq') return refuse(findings, 'schema.type', node.line, `${what} must be a sequence`);
  return node;
}

/** A non-empty string scalar, or a finding. */
function scalarName(
  findings: Finding[],
  node: YamlNode,
  what: string,
): { value: string; line: number } | undefined {
  if (node.kind !== 'scalar' || typeof node.value !== 'string' || node.value === '') {
    return refuse(findings, 'schema.type', node.line, `${what} must be a non-empty string`);
  }
  return { value: node.value, line: node.line };
}

/** A declared name: a string that also matches the identifier rule. */
function identifier(
  findings: Finding[],
  node: YamlNode,
  what: string,
): { name: string; line: number } | undefined {
  const scalar = scalarName(findings, node, what);
  if (!scalar) return undefined;
  if (!IDENTIFIER.test(scalar.value)) {
    return refuse(
      findings,
      'schema.name',
      scalar.line,
      `${what} "${scalar.value}" must match ${IDENTIFIER.source}`,
    );
  }
  return { name: scalar.value, line: scalar.line };
}

function identifierKey(findings: Finding[], key: string, line: number, what: string): boolean {
  if (IDENTIFIER.test(key)) return true;
  refuse(findings, 'schema.name', line, `${what} "${key}" must match ${IDENTIFIER.source}`);
  return false;
}

function requiredIdentifier(
  findings: Finding[],
  fields: Map<string, YamlEntry>,
  key: string,
  line: number,
  what: string,
): { name: string; line: number } | undefined {
  const entry = fields.get(key);
  if (!entry) return refuse(findings, 'schema.required', line, `${what} needs "${key}"`);
  return identifier(findings, entry.value, `${what} ${key}`);
}

/** An optional sequence of identifiers (hooks, library mechanics/settings). */
function nameList(
  findings: Finding[],
  entry: YamlEntry,
  what: string,
  names: string[],
): Array<{ name: string; line: number }> {
  const node = asSeq(findings, entry.value, what);
  if (!node) return [];
  const out: Array<{ name: string; line: number }> = [];
  for (const item of node.items) {
    const name = identifier(findings, item, what);
    if (!name) continue;
    if (names.includes(name.name)) {
      refuse(findings, 'schema.name', name.line, `${what} names "${name.name}" twice`);
      continue;
    }
    names.push(name.name);
    out.push(name);
  }
  return out;
}

export function parseWorkflow(text: string): ParseWorkflowResult {
  let root: YamlNode;
  try {
    root = parseYaml(text);
  } catch (error) {
    if (error instanceof YamlError) return { invalid: error };
    throw error;
  }
  if (root.kind !== 'map') {
    return { invalid: new YamlError(root.line, 'the top level must be a mapping') };
  }

  const findings: Finding[] = [];
  closedKeys(findings, root.entries, TOP_KEYS, 'top level');
  const top = fieldsOf(root.entries);

  // workflow — the definition's name, part of every run's identity.
  let workflowName = '';
  const workflowEntry = top.get('workflow');
  if (!workflowEntry) refuse(findings, 'schema.required', root.line, '"workflow" is required');
  else {
    const name = identifier(findings, workflowEntry.value, 'workflow');
    if (name) workflowName = name.name;
  }

  // version — the schema version; only the integer 1.
  const versionEntry = top.get('version');
  if (!versionEntry) refuse(findings, 'schema.required', root.line, '"version" is required');
  else if (versionEntry.value.kind !== 'scalar' || versionEntry.value.value !== 1) {
    refuse(findings, 'schema.version', versionEntry.value.line, 'version must be the integer 1');
  }

  // initial / on — at least one entry point.
  let initial: string | undefined;
  const initialEntry = top.get('initial');
  if (initialEntry) {
    const name = identifier(findings, initialEntry.value, 'initial');
    if (name) initial = name.name;
  }

  const on: Workflow['on'] = [];
  const onEntry = top.get('on');
  if (onEntry) {
    const map = asMap(findings, onEntry.value, '"on"');
    if (map) {
      for (const entry of map.entries) {
        const kind = entry.key;
        if (!isEventKind(kind)) {
          refuse(findings, 'ref.event-kind', entry.line, `"on": "${kind}" is not an event kind`);
        }
        const state = identifier(findings, entry.value, `"on: ${kind}"`);
        if (isEventKind(kind) && state) on.push({ kind, state: state.name, line: entry.line });
      }
    }
  }
  if (!initialEntry && !onEntry) {
    refuse(findings, 'schema.required', root.line, 'one of "initial" or "on" is required');
  }

  // inputs — a sequence of unique names, filled from the record the trigger names.
  const inputs: string[] = [];
  const inputsEntry = top.get('inputs');
  if (inputsEntry) {
    const node = asSeq(findings, inputsEntry.value, '"inputs"');
    if (node) {
      const seen: string[] = [];
      for (const item of node.items) {
        const name = identifier(findings, item, 'input');
        if (!name) continue;
        if (seen.includes(name.name)) {
          refuse(findings, 'schema.name', name.line, `input "${name.name}" is declared twice`);
          continue;
        }
        seen.push(name.name);
        inputs.push(name.name);
      }
    }
  }

  // states — at least one, each with a closed key set.
  const states: Record<string, WorkflowState> = {};
  const statesEntry = top.get('states');
  if (!statesEntry) refuse(findings, 'schema.required', root.line, '"states" is required');
  else {
    const map = asMap(findings, statesEntry.value, '"states"');
    if (map) {
      if (map.entries.length === 0) {
        refuse(findings, 'schema.required', map.line, '"states" must declare at least one state');
      }
      for (const entry of map.entries) {
        identifierKey(findings, entry.key, entry.line, 'state');
        const state = parseState(findings, entry);
        if (state) states[entry.key] = state;
      }
    }
  }

  // transitions — a sequence (possibly empty for a one-state graph).
  const transitions: WorkflowTransition[] = [];
  const transitionsEntry = top.get('transitions');
  if (!transitionsEntry) refuse(findings, 'schema.required', root.line, '"transitions" is required');
  else {
    const node = asSeq(findings, transitionsEntry.value, '"transitions"');
    if (node) {
      for (const item of node.items) {
        const transition = parseTransition(findings, item);
        if (transition) transitions.push(transition);
      }
    }
  }

  // effects — optional map; every hook must resolve here (the checker's rule).
  const effects: Record<string, WorkflowEffect> = {};
  const effectsEntry = top.get('effects');
  if (effectsEntry) {
    const map = asMap(findings, effectsEntry.value, '"effects"');
    if (map) {
      for (const entry of map.entries) {
        identifierKey(findings, entry.key, entry.line, 'effect');
        const effect = parseEffect(findings, entry);
        if (effect) effects[entry.key] = effect;
      }
    }
  }

  // library — declarations only in v1.
  const library: Record<string, WorkflowLibraryEntry> = {};
  const libraryEntry = top.get('library');
  if (libraryEntry) {
    const map = asMap(findings, libraryEntry.value, '"library"');
    if (map) {
      for (const entry of map.entries) {
        identifierKey(findings, entry.key, entry.line, 'library entry');
        const value = asMap(findings, entry.value, `library entry "${entry.key}"`);
        if (!value) continue;
        closedKeys(findings, value.entries, LIBRARY_KEYS, `library entry "${entry.key}"`);
        const fields = fieldsOf(value.entries);
        const mechanicsEntry = fields.get('mechanics');
        const settingsEntry = fields.get('settings');
        const mechanics: string[] = [];
        const settings: string[] = [];
        if (mechanicsEntry) nameList(findings, mechanicsEntry, `library entry "${entry.key}" mechanics`, mechanics);
        if (settingsEntry) nameList(findings, settingsEntry, `library entry "${entry.key}" settings`, settings);
        library[entry.key] = { line: entry.line, name: entry.key, mechanics, settings };
      }
    }
  }

  // error — an optional named error path.
  let errorState: string | undefined;
  const errorEntry = top.get('error');
  if (errorEntry) {
    const name = identifier(findings, errorEntry.value, 'error');
    if (name) errorState = name.name;
  }

  if (findings.length) return { findings };

  const workflow: Workflow = {
    line: root.line,
    name: workflowName,
    version: 1,
    ...(initial ? { initial } : {}),
    on,
    inputs,
    states,
    transitions,
    effects,
    library,
    ...(errorState ? { error: errorState } : {}),
  };
  return { workflow, definition: definitionId(workflow, text) };
}

function parseState(findings: Finding[], entry: YamlEntry): WorkflowState | undefined {
  const map = asMap(findings, entry.value, `state "${entry.key}"`);
  if (!map) return undefined;
  closedKeys(findings, map.entries, STATE_KEYS, `state "${entry.key}"`);
  const fields = fieldsOf(map.entries);

  const enterEntry = fields.get('on-enter');
  const leaveEntry = fields.get('on-leave');
  const onEnter = enterEntry
    ? nameList(findings, enterEntry, `state "${entry.key}" on-enter`, [])
    : [];
  const onLeave = leaveEntry
    ? nameList(findings, leaveEntry, `state "${entry.key}" on-leave`, [])
    : [];

  let uses: { name: string; line: number } | undefined;
  const usesEntry = fields.get('uses');
  if (usesEntry) uses = identifier(findings, usesEntry.value, `state "${entry.key}" uses`);

  let wait: WorkflowWait | undefined;
  const waitEntry = fields.get('wait');
  if (waitEntry) wait = parseWait(findings, entry.key, waitEntry);

  return {
    line: entry.line,
    name: entry.key,
    onEnter,
    onLeave,
    ...(uses ? { uses } : {}),
    ...(wait ? { wait } : {}),
  };
}

function parseWait(findings: Finding[], state: string, entry: YamlEntry): WorkflowWait | undefined {
  const map = asMap(findings, entry.value, `state "${state}" wait`);
  if (!map) return undefined;
  closedKeys(findings, map.entries, WAIT_KEYS, `state "${state}" wait`);
  const fields = fieldsOf(map.entries);

  const forEntry = fields.get('for');
  const forValue = forEntry ? scalarName(findings, forEntry.value, `state "${state}" wait for`) : undefined;
  if (!forValue || (forValue.value !== 'approval' && forValue.value !== 'time')) {
    return refuse(
      findings,
      'graph.wait',
      forEntry?.value.line ?? entry.line,
      `state "${state}" wait needs for: approval | time`,
    );
  }

  if (forValue.value === 'approval') {
    const roleEntry = fields.get('role');
    const atEntry = fields.get('at');
    if (!roleEntry) {
      refuse(findings, 'graph.wait', forValue.line, `an approval wait needs a role`);
    }
    if (atEntry) {
      refuse(findings, 'graph.wait', atEntry.line, `an approval wait takes no at`);
    }
    const role = roleEntry
      ? identifier(findings, roleEntry.value, `state "${state}" wait role`)
      : undefined;
    return role ? { line: entry.line, for: 'approval', role } : undefined;
  }

  const atEntry = fields.get('at');
  const roleEntry = fields.get('role');
  if (!atEntry) {
    refuse(findings, 'graph.wait', forValue.line, `a time wait needs at`);
  }
  if (roleEntry) {
    refuse(findings, 'graph.wait', roleEntry.line, `a time wait takes no role`);
  }
  const at = atEntry ? identifier(findings, atEntry.value, `state "${state}" wait at`) : undefined;
  return at ? { line: entry.line, for: 'time', at } : undefined;
}

function parseTransition(findings: Finding[], item: YamlNode): WorkflowTransition | undefined {
  const map = asMap(findings, item, 'transition');
  if (!map) return undefined;
  closedKeys(findings, map.entries, TRANSITION_KEYS, 'transition');
  const fields = fieldsOf(map.entries);
  const where = `transition at line ${map.line}`;

  const from = requiredIdentifier(findings, fields, 'from', map.line, where);
  const to = requiredIdentifier(findings, fields, 'to', map.line, where);
  const role = requiredIdentifier(findings, fields, 'role', map.line, where);

  let on: SignalName | undefined;
  const onEntry = fields.get('on');
  if (!onEntry) refuse(findings, 'schema.required', map.line, `${where} needs "on"`);
  else {
    const scalar = scalarName(findings, onEntry.value, `${where} on`);
    if (scalar) {
      if (isSignalName(scalar.value)) on = scalar.value;
      else if (isEventKind(scalar.value)) {
        refuse(
          findings,
          'vocab.bus-kind',
          scalar.line,
          `"${scalar.value}" is an event kind, not a transition signal`,
        );
      } else {
        refuse(findings, 'vocab.signal', scalar.line, `"${scalar.value}" is not a transition signal`);
      }
    }
  }

  let guard: { name: string; line: number } | undefined;
  const guardEntry = fields.get('guard');
  if (guardEntry) guard = identifier(findings, guardEntry.value, `${where} guard`);

  if (!from || !to || !role || !on) return undefined;
  return { line: map.line, from: from.name, to: to.name, on, ...(guard ? { guard } : {}), role };
}

function parseEffect(findings: Finding[], entry: YamlEntry): WorkflowEffect | undefined {
  const map = asMap(findings, entry.value, `effect "${entry.key}"`);
  if (!map) return undefined;
  closedKeys(findings, map.entries, EFFECT_KEYS, `effect "${entry.key}"`);
  const fields = fieldsOf(map.entries);
  const where = `effect "${entry.key}"`;

  const run = requiredIdentifier(findings, fields, 'run', map.line, where);
  const role = requiredIdentifier(findings, fields, 'role', map.line, where);

  const capabilityEntry = fields.get('capability');
  let capability: Capability | undefined;
  if (capabilityEntry) {
    const scalar = scalarName(findings, capabilityEntry.value, `${where} capability`);
    if (scalar) {
      if (CAPABILITIES.has(scalar.value)) capability = scalar.value as Capability;
      else {
        refuse(
          findings,
          'annotation.capability',
          scalar.line,
          `${where}: "${scalar.value}" is not one of ${[...CAPABILITIES].join(', ')}`,
        );
      }
    }
  }

  const actAsEntry = fields.get('act-as');
  let actAs: { value: string; line: number } | undefined;
  if (actAsEntry) actAs = scalarName(findings, actAsEntry.value, `${where} act-as`);

  // Required except on an act-as effect, where the Kernel's ref-operation word is still open.
  if (!capabilityEntry && !actAsEntry) {
    refuse(findings, 'annotation.capability', map.line, `${where} needs a capability`);
  }

  const reachEntry = fields.get('reach');
  let reach: { value: 'outside-machine'; line: number } | undefined;
  if (reachEntry) {
    const scalar = scalarName(findings, reachEntry.value, `${where} reach`);
    if (scalar) {
      if (scalar.value === 'outside-machine') reach = { value: 'outside-machine', line: scalar.line };
      else {
        refuse(
          findings,
          'annotation.reach',
          scalar.line,
          `${where}: reach must be "outside-machine"`,
        );
      }
    }
  }

  if (!run || !role) return undefined;
  return {
    line: map.line,
    name: entry.key,
    run,
    role,
    ...(capability ? { capability } : {}),
    ...(actAs ? { actAs } : {}),
    ...(reach ? { reach } : {}),
  };
}

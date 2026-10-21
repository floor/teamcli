// WF1-DRY: the dry script reader. A script supplies everything a dry run reads besides the
// definition: its target and artifact, the settings and inputs it resolves, the synthetic
// evidence fixtures, and one signal entry per scripted transition with an instant. This module
// checks the document's shape and closed vocabulary only. A setting or evidence ref the graph
// needs and the script omits is a runner stop (`settings.missing` / `evidence.missing`), never a
// reader error; a fixture with a wrong field type reaches the core and is refused there.

import { parseYaml, YamlError, type YamlEntry, type YamlNode } from '../../yaml.ts';
import { isSignalName, type SignalName } from '../signals.ts';
import type {
  ArtifactRef,
  EvidenceDocument,
  EvidenceRecord,
  EvidenceRef,
  Revision,
} from '../types.ts';

/** One scripted transition: the signal, its instant, its request identity and cited evidence. */
export type DrySignal = {
  signal: SignalName;
  at: string;
  requestId: string;
  /** The revision the run must be at; a mismatch is the core's `core.revision-stale`. */
  expectedRevision: Revision;
  evidence: EvidenceRef[];
};

/** The parsed dry script. Every field is required; `signals` may be empty. */
export type DryScript = {
  format: 1;
  target: string;
  artifact: ArtifactRef;
  settings: Record<string, string>;
  inputs: Record<string, string>;
  evidence: EvidenceDocument;
  signals: DrySignal[];
};

export type DryScriptReadResult =
  | { ok: true; script: DryScript }
  | { ok: false; code: 'workflow.script' | 'workflow.evidence'; why: string };

type MapNode = Extract<YamlNode, { kind: 'map' }>;
type SeqNode = Extract<YamlNode, { kind: 'seq' }>;

const SCRIPT_KEYS = [
  'format',
  'target',
  'artifact',
  'settings',
  'inputs',
  'evidence',
  'signals',
] as const;

const SIGNAL_KEYS = ['signal', 'at', 'request-id', 'expected-revision', 'evidence'] as const;

/** Read a dry script from its YAML text. Shape, vocabulary and types only. */
export function readScript(text: string): DryScriptReadResult {
  try {
    return { ok: true, script: parseScript(text) };
  } catch (error) {
    if (error instanceof ScriptRefusal) {
      return { ok: false, code: error.code, why: error.message };
    }
    throw error;
  }
}

function parseScript(text: string): DryScript {
  let root: YamlNode;
  try {
    root = parseYaml(text);
  } catch (error) {
    if (error instanceof YamlError) {
      throw new ScriptRefusal('workflow.script', `line ${error.line}: ${error.message}`);
    }
    throw error;
  }
  const map = asMap(root, 'the script');
  const fields = closedKeys(map, 'the script', SCRIPT_KEYS);

  const format = fields.get('format')!;
  if (!isScalar(format) || format.value !== 1) {
    throw new ScriptRefusal('workflow.script', `${at(format)}: format must be the integer 1`);
  }

  return {
    format: 1,
    target: stringScalar(fields.get('target')!, 'target'),
    artifact: artifactRef(fields.get('artifact')!, 'artifact'),
    settings: stringMap(fields.get('settings')!, 'settings'),
    inputs: stringMap(fields.get('inputs')!, 'inputs'),
    evidence: evidenceBlock(fields.get('evidence')!),
    signals: signalList(asSeq(fields.get('signals')!, 'signals')),
  };
}

// ---------------------------------------------------------------------------------------------
// Document checks. A refusal carries the exit row B3 maps: a script shape problem is
// `workflow.script`; a fixture that is not even a mapping is a malformed evidence block.

class ScriptRefusal extends Error {
  code: 'workflow.script' | 'workflow.evidence';

  constructor(code: 'workflow.script' | 'workflow.evidence', message: string) {
    super(message);
    this.name = 'ScriptRefusal';
    this.code = code;
  }
}

function refuse(message: string): never {
  throw new ScriptRefusal('workflow.script', message);
}

function refuseEvidence(message: string): never {
  throw new ScriptRefusal('workflow.evidence', message);
}

function at(node: YamlNode): string {
  return `line ${node.line}`;
}

function isScalar(node: YamlNode): node is Extract<YamlNode, { kind: 'scalar' }> {
  return node.kind === 'scalar';
}

function asMap(node: YamlNode, where: string): MapNode {
  if (node.kind !== 'map') refuse(`${at(node)}: ${where} must be a mapping`);
  return node;
}

function asSeq(node: YamlNode, where: string): SeqNode {
  if (node.kind !== 'seq') refuse(`${at(node)}: ${where} must be a sequence`);
  return node;
}

/** The closed key set: required keys present, unknown keys and duplicate keys refused. */
function closedKeys(
  map: MapNode,
  where: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Map<string, YamlNode> {
  const fields = new Map<string, YamlNode>();
  for (const entry of map.entries) {
    if (fields.has(entry.key)) {
      refuse(`line ${entry.line}: ${where}: key "${entry.key}" appears twice`);
    }
    if (!required.includes(entry.key) && !optional.includes(entry.key)) {
      refuse(`line ${entry.line}: ${where}: unknown key "${entry.key}"`);
    }
    fields.set(entry.key, entry.value);
  }
  for (const key of required) {
    if (!fields.has(key)) refuse(`${at(map)}: ${where}: missing "${key}"`);
  }
  return fields;
}

function stringScalar(node: YamlNode, where: string): string {
  if (!isScalar(node) || typeof node.value !== 'string' || node.value === '') {
    refuse(`${at(node)}: ${where} must be a non-empty string`);
  }
  return node.value;
}

/** A map name → string. Values may be empty strings; the runner passes them through unchanged. */
function stringMap(node: YamlNode, where: string): Record<string, string> {
  const map = asMap(node, where);
  const out: Record<string, string> = {};
  for (const entry of map.entries) {
    if (entry.key === '') refuse(`line ${entry.line}: ${where} has an empty name`);
    if (Object.prototype.hasOwnProperty.call(out, entry.key)) {
      refuse(`line ${entry.line}: ${where}: key "${entry.key}" appears twice`);
    }
    const value = entry.value;
    if (!isScalar(value) || typeof value.value !== 'string') {
      refuse(`line ${value.line}: ${where}.${entry.key} must be a string`);
    }
    out[entry.key] = value.value;
  }
  return out;
}

function artifactRef(node: YamlNode, where: string): ArtifactRef {
  const map = asMap(node, where);
  const fields = fieldsOf(map);
  const kindEntry = fields.get('kind');
  if (kindEntry === undefined) refuse(`${at(map)}: ${where}: missing "kind"`);
  const kind = kindEntry.value;
  if (!isScalar(kind) || typeof kind.value !== 'string') {
    refuse(`${at(kind)}: ${where}.kind must be a string`);
  }
  if (kind.value === 'none') {
    closedKeys(map, where, ['kind']);
    return { kind: 'none' };
  }
  if (kind.value === 'ref' || kind.value === 'tree') {
    closedKeys(map, where, ['kind', 'value']);
    const valueEntry = fields.get('value');
    if (valueEntry === undefined) refuse(`${at(map)}: ${where}: missing "value"`);
    return { kind: kind.value, value: stringScalar(valueEntry.value, `${where}.value`) };
  }
  refuse(`${at(kind)}: ${where}.kind must be "none", "ref" or "tree"`);
}

/** ref → fixture. A fixture must be a mapping; field types are the core's to refuse. */
function evidenceBlock(node: YamlNode): EvidenceDocument {
  const map = asMap(node, 'evidence');
  const out: EvidenceDocument = {};
  for (const entry of map.entries) {
    if (entry.key === '') refuse(`line ${entry.line}: evidence has an empty ref`);
    if (Object.prototype.hasOwnProperty.call(out, entry.key)) {
      refuse(`line ${entry.line}: evidence: ref "${entry.key}" appears twice`);
    }
    if (entry.value.kind !== 'map') {
      refuseEvidence(`line ${entry.value.line}: evidence.${entry.key} must be a mapping`);
    }
    out[entry.key] = toRecord(entry.value);
  }
  return out;
}

function toRecord(node: MapNode): EvidenceRecord {
  const record: Record<string, unknown> = {};
  for (const entry of node.entries) {
    if (entry.key === '' || Object.prototype.hasOwnProperty.call(record, entry.key)) {
      refuseEvidence(`line ${entry.line}: evidence fixture: key "${entry.key}" is empty or repeated`);
    }
    record[entry.key] = toScalar(entry.value, `evidence fixture "${entry.key}"`);
  }
  return record as EvidenceRecord;
}

/** Fixture fields are JSON scalars, sequences or mappings; keep the supplied shape whole. */
function toScalar(node: YamlNode, where: string): unknown {
  if (node.kind === 'scalar') return node.value;
  if (node.kind === 'seq') return node.items.map((item) => toScalar(item, where));
  const out: Record<string, unknown> = {};
  for (const entry of node.entries) {
    if (Object.prototype.hasOwnProperty.call(out, entry.key)) {
      refuseEvidence(`line ${entry.line}: ${where}: key "${entry.key}" appears twice`);
    }
    out[entry.key] = toScalar(entry.value, `${where}.${entry.key}`);
  }
  return out;
}

function signalList(seq: SeqNode): DrySignal[] {
  return seq.items.map((item, index) => signalEntry(item, `signals[${index}]`));
}

function signalEntry(node: YamlNode, where: string): DrySignal {
  const map = asMap(node, where);
  const fields = closedKeys(map, where, SIGNAL_KEYS);

  const signalNode = fields.get('signal')!;
  const signal = stringScalar(signalNode, `${where}.signal`);
  if (!isSignalName(signal)) {
    refuse(`${at(signalNode)}: ${where}.signal "${signal}" is not a transition signal`);
  }

  const revisionNode = fields.get('expected-revision')!;
  if (
    !isScalar(revisionNode) ||
    typeof revisionNode.value !== 'number' ||
    !Number.isInteger(revisionNode.value) ||
    revisionNode.value < 0
  ) {
    refuse(`${at(revisionNode)}: ${where}.expected-revision must be an integer >= 0`);
  }

  const evidenceNode = asSeq(fields.get('evidence')!, `${where}.evidence`);
  const evidence = evidenceNode.items.map((ref, index) => {
    if (!isScalar(ref) || typeof ref.value !== 'string' || ref.value === '') {
      refuse(`${at(ref)}: ${where}.evidence[${index}] must be a non-empty ref`);
    }
    return ref.value;
  });

  return {
    signal,
    at: stringScalar(fields.get('at')!, `${where}.at`),
    requestId: stringScalar(fields.get('request-id')!, `${where}.request-id`),
    expectedRevision: revisionNode.value,
    evidence,
  };
}

function fieldsOf(map: MapNode): Map<string, YamlEntry> {
  return new Map(map.entries.map((entry) => [entry.key, entry] as const));
}

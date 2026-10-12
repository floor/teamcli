import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Effort words a lab allows, format 1. A lab is the seat's `vendor`.
 *
 * Words come from that lab's CLI help, and a lab whose help or model list does not
 * list them is absent. A vendor with no entry accepts any effort: the field is free
 * text in the file (`meridian`, `deepseek`, `xai`), and inventing a list would refuse
 * a seat this build cannot check.
 *
 *   `claude --help` (2026-10-12): `--effort <level>` `(low, medium, high, xhigh, max)`
 *   `agy --help` (2026-10-12): `--effort` `(low|medium|high|xhigh|max)`
 *
 * Left out: `grok --help` names `--reasoning-effort <EFFORT>` and lists no words, and
 * `grok models` lists model ids. `codex --help` does not name an effort. `cursor-agent
 * --list-models` prints model ids, not an effort list.
 */
export const EFFORT_FORMAT = 1;

export type EffortLabs = Readonly<Record<string, readonly string[]>>;

export type EffortVocabulary =
  | { ok: true; format: number; labs: EffortLabs }
  | { ok: false; message: string };

function wordsOf(lab: string, value: unknown): readonly string[] | string {
  if (!Array.isArray(value) || value.some((word) => typeof word !== 'string' || word === '')) {
    return `effort vocabulary labs.${lab} must be a list of words`;
  }
  return value;
}

/** The vocabulary a document declares. Format other than {@link EFFORT_FORMAT} is refused. */
export function parseEfforts(value: unknown): EffortVocabulary {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'effort vocabulary must be an object with format and labs' };
  }
  const record = value as Record<string, unknown>;
  if (record.format !== EFFORT_FORMAT) {
    const seen = typeof record.format === 'number' ? String(record.format) : JSON.stringify(record.format ?? null);
    return { ok: false, message: `effort vocabulary format is ${seen}; this build reads ${EFFORT_FORMAT}` };
  }
  if (record.labs === null || typeof record.labs !== 'object' || Array.isArray(record.labs)) {
    return { ok: false, message: 'effort vocabulary labs must be an object of lab names to word lists' };
  }
  const labs: Record<string, readonly string[]> = {};
  for (const [lab, words] of Object.entries(record.labs as Record<string, unknown>)) {
    const parsed = wordsOf(lab, words);
    if (typeof parsed === 'string') return { ok: false, message: parsed };
    labs[lab] = parsed;
  }
  return { ok: true, format: EFFORT_FORMAT, labs };
}

/** The vocabulary shipped beside this module. A file this build cannot read fails `team check`. */
export function shippedEfforts(): EffortVocabulary {
  let text: string;
  try {
    text = readFileSync(fileURLToPath(new URL('./efforts.json', import.meta.url)), 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `effort vocabulary could not be read: ${message}` };
  }
  try {
    return parseEfforts(JSON.parse(text) as unknown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `effort vocabulary is not JSON: ${message}` };
  }
}

import { readFileSync } from 'node:fs';

/**
 * Effort words a lab allows, format 1. A lab is the seat's `vendor`.
 *
 * Words come from that lab's CLI help. A lab whose help or model list does not
 * list them is absent. A vendor with no entry accepts any effort: the field is
 * free text in the file (`meridian`, `deepseek`, `xai`, `openai`), and inventing
 * a list would refuse a seat this build cannot check.
 *
 *   `claude --version` (2026-10-12) printed `2.1.296 (Claude Code)`.
 *   `claude --help` names `--effort <level>` `(low, medium, high, xhigh, max)`.
 *   `agy --version` (2026-10-12) printed `1.3.3`.
 *   `agy --help` names `--effort` `(low|medium|high|xhigh|max)`.
 *
 *   `muse --version` (2026-10-16) printed `Muse Code 1.4.9 (1.4.9-R6297.1)`.
 *   `muse serve` answered `model/list` with `supportedReasoningEfforts`
 *   `minimal, low, medium, high, xhigh, max` for the Wonder and Spark 1.3 models. Spark 1.2
 *   stops at `xhigh`, and `muse exec --help` also names `none` and `ultra`; the list keeps the
 *   words every listed model takes.
 *
 * Left out the same day: `grok --help` names `--reasoning-effort <EFFORT>`
 * (alias `--effort`) and lists no words, and `grok models` lists model ids.
 * `codex --help` and `codex exec --help` do not name an effort. `cursor-agent
 * --help` does not list effort levels; `cursor-agent --list-models` prints
 * model ids, and one `--model` example contains `effort=high` inside a model id.
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

/** The vocabulary shipped beside this module. A file this build cannot read is a warning, not a failed check. */
export function shippedEfforts(): EffortVocabulary {
  let text: string;
  try {
    text = readFileSync(new URL('./efforts.json', import.meta.url), 'utf8');
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

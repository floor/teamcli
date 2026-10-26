// The entity model rule (Policies rule 10): which labs may run on which seats of an entity,
// held as one policy value. The grammar is small and closed:
//
//   orchestrator=anthropic; architect=anthropic; *=!anthropic
//
// One entry per `;`, `<subject>=<labs>`. A subject is a seat name, a role word, or `*`; the
// most specific subject wins (a seat name over a role over `*`), and the first entry of that
// subject is the one that decides. A seat no entry names is allowed. Labs are `+`-joined
// vendor words, matched case-insensitively against the file's `vendor:`. A plain list is
// what the seat may run; a list of `!`-prefixed words is what it may not. One entry mixes
// the two forms never.
//
// A value that does not parse is refused with `policy.invalid` and the reason names the
// entry, so an owner fixing the rule knows which word to look at.

/** The canonical, parsed form of one entry. */
export type ModelRuleEntry = {
  /** A seat name, a role word, or `*`. */
  subject: string;
  /** True for a plain list (the labs allowed), false for a negated list (the labs refused). */
  allow: boolean;
  /** Lowercase vendor words. */
  labs: readonly string[];
};

const LAB_WORD = /^[a-z][a-z0-9._-]*$/;
const SUBJECT_WORD = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The entries a raw value holds, or null when it does not parse. */
export function parseModelRule(raw: unknown): ModelRuleEntry[] | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '') return null;
  const entries: ModelRuleEntry[] = [];
  const seen = new Set<string>();
  for (const part of text.split(';')) {
    const entry = part.trim();
    if (entry === '') return null;
    const eq = entry.indexOf('=');
    if (eq <= 0 || eq !== entry.lastIndexOf('=')) return null;
    const subject = entry.slice(0, eq).trim();
    if (subject !== '*' && !SUBJECT_WORD.test(subject)) return null;
    const labWords = entry.slice(eq + 1).split('+').map((word) => word.trim());
    if (labWords.length === 0 || labWords.some((word) => word === '')) return null;
    const negated = labWords.map((word) => word.startsWith('!'));
    if (negated.some((neg) => neg !== negated[0])) return null;
    const labs: string[] = [];
    for (const word of labWords) {
      const lab = word.replace(/^!/, '').toLowerCase();
      if (!LAB_WORD.test(lab) || labs.includes(lab)) return null;
      labs.push(lab);
    }
    if (seen.has(subject)) return null;
    seen.add(subject);
    entries.push({ subject, allow: !negated[0], labs });
  }
  return entries;
}

/** The catalogue's custom reason a raw value was refused; null when it parses. */
export function modelRuleProblem(raw: unknown): string | null {
  if (Array.isArray(raw)) return 'model-rule must be one line of entries, not a list';
  if (typeof raw !== 'string') return 'model-rule must be one line of entries';
  const text = raw.trim();
  if (text === '') return 'model-rule is empty; unset it instead';
  const seen = new Set<string>();
  for (const part of text.split(';')) {
    const entry = part.trim();
    if (entry === '') return 'model-rule has an empty entry between two `;`';
    const eq = entry.indexOf('=');
    if (eq <= 0 || eq !== entry.lastIndexOf('=')) {
      return `model-rule entry "${entry}" must read <seat|role|*>=<lab>+<lab>`;
    }
    const subject = entry.slice(0, eq).trim();
    if (subject !== '*' && !SUBJECT_WORD.test(subject)) {
      return `model-rule entry "${entry}" names the subject "${subject}", which is no seat, role or *`;
    }
    if (seen.has(subject)) return `model-rule names "${subject}" twice; the first entry would decide and the second would never count`;
    seen.add(subject);
    const labWords = entry.slice(eq + 1).split('+').map((word) => word.trim());
    if (labWords.some((word) => word === '')) return `model-rule entry "${entry}" has an empty lab word`;
    const negated = labWords.map((word) => word.startsWith('!'));
    if (negated.some((neg) => neg !== negated[0])) {
      return `model-rule entry "${entry}" mixes allowed and refused labs; write one form or the other`;
    }
    const labs = new Set<string>();
    for (const word of labWords) {
      const lab = word.replace(/^!/, '').toLowerCase();
      if (!LAB_WORD.test(lab)) return `model-rule entry "${entry}" names the lab "${word}", which is not a vendor word`;
      if (labs.has(lab)) return `model-rule entry "${entry}" names the lab "${lab}" twice`;
      labs.add(lab);
    }
  }
  return null;
}

/** The canonical spelling of parsed entries: what a set writes and a listing shows. */
export function formatModelRule(entries: readonly ModelRuleEntry[]): string {
  return entries
    .map((entry) => `${entry.subject}=${entry.labs.map((lab) => (entry.allow ? lab : `!${lab}`)).join('+')}`)
    .join('; ');
}

/** The entry that decides for a seat, by subject precedence: name, then role, then `*`. */
export function modelRuleEntryFor(
  entries: readonly ModelRuleEntry[],
  subject: { name: string; role?: string },
): ModelRuleEntry | undefined {
  const byName = entries.find((entry) => entry.subject === subject.name);
  if (byName) return byName;
  const role = subject.role?.trim();
  if (role) {
    const byRole = entries.find((entry) => entry.subject === role);
    if (byRole) return byRole;
  }
  return entries.find((entry) => entry.subject === '*');
}

/**
 * Whether a seat's vendor satisfies the rule. A seat no entry decides for is allowed; a
 * vendor word is compared in lowercase, as the file writes it.
 */
export function modelRuleAllows(
  entries: readonly ModelRuleEntry[],
  subject: { name: string; role?: string; vendor: string },
): boolean {
  const entry = modelRuleEntryFor(entries, subject);
  if (!entry) return true;
  const vendor = subject.vendor.trim().toLowerCase();
  const named = entry.labs.includes(vendor);
  return entry.allow ? named : !named;
}

/** Whether the rule allows a lab for a pane no seat claims: such a pane has no name or role to
 *  answer for it, so only the `*` entry can decide. No `*` entry allows every lab. */
export function modelRuleAllowsUnclaimed(entries: readonly ModelRuleEntry[], lab: string): boolean {
  const entry = entries.find((candidate) => candidate.subject === '*');
  if (!entry) return true;
  const named = entry.labs.includes(lab.trim().toLowerCase());
  return entry.allow ? named : !named;
}

/** The rule in force for an entity, parsed; the empty default is no rule at all. */
export function parseModelRuleValue(raw: unknown): ModelRuleEntry[] {
  return parseModelRule(raw) ?? [];
}

/** The maker word a model's display name begins with, and the lab it names in the rule's vendor
 *  vocabulary. The table is closed on purpose: it holds the families this version's launch
 *  profiles map, and a maker outside it has no lab the rule can judge. */
const MODEL_LABS: ReadonlyArray<readonly [string, string]> = [
  ['claude', 'anthropic'],
  ['gpt', 'openai'],
  ['gemini', 'google'],
  ['grok', 'xai'],
  ['muse', 'meta'],
  ['composer', 'cursor'],
  ['deepseek', 'deepseek'],
  ['glm', 'zhipu'],
  ['z.ai', 'zhipu'],
  ['zai', 'zhipu'],
  ['zhipu', 'zhipu'],
  ['kimi', 'moonshot'],
  ['moonshot', 'moonshot'],
];

/**
 * The sentence a model the rule does not allow on a seat is refused with, without the seat's
 * name in front: `config set`, a launch line and the entity rule's listing say the same words.
 */
export function modelRuleSentence(model: string, lab: string): string {
  return `the model ${JSON.stringify(model)} runs under the lab "${lab}", which the entity model rule in force does not allow on this seat`;
}

/** The sentence a model whose maker this version cannot name is refused with, when the rule
 *  decides the seat, without the seat's name in front. */
export function modelRuleUnknownSentence(model: string): string {
  return `the model ${JSON.stringify(model)} names no lab this version knows, and the entity model rule decides this seat`;
}

/**
 * The lab a model runs under, read from the maker word its display name begins with (`Claude
 * Opus`, `GPT Sol`, `Gemini Pro`, `Grok 4.7`, `Muse Wonder`, `Composer`). Undefined when the
 * maker is not in the closed table: a caller that must judge a lab then decides its own answer
 * — never a guess, and never the lab the file happens to declare today.
 */
export function labOfModel(model: string): string | undefined {
  const text = model.trim().toLowerCase();
  if (text === '') return undefined;
  for (const [maker, lab] of MODEL_LABS) {
    if (text === maker || text.startsWith(`${maker} `) || text.startsWith(`${maker}-`)) return lab;
  }
  return undefined;
}

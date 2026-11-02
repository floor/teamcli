// A CLI that keeps one background server behind every seat refuses a second front end whose
// feature settings differ ("background server has incompatible feature settings"), and the seat
// that answers its own dialog with "run without daemon" loses the route its drops arrive on.
// The profile's `features` list is the one set every launch pins, appended after the seat's own
// words so the CLI's own last-wins config rule makes them the effective values. This module reads
// a launch line back for those words, so `team doctor` and `team check` can name a running seat
// whose RECORDED line (the base recipe in team's own state, never a process's command line) does
// not carry the pin.

/** The words a launch line carries for one pinned feature set: `-c features.<name>=<value>`,
 *  one pair per entry. The profile refuses any pair that is not `name=true|false`, so these
 *  words are always bare shell words and need no quoting. */
export function pinnedWords(features: readonly string[]): string[] {
  return features.flatMap((pair) => ['-c', `features.${pair}`]);
}

/** A base recipe with the profile's pins appended, as the launch record stores it. The pins ride
 *  after every word the seat's line carries, which is where the launch puts them, so a repeated
 *  config key resolves to the pin: measured on codex-cli 0.161.0 in a scratch CODEX_HOME, a
 *  duplicated `-c` for one key took the last value in both orders. */
export function pinnedLine(line: string, features: readonly string[]): string {
  const words = pinnedWords(features);
  return words.length === 0 ? line : `${line.trimEnd()} ${words.join(' ')}`;
}

/** One feature name's effective value on a launch line, read the way the CLI reads its own
 *  words. Only `-c`/`--config` pairs are read — the spelling the profile pins and the one the
 *  seat's own config words already use — with the last pair for a name winning, so a pin
 *  appended after the line's own words is the value found. A bare `--` ends option parsing,
 *  as it does for the CLI: a word after it is positional, and a config-shaped prompt word
 *  names no feature. */
export function featureSettings(line: string): Map<string, boolean> {
  const words = line.match(/(?:[^\s'"\\]+|\\.|'[^']*'|"(?:[^"\\]|\\.)*")+/g) ?? [];
  const settings = new Map<string, boolean>();
  const unquote = (word: string): string =>
    (word.match(/'[^']*'|"(?:[^"\\]|\\.)*"|\\.|[^'"\\]+/g) ?? [])
      .map((part) => {
        if (part.startsWith("'")) return part.slice(1, -1);
        if (part.startsWith('"')) return part.slice(1, -1).replace(/\\(.)/g, '$1');
        if (part.startsWith('\\')) return part.slice(1);
        return part;
      })
      .join('');
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === '--') break;
    const inline = /^--config=(.*)$/.exec(word);
    const value = word === '-c' || word === '--config' ? words[i + 1] : inline?.[1];
    if (value === undefined) continue;
    if (word === '-c' || word === '--config') i++;
    const pair = /^features\.([A-Za-z0-9_]+)=(true|false)$/.exec(unquote(value).trim());
    if (pair !== null) settings.set(pair[1]!, pair[2] === 'true');
  }
  return settings;
}

/** The profile's pinned pairs a recorded launch line does not set: absent from it, or set to the
 *  other value. Empty when every pin is effectively on the line. A feature name the line sets on
 *  its own, outside this list, is the file's own word and not this reading's to refuse. */
export function featureGaps(line: string, required: readonly string[]): string[] {
  const settings = featureSettings(line);
  const gaps: string[] = [];
  for (const pair of required) {
    const at = pair.lastIndexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at);
    if (settings.get(name) !== (pair.slice(at + 1) === 'true')) gaps.push(pair);
  }
  return gaps;
}

/** The sentence naming a seat whose recorded line misses its profile's pins, or null when the
 *  line carries them all. `undefined` is a seat whose record holds no launch line at all: that
 *  is unknown, not wrong, and said so — the record itself cannot be repaired, only the relaunch
 *  that writes one. The profile list is empty for a CLI that pins no features: nothing is said. */
export function featureMismatch(line: string | undefined, features: readonly string[]): string | null {
  if (features.length === 0) return null;
  // Named as the launch line spells them: the profile list holds `name=value`, the word on the
  // line is `features.name=value`, and this sentence is about the line.
  const said = (pairs: readonly string[]): string => pairs.map((pair) => `features.${pair}`).join(', ');
  if (line === undefined) return `its recorded launch line is unknown; the profile pins ${said(features)} on every launch`;
  const gaps = featureGaps(line, features);
  if (gaps.length === 0) return null;
  return `its recorded launch line does not pin ${said(gaps)}; the profile pins ${said(features)} on every launch`;
}

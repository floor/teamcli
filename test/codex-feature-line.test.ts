// Reading a launch line's feature words and comparing them with the profile's pins.
// The CLI reads the last value for a repeated config key, so the reader does too; a bare `--`
// ends option parsing; words for names the profile does not pin are the line's own and never a gap.
import { describe, expect, test } from 'bun:test';
import { featureGaps, featureMismatch, featureSettings, pinnedWords } from '../src/launch/features.ts';
import { pinnedRecordLine } from '../src/profiles/profile.ts';

describe('featureSettings reads -c and --config words', () => {
  test('the last word for a name wins, in either order', () => {
    expect(featureSettings('codex -c features.mcp_oauth_refresh_coordination=true -c features.mcp_oauth_refresh_coordination=false').get('mcp_oauth_refresh_coordination')).toBe(false);
    expect(featureSettings('codex -c features.mcp_oauth_refresh_coordination=false -c features.mcp_oauth_refresh_coordination=true').get('mcp_oauth_refresh_coordination')).toBe(true);
  });

  test('the --config= form is read as one word', () => {
    expect(featureSettings('codex --config=features.x=true').get('x')).toBe(true);
  });

  test('a bare -- ends option parsing, in every spelling the shell accepts', () => {
    expect(featureSettings('codex -- -c features.x=true').size).toBe(0);
    expect(featureSettings("codex '--' -c features.x=true").size).toBe(0);
    expect(featureSettings('codex "--" -c features.x=true').size).toBe(0);
  });

  test('non-feature config words are ignored', () => {
    expect(featureSettings('codex -c model_reasoning_effort=high').size).toBe(0);
  });
});

describe('pinnedWords and the recorded recipe', () => {
  test('one pair becomes one -c word pair', () => {
    expect(pinnedWords(['x=false', 'y=true'])).toEqual(['-c', 'features.x=false', '-c', 'features.y=true']);
  });

  test('the pins ride after the line as written, and an empty set leaves the line alone', () => {
    expect(pinnedRecordLine('codex', 'codex -m gpt-6.1-sol', ['x=false'])).toBe('codex -m gpt-6.1-sol -c features.x=false');
    expect(pinnedRecordLine('codex', 'codex -m gpt-6.1-sol', [])).toBe('codex -m gpt-6.1-sol');
  });

  test('a positional delimiter takes the pins before it, in every spelling', () => {
    for (const delimiter of ['--', "'--'", '"--"']) {
      expect(pinnedRecordLine('codex', `codex -m gpt-6.1-sol ${delimiter} 'a prompt'`, ['x=false'])).toBe(
        `codex -m gpt-6.1-sol -c features.x=false ${delimiter} 'a prompt'`,
      );
    }
  });

  test("a quoted script's own delimiter is the CLI's: the pins go inside, before it", () => {
    // The outer shell sees one quoted word, so the old reader wrote the pin after the closing
    // quote — where the CLI never receives it — while the launch put its own options inside.
    for (const line of [
      "/bin/sh -c 'codex -m gpt-6.1-sol -- a prompt'",
      '/bin/sh -c "codex -m gpt-6.1-sol -- a prompt"',
    ]) {
      const record = pinnedRecordLine('codex', line, ['x=false']);
      expect(record).toBe(line.replace(' -m gpt-6.1-sol', ' -m gpt-6.1-sol -c features.x=false'));
      // The recorded pin is one the CLI reads, so the reader finds no gap.
      expect(featureGaps(record, ['x=false'])).toEqual([]);
      // The words after the delimiter keep their place and are not options.
      expect(featureSettings(record).get('x')).toBe(false);
    }
  });
});

describe('featureGaps compares only the profile pins', () => {
  test('a missing pin is a gap', () => {
    expect(featureGaps('codex -m gpt-6.1-sol', ['x=false'])).toEqual(['x=false']);
  });

  test('a pin set the other way is a gap', () => {
    expect(featureGaps('codex -c features.x=true', ['x=false'])).toEqual(['x=false']);
  });

  test('a matching pin is no gap, and the line’s own other features are ignored', () => {
    expect(featureGaps('codex -c features.x=false', ['x=false'])).toEqual([]);
    expect(featureGaps('codex -c features.other=true -c features.x=false', ['x=false'])).toEqual([]);
  });

  test('a config word after a positional delimiter names no feature, in every spelling', () => {
    for (const delimiter of ['--', "'--'", '"--"']) {
      expect(featureGaps(`codex ${delimiter} -c features.x=false`, ['x=false'])).toEqual(['x=false']);
    }
  });

  test('a pin inside a quoted script is the CLI’s; one written after the script is not', () => {
    expect(featureGaps("/bin/sh -c 'codex -c features.x=false'", ['x=false'])).toEqual([]);
    expect(featureGaps('/bin/sh -c "codex -c features.x=false"', ['x=false'])).toEqual([]);
    expect(featureGaps("/bin/sh -c 'codex' -c features.x=false", ['x=false'])).toEqual(['x=false']);
  });

  test('a line the scope cannot decode carries no proven pin, and its report says so', () => {
    expect(featureGaps("codex 'unclosed", ['x=false'])).toEqual(['x=false']);
    expect(featureMismatch("codex 'unclosed", ['x=false'])).toBe(
      'its recorded launch line cannot be read; the profile pins features.x=false on every launch',
    );
  });
});

describe('featureMismatch says what the report commands print', () => {
  test('nothing for a profile that pins nothing', () => {
    expect(featureMismatch('codex -m gpt-6.1-sol', [])).toBeNull();
  });

  test('a missing word names the pin and the relaunch rule', () => {
    expect(featureMismatch('codex -m gpt-6.1-sol', ['x=false'])).toBe(
      'its recorded launch line does not pin features.x=false; the profile pins features.x=false on every launch',
    );
  });

  test('no record says unknown', () => {
    expect(featureMismatch(undefined, ['x=false'])).toBe(
      'its recorded launch line is unknown; the profile pins features.x=false on every launch',
    );
  });

  test('a pinned line is null', () => {
    expect(featureMismatch('codex -c features.x=false', ['x=false'])).toBeNull();
  });
});

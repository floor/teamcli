// Reading a launch line's feature words and comparing them with the profile's pins.
// The CLI reads the last value for a repeated config key, so the reader does too; a bare `--`
// ends option parsing; words for names the profile does not pin are the line's own and never a gap.
import { describe, expect, test } from 'bun:test';
import { featureGaps, featureMismatch, featureSettings, pinnedLine, pinnedWords } from '../src/launch/features.ts';

describe('featureSettings reads -c and --config words', () => {
  test('the last word for a name wins, in either order', () => {
    expect(featureSettings('codex -c features.mcp_oauth_refresh_coordination=true -c features.mcp_oauth_refresh_coordination=false').get('mcp_oauth_refresh_coordination')).toBe(false);
    expect(featureSettings('codex -c features.mcp_oauth_refresh_coordination=false -c features.mcp_oauth_refresh_coordination=true').get('mcp_oauth_refresh_coordination')).toBe(true);
  });

  test('the --config= form is read as one word', () => {
    expect(featureSettings('codex --config=features.x=true').get('x')).toBe(true);
  });

  test('a bare -- ends option parsing', () => {
    expect(featureSettings('codex -- -c features.x=true').size).toBe(0);
  });

  test('non-feature config words are ignored', () => {
    expect(featureSettings('codex -c model_reasoning_effort=high').size).toBe(0);
  });
});

describe('pinnedWords and pinnedLine', () => {
  test('one pair becomes one -c word pair', () => {
    expect(pinnedWords(['x=false', 'y=true'])).toEqual(['-c', 'features.x=false', '-c', 'features.y=true']);
  });

  test('the pins ride after the line as written, and an empty set leaves the line alone', () => {
    expect(pinnedLine('codex -m gpt-6.1-sol', ['x=false'])).toBe('codex -m gpt-6.1-sol -c features.x=false');
    expect(pinnedLine('codex -m gpt-6.1-sol', [])).toBe('codex -m gpt-6.1-sol');
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

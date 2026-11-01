// The model a seat runs, read with a registry record's own provenance: the record's cli and
// launch are what the process was started from, so a team file edited after the launch cannot
// prove what it started. Two branches had no scene: a record that names neither falls back to the
// seat's own launch, and the file's `model_from: launcher` is credited only where the recorded
// launch is a line this reader cannot follow.
import { describe, expect, test } from 'bun:test';
import { recordSignedModel } from '../src/status/statusline.ts';

const SCREEN = ['❯ ', '─'.repeat(40), '  main · …/glow · Opus 5.5 · S: $1.2 · W: 12%', '  ⏵⏵ bypass permissions on', ''].join('\n');

describe('a registry record with no cli and no launch', () => {
  test('falls back to the seat file’s own launch, so a named wrapper still reads its declaration', () => {
    const wrapper = recordSignedModel(
      { cli: 'claude-code', model: 'GLM 5', version: '5.3', launch: 'claude-glm.sh' },
      {},
      SCREEN,
    );
    expect(wrapper).toEqual({ model: 'GLM 5', version: '5.3' });
  });

  test('falls back to the seat file’s own plain launch, and the screen is read', () => {
    const plain = recordSignedModel(
      { cli: 'claude-code', model: 'Opus 5.5', version: '5.5', launch: 'claude' },
      { cli: '', launch: '' },
      SCREEN,
    );
    expect(plain).toEqual({ model: 'Claude Opus', version: '5.5' });
  });
});

describe('the file’s model_from credit', () => {
  const seat = {
    cli: 'claude-code',
    model: 'GLM 5',
    version: '5.3',
    launch: 'unknown-wrapper',
    modelFrom: 'launcher' as const,
  };

  test('stands where the recorded launch explains nothing', () => {
    expect(recordSignedModel(seat, {}, SCREEN)).toEqual({ model: 'GLM 5', version: '5.3' });
  });

  test('does not stand over a recorded launch that starts the CLI itself', () => {
    expect(recordSignedModel(seat, { launch: 'claude' }, SCREEN)).toEqual({ model: 'Claude Opus', version: '5.5' });
  });

  test('does not weaken a recorded launch that names the declared model itself', () => {
    expect(recordSignedModel(seat, { launch: 'claude-glm.sh' }, SCREEN)).toEqual({ model: 'GLM 5', version: '5.3' });
  });
});

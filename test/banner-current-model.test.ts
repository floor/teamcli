// The wrapper's model id is read off the one surface the CLI draws it on: the model line directly
// under the welcome box's version line (`▐▛███▛█ Claude Code v…`, then `▝▜██████▀ <id> · API Usage
// Billing`). A banner-shaped line anywhere else — a quoted example above the header, an older box
// left in the scrollback — is not the current surface, and a pane holding more than one header
// cannot say which conversation is current: it reads nothing. Unread is never a drift.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bannerModel, modelDiffers, signedSeatModel } from '../src/status/statusline.ts';

const screen = (name: string) => readFileSync(join(import.meta.dir, 'fixtures/banner', name), 'utf8');
const capture = (path: string) => readFileSync(join(import.meta.dir, 'fixtures', path), 'utf8');

/** A wrapper seat: Claude Code behind a launcher named for the declared model. */
const GLM = { cli: 'claude-code', model: 'GLM', version: '5.3', launch: '/synthetic/claude-glm' };

describe('the current header surface is the only banner reading', () => {
  test('a captured wrapper pane names its provider id on the model line', () => {
    // The retained wrapper capture draws the measured box with ANSI styling; the id is read off
    // its model line after the styling is stripped.
    expect(bannerModel(capture('exit-typing/claude-code-idle-ansi.txt'))).toBe('deepseek-flash');
    expect(bannerModel(capture('claude-code/2.1.302/idle.txt'))).toBeNull();
  });

  test('the model line directly under the one welcome header names the running model', () => {
    expect(bannerModel(screen('current.txt'))).toBe('glm-5.3');
    const running = signedSeatModel(GLM, screen('current.txt'));
    expect(running).toEqual({ model: 'GLM', version: '5.3' });
    expect(modelDiffers(running, GLM)).toBe(false);
  });

  test('a quoted example above the header is not the current model', () => {
    // The quote names an older version; the header under it is the one the pane draws now, so a
    // seat declaring the quoted version is read against the current model — a real difference,
    // and the current header's, never the quote's.
    expect(bannerModel(screen('quoted.txt'))).toBe('glm-5.3');
    const declared = { ...GLM, version: '5.2' };
    const running = signedSeatModel(declared, screen('quoted.txt'));
    expect(running).toEqual({ model: 'glm', version: '5.3' });
    expect(modelDiffers(running, declared)).toBe(true);
  });

  test('a stale box above the current one is ambiguous and reads nothing', () => {
    expect(bannerModel(screen('stale.txt'))).toBeNull();
    const running = signedSeatModel(GLM, screen('stale.txt'));
    expect(running).toEqual({ model: 'GLM', version: '5.3' });
    expect(modelDiffers(running, GLM)).toBe(false);
  });

  test('prose quoting an id, or naming the version, is not the surface', () => {
    // Two prose lines that quote a banner id, and no welcome box anywhere: the pane says nothing
    // about the model it runs, so the declaration stands and no drift is claimed.
    const quoted = 'Example from an old transcript: glm-5.2 · API Usage Billing\n\nCurrent header: glm-5.3 · API Usage Billing\n';
    expect(bannerModel(quoted)).toBeNull();
    expect(modelDiffers(signedSeatModel(GLM, quoted), GLM)).toBe(false);
    const prose = 'From the transcript, Claude Code v2.1.291 said:\nglm-5.2 · API Usage Billing\n';
    expect(bannerModel(prose)).toBeNull();
  });
});

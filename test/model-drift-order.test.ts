// The RC1 night's live false positive: agy's footer reads `Gemini 4 Argon · medium`, the
// profile splits it into model `Gemini Argon`, version `4`, and the team file wrote the
// vendor's display order, `Gemini 4 Argon`, version `4`. That is one model, not a drift — the
// comparison reads the model's words as a set and the version as its own field, so a reordered
// display is not a difference while a genuinely different model or version still is. The
// capture is the CLI's own frame; nothing here reads a pane.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { modelDiffers, runningModel } from '../src/status/statusline.ts';

const AGY = readFileSync(new URL('./fixtures/antigravity/1.3.5/idle.txt', import.meta.url), 'utf8');
const RUNNING = { model: 'Gemini Argon', version: '4' };

describe('a model name is compared as words, not as one spelling order', () => {
  test('the agy capture and the file display order are the same model', () => {
    expect(runningModel('antigravity', AGY)).toEqual(RUNNING);
    // The file's own spelling: the vendor's display order, the version in its own field.
    expect(modelDiffers(RUNNING, { model: 'Gemini 4 Argon', version: '4' })).toBe(false);
    // The profile's spelling is the same, and so is either casing.
    expect(modelDiffers(RUNNING, { model: 'Gemini Argon', version: '4' })).toBe(false);
    expect(modelDiffers(RUNNING, { model: 'gemini argon', version: '4' })).toBe(false);
    // The version's word inside the model name is not an extra word: both sides carry it once.
    expect(modelDiffers(RUNNING, { model: 'Gemini 4 Argon 4', version: '4' })).toBe(false);
  });

  test('a model word the version field carries is still a model word', () => {
    // The registry's live record: the triple signs model `Gemini`, version `4 Argon` — the
    // profile split the vendor's `Gemini 4 Argon` into model `Gemini Argon`, version `4` — so the
    // version field carries a model word beside its version. The version field is read with the
    // model: its digit is the version, its word a name word, in either order.
    expect(modelDiffers(RUNNING, { model: 'Gemini', version: '4 Argon' })).toBe(false);
    expect(modelDiffers({ model: 'Gemini', version: '4 Argon' }, RUNNING)).toBe(false);
    expect(modelDiffers(RUNNING, { model: 'Gemini', version: 'Argon 4' })).toBe(false);
    expect(modelDiffers({ model: 'Gemini Argon', version: '4 Argon' }, RUNNING)).toBe(false);
    // Another model word in the version field, and another digit, are other models.
    expect(modelDiffers(RUNNING, { model: 'Gemini', version: '4 Flash' })).toBe(true);
    expect(modelDiffers(RUNNING, { model: 'Gemini Argon', version: '5' })).toBe(true);
    expect(modelDiffers(RUNNING, { model: 'Gemini', version: '5 Argon' })).toBe(true);
    expect(modelDiffers({ model: 'Gemini 4 Argon', version: '4' }, { model: 'Gemini 4 Flash', version: '4' })).toBe(true);
  });

  test('a genuinely different model still drifts', () => {
    expect(modelDiffers(RUNNING, { model: 'Gemini Flash', version: '4' })).toBe(true);
    expect(modelDiffers(RUNNING, { model: 'Gemini Pro 4', version: '4' })).toBe(true);
    expect(modelDiffers(RUNNING, { model: 'Gemini Argon 4 Fast', version: '4' })).toBe(true);
    expect(modelDiffers(RUNNING, { model: 'Gemini', version: '4' })).toBe(true);
  });

  test('a genuinely different version still drifts, however the name is ordered', () => {
    expect(modelDiffers(RUNNING, { model: 'Gemini Argon', version: '3.8' })).toBe(true);
    expect(modelDiffers(RUNNING, { model: 'Gemini 3.8 Argon', version: '3.8' })).toBe(true);
    // The version is compared as its own field, not only as a word in the set: swapping the two
    // fields still names another version, so it is a drift.
    expect(modelDiffers(RUNNING, { model: 'Gemini 4', version: 'Argon' })).toBe(true);
  });

  test('a version spelled in another case is the same version', () => {
    const deepseek = { model: 'DeepSeek Flash', version: 'V4.1' };
    expect(modelDiffers(deepseek, { model: 'DeepSeek Flash', version: 'v4.1' })).toBe(false);
    expect(modelDiffers(deepseek, { model: 'DeepSeek Flash', version: 'v4.2' })).toBe(true);
  });

  test('an unread screen is never a difference', () => {
    expect(modelDiffers(null, { model: 'Gemini 4 Argon', version: '4' })).toBe(false);
  });
});

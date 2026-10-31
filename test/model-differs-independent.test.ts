// The live false positive this lane fixes: a Cursor seat's signed record splits the model name
// across two fields — model `Gemini`, version `4 Argon` — while the pane's own status row profile
// reads the same screen as model `Gemini Argon`, version `4`. One model, one version, split in
// two places; the comparison read the version fields verbatim and held every send as a drift.
//
// These scenes are the comparison and one real send on synthetic panes: the split pair must read
// as one model, while a genuinely different family, a genuinely different version and a version
// written apart in another order must keep reading as differences. Nothing here reads a live
// pane or a real CLI home; the screen is written in the scene.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { modelDiffers, runningModel, signedSeatModel } from '../src/status/statusline.ts';
import { recordBody } from './helpers.ts';
import { dropDir, fake, filed, owner, scripted, world, type World } from './send-native-fixtures.ts';

/** The ready screen a Cursor pane draws, synthesized: the chrome above the row, the status row
 *  the profile reads, and the line under it. The reading the profile makes of it is pinned in
 *  the first scene, so a change of profile grammar cannot quietly change the fixture's subject. */
const CURSOR_READY = [
  '  Cursor Agent',
  '  v2026.10.01',
  '',
  '  → Plan, search, build anything',
  '',
  '  Gemini 4 Argon High                  Run Everything',
  '  ~/lobby',
].join('\n');

/** The reading both sides give the live pair: the pane's row, and the record's split signing. */
const RUNNING = { model: 'Gemini Argon', version: '4' };
/** What the seat's registry record signed: the vendor's display order, with the number kept in
 *  the version field and the family word in the model field. */
const SIGNED = { model: 'Gemini', version: '4 Argon' };

describe('a declaration is read as model plus version, not as two fields compared apart', () => {
  test('the live seat: its Cursor row and its split record name one model', () => {
    // Both readings are the product's own: the profile's row reader and the signed-record reader
    // the send's drift check calls, on the same synthetic screen.
    const running = runningModel('cursor', CURSOR_READY);
    expect(running).toEqual(RUNNING);
    const signed = signedSeatModel({ cli: 'cursor', ...SIGNED, launch: 'cursor-agent --model gemini-4-argon-high' }, CURSOR_READY);
    expect(signed).toEqual(RUNNING);
    // The comparison the send makes between them: same words, same version — no drift, either way.
    expect(modelDiffers(running, SIGNED)).toBe(false);
    expect(modelDiffers(SIGNED, RUNNING)).toBe(false);
  });

  test('the same words split another way are still one model', () => {
    // The version word carried twice in the model name is not an extra word.
    expect(modelDiffers({ model: 'Gemini 4 Argon', version: '4' }, SIGNED)).toBe(false);
    // And the split is read in either casing.
    expect(modelDiffers({ model: 'gemini argon', version: '4' }, SIGNED)).toBe(false);
  });

  test('a genuinely different family still drifts', () => {
    expect(modelDiffers(RUNNING, { model: 'Gemini Flash', version: '4' })).toBe(true);
    // The family word missing from the record is a different model too.
    expect(modelDiffers(RUNNING, { model: 'Gemini', version: '4' })).toBe(true);
    // Another variant word is another model, whether it sits in the model field or the version.
    expect(modelDiffers(RUNNING, { model: 'Gemini Argon 4 High', version: '4' })).toBe(true);
    expect(modelDiffers({ model: 'Gemini Flash', version: '4' }, SIGNED)).toBe(true);
  });

  test('a genuinely different version still drifts, split or not', () => {
    expect(modelDiffers(RUNNING, { model: 'Gemini', version: '5 Argon' })).toBe(true);
    expect(modelDiffers({ model: 'Gemini Argon', version: '3.8' }, SIGNED)).toBe(true);
    expect(modelDiffers({ model: 'Gemini', version: '5 Argon' }, RUNNING)).toBe(true);
  });

  test('a version written apart still compares its order', () => {
    // Reading the two fields as one word set must not turn the digits into a set: GLM 3.5 and
    // GLM 5.3 are two versions of the same name, and their order is the difference.
    expect(modelDiffers({ model: 'GLM', version: '3.5' }, { model: 'GLM', version: '5.3' })).toBe(true);
  });

  test('an unread screen is never a difference', () => {
    expect(modelDiffers(null, SIGNED)).toBe(false);
    expect(modelDiffers(null, RUNNING)).toBe(false);
  });
});

describe('a send to a seat whose record splits the version out of the name', () => {
  const PANE = 'fixture-pane-live';
  let cleanup: () => void = () => {};
  afterEach(() => {
    cleanup();
    cleanup = () => {};
  });

  /** The registry record the seat's own launch leaves: the signing is the launcher's split
   *  declaration, and the reach names this fixture's own pane in this fixture's session. */
  function registerLive(made: World, fields: { model: string; version: string; launch?: string }): void {
    registerAgent(made.home, {
      name: 'lead',
      signing: { model: fields.model, version: fields.version, role: 'coordinator' },
      lab: 'test',
      cli: 'cursor',
      launcher: null,
      launch: fields.launch ?? 'cursor-agent --model gemini-4-argon-high',
      reach: { team: teamIdOf(made.root), seat: 'lead', session: 'acme', pane: PANE, address: null },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'up',
    });
  }

  /** The live read and the one pane, its text the screen the scene hands in. */
  function sendHost(made: World) {
    const pane = scripted(['idle', 'working'], CURSOR_READY);
    return { host: fake(made, { agents: () => [{ name: 'lead', pane: PANE }], native: pane }), pane };
  }

  /** The one drop the fixture files for the owner's send. */
  function expectDrop(made: World): void {
    const drops = dropDir(made.dir, 'lead');
    const files = readdirSync(drops).filter((name) => !name.includes('.'));
    expect(files.length).toBe(1);
    expect(recordBody(join(drops, files[0] as string))).toBe(filed('hello'));
  }

  test('the split record is delivered, never held as a drift', async () => {
    const made = world(['typed']);
    cleanup = made.cleanup;
    registerLive(made, SIGNED);
    const { host } = sendHost(made);
    const io = owner(made.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);
    expect(io.err).not.toContain('model drift');
    expectDrop(made);
  });

  test('a genuinely different family on the same pane is still held', async () => {
    const made = world(['typed']);
    cleanup = made.cleanup;
    registerLive(made, { model: 'Gemini Flash', version: '4' });
    const { host } = sendHost(made);
    const io = owner(made.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(1);
    expect(io.err).toContain('model drift: Gemini Flash 4 vs Gemini Argon 4');
    expect(existsSync(dropDir(made.dir, 'lead'))).toBe(false);
  });

  test('the same family with its version in the model field is delivered', async () => {
    // The fixture's own control: this record is already read as the pane's model at the base, so
    // a delivered send here shows the walk behind the drift check is the one these scenes use.
    const made = world(['typed']);
    cleanup = made.cleanup;
    registerLive(made, RUNNING);
    const { host } = sendHost(made);
    const io = owner(made.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);
    expect(io.err).not.toContain('model drift');
    expectDrop(made);
  });
});

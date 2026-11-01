// What a wrapper seat's declaration means against the provider id on its banner, where the
// model's own name already carries the version: `Kimi K2.5` + `2.5`, `Kimi` + `K2.5`,
// `GLM 5.3` + `5.3`, `DeepSeek V4.1` + `V4.1`, and `GLM 2B` + `2.5`, whose capacity shares a
// digit with the version but is not it. The declaration is one name-and-version string, so the
// banner's spelling of the same model confirms it — while another version, another order, or
// another number is a drift the send must hold. Every pane here is synthetic.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { recordBody } from './helpers.ts';
import { dropDir, fake, filed, owner, scripted, world, type World } from './send-native-fixtures.ts';

const LEAD_PANE = 'fixture-pane-lead';

const claudeScreen = (model: string) =>
  `❯ \n${'─'.repeat(40)}\n  main · …/acme · ${model} · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on\n`;
const banner = (id: string) => `  ${id} · API Usage Billing\n`;

type Signing = { model: string; version: string };

describe('a wrapper declaration whose model carries its version', () => {
  let cleanup: () => void = () => {};
  afterEach(() => {
    cleanup();
    cleanup = () => {};
  });

  /** The lead's registry record: the launcher's declared model and version, and the launch the
   *  running pane was started from. */
  function registerLead(made: World, signing: Signing, launch: string): void {
    registerAgent(made.home, {
      name: 'lead',
      signing: { ...signing, role: 'coordinator' },
      lab: 'test',
      cli: 'claude-code',
      launcher: null,
      launch,
      reach: { team: teamIdOf(made.root), seat: 'lead', session: 'acme', pane: LEAD_PANE, address: null },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'the test',
    });
  }

  /** The live read and the one pane, its text the screen the scene hands in. */
  function sendHost(made: World, screen: string) {
    const pane = scripted(['idle', 'working'], screen);
    const host = fake(made, { agents: () => [{ name: 'lead', pane: LEAD_PANE }], native: pane });
    return { host, pane };
  }

  /** The one drop the fixture files for the owner's send. */
  function expectDrop(made: World): void {
    const drops = dropDir(made.dir, 'lead');
    const files = readdirSync(drops).filter((name) => !name.includes('.'));
    expect(files.length).toBe(1);
    expect(recordBody(join(drops, files[0] as string))).toBe(filed('hello'));
  }

  /** A banner id naming the declared model: the send walks its leg and files the drop. */
  async function expectDelivered(signing: Signing, launch: string, bannerId: string): Promise<void> {
    const made = world(['typed']);
    registerLead(made, signing, launch);
    const { host } = sendHost(made, claudeScreen('Opus 4.6') + banner(bannerId));
    const io = owner(made.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);
    expect(io.err).not.toContain('model drift');
    expectDrop(made);
    made.cleanup();
  }

  /** Another version of the same family: the send is held, and nothing is filed or typed. */
  async function expectHeld(signing: Signing, launch: string, bannerId: string): Promise<void> {
    const made = world(['typed']);
    registerLead(made, signing, launch);
    const { host, pane } = sendHost(made, claudeScreen('Opus 4.6') + banner(bannerId));
    const io = owner(made.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(1);
    expect(io.err).toContain(`model drift: ${signing.model} ${signing.version} vs`);
    expect(pane.enters).toBe(0);
    expect(existsSync(dropDir(made.dir, 'lead'))).toBe(false);
    made.cleanup();
  }

  // The declaration writes the version twice — inside the model's name and in the version field
  // — and the banner writes it once. It is still the same model.
  test('a Kimi declaration keeping the version in its model name matches its banner id', async () => {
    await expectDelivered({ model: 'Kimi K2.5', version: '2.5' }, 'claude-kimi.sh', 'kimi-k2.5');
  });

  // The control: the alphanumeric version family as the version field names it.
  test('a Kimi declaration whose version is the family matches the same banner id', async () => {
    await expectDelivered({ model: 'Kimi', version: 'K2.5' }, 'claude-kimi.sh', 'kimi-k2.5');
  });

  test('a GLM declaration repeating its version matches its banner id', async () => {
    await expectDelivered({ model: 'GLM 5.3', version: '5.3' }, 'claude-glm.sh', 'glm-5.3');
  });

  test('a DeepSeek declaration repeating its version matches its banner id', async () => {
    await expectDelivered({ model: 'DeepSeek V4.1', version: 'V4.1' }, 'claude-deepseek.sh', 'deepseek-v4.1');
  });

  // A model token keeps its own digits: `GLM 2B` and version `2.5` share the digit 2, but `2B`
  // is the model's capacity, not the version written twice, so the banner spells both.
  test('a declaration whose model keeps its own digits matches its banner id', async () => {
    await expectDelivered({ model: 'GLM 2B', version: '2.5' }, 'claude-glm.sh', 'glm-2b-2.5');
  });

  // The banner that drops the capacity's digit names another model, though it spells the
  // version the same way: the model the declaration names is not the one the banner shows.
  test('a banner dropping the model token’s own digit is still a drift', async () => {
    await expectHeld({ model: 'GLM 2B', version: '2.5' }, 'claude-glm.sh', 'glm-b-2.5');
  });

  // Another version is never the same model, however close the number looks: k25 is not k2.5.
  test('a Kimi version written as k25 against K2.5 is still a drift', async () => {
    await expectHeld({ model: 'Kimi K2.5', version: '2.5' }, 'claude-kimi.sh', 'kimi-k25');
  });

  test('the next Kimi version is still a drift', async () => {
    await expectHeld({ model: 'Kimi K2.5', version: '2.5' }, 'claude-kimi.sh', 'kimi-k2.6');
  });

  // The round-3 reorderings, on the repeated-version declaration: order is kept.
  test('a GLM version written in another order is still a drift', async () => {
    await expectHeld({ model: 'GLM 5.3', version: '5.3' }, 'claude-glm.sh', 'glm-3.5');
  });

  test('a later GLM version is still a drift', async () => {
    await expectHeld({ model: 'GLM 5.3', version: '5.3' }, 'claude-glm.sh', 'glm-5.4');
  });

  test('a DeepSeek version written in another order is still a drift', async () => {
    await expectHeld({ model: 'DeepSeek Flash', version: 'V4.1' }, 'claude-deepseek.sh', 'deepseek-v1.4-flash');
  });
});

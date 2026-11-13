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
import { recordBody, wrapperPane } from './helpers.ts';
import { dropDir, fake, filed, owner, scripted, world, type World } from './send-native-fixtures.ts';

const LEAD_PANE = 'fixture-pane-lead';

const claudeScreen = (model: string) =>
  `❯ \n${'─'.repeat(40)}\n  main · …/acme · ${model} · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on\n`;

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
    const { host } = sendHost(made, wrapperPane(bannerId) + claudeScreen('Opus 4.6'));
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
    const { host, pane } = sendHost(made, wrapperPane(bannerId) + claudeScreen('Opus 4.6'));
    const io = owner(made.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(1);
    expect(io.err).toContain(`model drift: ${signing.model} ${signing.version} vs`);
    expect(pane.enters).toBe(0);
    expect(existsSync(dropDir(made.dir, 'lead'))).toBe(false);
    made.cleanup();
  }
});

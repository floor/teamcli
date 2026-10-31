import { describe, expect, test } from 'bun:test';
import { codexEndpointConfig, remoteCodexCommand } from '../src/launch/plan.ts';
import { profileFor } from '../src/profiles/index.ts';
import { launchCommand, resumeCarry } from '../src/profiles/profile.ts';

const codex = profileFor('codex')!;

describe('explicit unattended options keep their complete values', () => {
  test.each([
    '-a on-request -s workspace-write',
    '--ask-for-approval on-request --sandbox workspace-write',
    '--ask-for-approval=on-request --sandbox=workspace-write',
    '-a on-request --sandbox=workspace-write',
    '--ask-for-approval=on-request -s workspace-write',
    '-a=on-request -s=workspace-write',
    `-a 'on-request' --sandbox="workspace-write"`,
  ])('Codex preserves %s without stray profile values', (permissions) => {
    const line = `codex -m gpt-6.1-sol ${permissions} -c model_reasoning_effort=high`;
    expect(launchCommand(codex, line, 'Rules.')).toBe(`AGENT_UNATTENDED=1 ${line} --no-alt-screen`);
  });

  test.each([
    ['-a on-request', '-s danger-full-access --no-alt-screen'],
    ['--ask-for-approval=on-request', '-s danger-full-access --no-alt-screen'],
    ['-s workspace-write', '-a never --no-alt-screen'],
    ['--sandbox=workspace-write', '-a never --no-alt-screen'],
  ])('only the missing option is defaulted beside %s', (permissions, defaults) => {
    const line = `codex ${permissions}`;
    expect(launchCommand(codex, line, 'Rules.')).toBe(`AGENT_UNATTENDED=1 ${line} ${defaults}`);
  });

  test('a line without permission flags receives both defaults even when a value appears elsewhere', () => {
    expect(launchCommand(codex, 'codex -m gpt-6.1-sol', 'Rules.')).toBe(
      'AGENT_UNATTENDED=1 codex -m gpt-6.1-sol -a never -s danger-full-access --no-alt-screen',
    );
    expect(launchCommand(codex, 'codex --profile never', 'Rules.')).toBe(
      'AGENT_UNATTENDED=1 codex --profile never -a never -s danger-full-access --no-alt-screen',
    );
  });

  test('quoted config text does not count as a permission option', () => {
    const line = `codex -c 'probe_note="use -a on-request --sandbox workspace-write"'`;
    expect(launchCommand(codex, line, 'Rules.')).toBe(
      `AGENT_UNATTENDED=1 ${line} -a never -s danger-full-access --no-alt-screen`,
    );
  });

  test.each([
    ['cursor', 'cursor-agent --sandbox enabled', '--force'],
    ['cursor', 'cursor-agent --sandbox=enabled --force', ''],
    ['gemini', 'gemini --approval-mode default', ''],
    ['gemini', 'gemini --approval-mode=default', ''],
  ])('%s also keeps its explicit option value', (cli, line, defaults) => {
    expect(launchCommand(profileFor(cli)!, line, 'Rules.')).toBe(
      `AGENT_UNATTENDED=1 ${line}${defaults === '' ? '' : ` ${defaults}`}`,
    );
  });

  test('a resume keeps its thread and explicit permissions through the managed endpoint path', () => {
    const carried = resumeCarry('codex', 'codex -m gpt-6.1-sol -a on-request -s workspace-write', 'ses_recorded');
    if (carried.kind !== 'line') throw new Error(carried.why);
    const command = launchCommand(codex, carried.line, 'Rules.');
    expect(command).toBe('AGENT_UNATTENDED=1 codex -m gpt-6.1-sol -a on-request -s workspace-write resume ses_recorded --no-alt-screen');
    expect(codexEndpointConfig(command)).toEqual([
      '-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"',
    ]);
    expect(remoteCodexCommand(command)).toBe(
      'AGENT_UNATTENDED=1 codex -m gpt-6.1-sol resume ses_recorded --no-alt-screen',
    );
  });
});

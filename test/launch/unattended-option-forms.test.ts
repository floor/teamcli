// A launch line's own permission options and the profile's unattended defaults. A default is
// added as one complete option — its flag and its value — so a line that already carries the
// option keeps its own value and suppresses the whole default, while a line without it still
// receives the pair. These scenes cover the short, long, equals and attached short spellings,
// quoting, the `--` terminator, the other profiles, the codex daemon policy and the resume path.
import { describe, expect, test } from 'bun:test';
import { codexEndpointConfig, remoteCodexCommand } from '../../src/launch/plan.ts';
import { profileFor } from '../../src/profiles/index.ts';
import { launchCommand, resumeCarry } from '../../src/profiles/profile.ts';

const codex = profileFor('codex')!;
const cursor = profileFor('cursor')!;
const gemini = profileFor('gemini')!;

const launched = (profile: ReturnType<typeof profileFor>, line: string): string =>
  launchCommand(profile!, line, 'RULES.');

describe('an explicit Codex permission option keeps its value and suppresses the default', () => {
  test('short equals form with the default values', () => {
    expect(launched(codex, 'codex -a=never -s=danger-full-access')).toBe(
      'AGENT_UNATTENDED=1 codex -a=never -s=danger-full-access --no-alt-screen',
    );
  });

  test('long equals form with explicit values', () => {
    expect(launched(codex, 'codex --ask-for-approval=on-request --sandbox=workspace-write')).toBe(
      'AGENT_UNATTENDED=1 codex --ask-for-approval=on-request --sandbox=workspace-write --no-alt-screen',
    );
  });

  test('long space-separated form with explicit values', () => {
    expect(launched(codex, 'codex --ask-for-approval on-request --sandbox workspace-write')).toBe(
      'AGENT_UNATTENDED=1 codex --ask-for-approval on-request --sandbox workspace-write --no-alt-screen',
    );
  });

  test('the short flag suppresses a default written in its long alias and the reverse', () => {
    expect(launched(codex, 'codex -a on-request')).toBe(
      'AGENT_UNATTENDED=1 codex -a on-request -s danger-full-access --no-alt-screen',
    );
    expect(launched(codex, 'codex --sandbox=workspace-write')).toBe(
      'AGENT_UNATTENDED=1 codex --sandbox=workspace-write -a never --no-alt-screen',
    );
  });

  test('explicit default values are not repeated as bare words', () => {
    expect(launched(codex, 'codex -a never -s danger-full-access')).toBe(
      'AGENT_UNATTENDED=1 codex -a never -s danger-full-access --no-alt-screen',
    );
  });

  test('an explicit --no-alt-screen suppresses only that default', () => {
    expect(launched(codex, 'codex --no-alt-screen')).toBe(
      'AGENT_UNATTENDED=1 codex --no-alt-screen -a never -s danger-full-access',
    );
  });
});

describe('an attached short value is the same permission option', () => {
  // Measured on codex-cli 0.161.0: `codex -abogus --version` exits 2 with "invalid value
  // 'bogus' for '--ask-for-approval <APPROVAL_POLICY>'", and `codex -aon-request
  // -sworkspace-write completion bash` exits 0 — the attached short value is the flag's own
  // value, not an unknown word.
  test('both attached shorts suppress both default pairs', () => {
    expect(launched(codex, 'codex -aon-request -sworkspace-write')).toBe(
      'AGENT_UNATTENDED=1 codex -aon-request -sworkspace-write --no-alt-screen',
    );
  });

  test('one attached short suppresses only its own default', () => {
    expect(launched(codex, 'codex -aon-request')).toBe(
      'AGENT_UNATTENDED=1 codex -aon-request -s danger-full-access --no-alt-screen',
    );
    expect(launched(codex, 'codex -sworkspace-write')).toBe(
      'AGENT_UNATTENDED=1 codex -sworkspace-write -a never --no-alt-screen',
    );
  });

  test('a quoted prompt naming an attached short does not suppress the default', () => {
    expect(launched(codex, 'codex "use -aon-request"')).toBe(
      'AGENT_UNATTENDED=1 codex "use -aon-request" -a never -s danger-full-access --no-alt-screen',
    );
  });
});

describe('a line without permission flags receives the complete defaults', () => {
  test('no flags at all', () => {
    expect(launched(codex, 'codex -m gpt-6.1-sol')).toBe(
      'AGENT_UNATTENDED=1 codex -m gpt-6.1-sol -a never -s danger-full-access --no-alt-screen',
    );
  });

  test('an unrelated argument equal to a default value does not remove it', () => {
    expect(launched(codex, 'codex -m never')).toBe(
      'AGENT_UNATTENDED=1 codex -m never -a never -s danger-full-access --no-alt-screen',
    );
  });

  test('a quoted prompt that names the flags is not read as one', () => {
    expect(launched(codex, 'codex "write -a never -s danger-full-access to the file"')).toBe(
      'AGENT_UNATTENDED=1 codex "write -a never -s danger-full-access to the file" -a never -s danger-full-access --no-alt-screen',
    );
  });

  test('an argument after -- is positional and does not suppress defaults', () => {
    expect(launched(codex, 'codex -- -a on-request')).toBe(
      'AGENT_UNATTENDED=1 codex -- -a on-request -a never -s danger-full-access --no-alt-screen',
    );
  });
});

describe('the codex daemon policy lands beside the permission options', () => {
  test('daemon off inserts --no-daemon before a default --no-alt-screen', () => {
    expect(launchCommand(codex, 'codex -m gpt-6.1-sol', 'RULES.', undefined, undefined, undefined, { codexDaemon: 'off' })).toBe(
      'AGENT_UNATTENDED=1 codex -m gpt-6.1-sol -a never -s danger-full-access --no-daemon --no-alt-screen',
    );
  });

  test('daemon off with every option explicit adds only --no-daemon', () => {
    expect(launchCommand(codex, 'codex -a on-request -s workspace-write --no-alt-screen', 'RULES.', undefined, undefined, undefined, { codexDaemon: 'off' })).toBe(
      'AGENT_UNATTENDED=1 codex -a on-request -s workspace-write --no-alt-screen --no-daemon',
    );
  });
});

describe('other profiles pair each default flag with its own value', () => {
  test('cursor keeps an explicit --sandbox value and adds only --force', () => {
    expect(launched(cursor, 'cursor-agent --sandbox=enabled')).toBe(
      'AGENT_UNATTENDED=1 cursor-agent --sandbox=enabled --force',
    );
  });

  test('cursor keeps an explicit --force and adds the --sandbox pair', () => {
    expect(launched(cursor, 'cursor-agent --force')).toBe(
      'AGENT_UNATTENDED=1 cursor-agent --force --sandbox disabled',
    );
  });

  test('cursor with both explicit adds nothing', () => {
    expect(launched(cursor, 'cursor-agent --force --sandbox enabled')).toBe(
      'AGENT_UNATTENDED=1 cursor-agent --force --sandbox enabled',
    );
  });

  test('gemini keeps an explicit --approval-mode value', () => {
    expect(launched(gemini, 'gemini --approval-mode=auto')).toBe(
      'AGENT_UNATTENDED=1 gemini --approval-mode=auto',
    );
  });

  test('gemini without the flag receives the pair', () => {
    expect(launched(gemini, 'gemini -m gemini-4')).toBe(
      'AGENT_UNATTENDED=1 gemini -m gemini-4 --approval-mode yolo',
    );
  });
});

describe('the resume path keeps one set of permission values', () => {
  const resumed = (line: string): string => {
    const carried = resumeCarry('codex', line, 'ses_abc');
    if (carried.kind !== 'line') throw new Error(carried.why);
    return launched(codex, carried.line);
  };

  test('a resume of an explicit long-form line keeps its values and gains only --no-alt-screen', () => {
    const command = resumed('codex -m gpt-6.1-sol --ask-for-approval on-request --sandbox workspace-write');
    expect(command).toBe(
      'AGENT_UNATTENDED=1 codex -m gpt-6.1-sol --ask-for-approval on-request --sandbox workspace-write resume ses_abc --no-alt-screen',
    );
    expect(codexEndpointConfig(command)).toEqual([
      '-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"',
    ]);
    expect(remoteCodexCommand(command)).toBe(
      'AGENT_UNATTENDED=1 codex -m gpt-6.1-sol resume ses_abc --no-alt-screen',
    );
  });

  test('an attached short value reaches the endpoint and sheds from the remote line', () => {
    const command = resumed('codex -m gpt-6.1-sol -aon-request -sworkspace-write');
    expect(command).toBe(
      'AGENT_UNATTENDED=1 codex -m gpt-6.1-sol -aon-request -sworkspace-write resume ses_abc --no-alt-screen',
    );
    expect(codexEndpointConfig(command)).toEqual([
      '-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"',
    ]);
    expect(remoteCodexCommand(command)).toBe(
      'AGENT_UNATTENDED=1 codex -m gpt-6.1-sol resume ses_abc --no-alt-screen',
    );
  });

  test('a short equals value reaches the endpoint too', () => {
    const command = 'AGENT_UNATTENDED=1 codex -m gpt-6.1-sol -a=on-request -s=workspace-write resume ses_abc --no-alt-screen';
    expect(codexEndpointConfig(command)).toEqual([
      '-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"',
    ]);
    expect(remoteCodexCommand(command)).toBe(
      'AGENT_UNATTENDED=1 codex -m gpt-6.1-sol resume ses_abc --no-alt-screen',
    );
  });

  test('a resume of a line without permission flags gains exactly one default pair', () => {
    const command = resumed('codex -m gpt-6.1-sol');
    expect(command).toBe(
      'AGENT_UNATTENDED=1 codex -m gpt-6.1-sol resume ses_abc -a never -s danger-full-access --no-alt-screen',
    );
    expect(codexEndpointConfig(command)).toEqual([
      '-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"',
    ]);
    expect(remoteCodexCommand(command)).toBe(
      'AGENT_UNATTENDED=1 codex -m gpt-6.1-sol resume ses_abc --no-alt-screen',
    );
  });

  test('a resume of a line that already records the session is left whole', () => {
    const carried = resumeCarry('codex', 'codex -m gpt-6.1-sol resume ses_abc', 'ses_abc');
    expect(carried.kind).toBe('line');
    expect(launched(codex, (carried as { line: string }).line)).toBe(
      'AGENT_UNATTENDED=1 codex -m gpt-6.1-sol resume ses_abc -a never -s danger-full-access --no-alt-screen',
    );
  });
});

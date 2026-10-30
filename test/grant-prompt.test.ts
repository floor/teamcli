import { describe, expect, test } from 'bun:test';
import { grantExpiry, grantPromptText, GRANT_PROMPT_MAX } from '../src/client/grant-prompt.ts';
import { msg } from '../src/client/grant-messages.ts';

describe('the grant prompt', () => {
  test('the default bundle (recorded developer) names the team, up/down and abandon, seats, send targets, signer and local time', () => {
    const text = grantPromptText({ client: 'grok-bot', team: 'floor', ops: ['status', 'list', 'up', 'down', 'add', 'remove', 'send'], sendSeats: ['orchestrator', 'iris'], bundle: 'developer', expires: '2027-01-26T07:22:00.000Z', signer: 'mac' }, 'Europe/Paris');
    expect(text).toBe('Allow Grok Bot (client grok-bot) on team floor, default bundle: start/stop (up/down, abandon), manage seats, send to orchestrator and iris. Signer: mac. Expires 26 Jan 2027 08:22 (Europe/Paris).');
    expect(text.length).toBeLessThanOrEqual(GRANT_PROMPT_MAX);
  });

  test('a short grant keeps the client id, and a plain down grant does not abandon', () => {
    const text = grantPromptText({ client: 'grok-bot', team: 'floor', ops: ['up', 'down'], bundle: null, expires: '2027-01-26T07:22:00.000Z', signer: 'mac' }, 'Europe/Paris');
    expect(text).toBe('Allow Grok Bot (client grok-bot) on team floor: start/stop (up/down). Signer: mac. Expires 26 Jan 2027 08:22 (Europe/Paris).');
  });

  test('many send seats are counted instead of listed to stay under the prompt budget', () => {
    const seats = Array.from({ length: 18 }, (_, i) => `reviewer-seat-${i}`);
    const text = grantPromptText({ client: 'grok-bot', team: 'floor', ops: ['up', 'down', 'send'], sendSeats: seats, bundle: 'developer', expires: '2027-01-26T07:22:00.000Z', signer: 'mac' }, 'Europe/Paris');
    expect(text).toContain('send to 18 seats');
    expect(text).toContain('(up/down');
    expect(text.length).toBeLessThanOrEqual(GRANT_PROMPT_MAX);
  });

  test('expiry reads in local time with its zone, or says it has no end', () => {
    expect(grantExpiry('2027-07-01T10:00:00.000Z', 'Europe/Paris')).toBe('1 Jul 2027 12:00 (Europe/Paris)');
    expect(grantExpiry(null)).toBe('no end date (until revoked)');
  });

  test('the catalog fills placeholders and leaves unknown ones', () => {
    expect(msg('prompt.deny', { prompt: 'x' })).toBe('Deny: x');
    expect(msg('page.already_registered')).toBe('This Mac is already registered; nothing to do.');
  });
});

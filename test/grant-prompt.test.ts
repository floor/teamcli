import { describe, expect, test } from 'bun:test';
import { frenchExpiry, frenchGrantPrompt, GRANT_PROMPT_MAX } from '../src/client/grant-prompt-fr.ts';

describe('the French grant prompt', () => {
  test('a developer bundle names the team, up/down, seats, send targets, signer and Paris time', () => {
    const text = frenchGrantPrompt({ client: 'grok-bot', team: 'floor', ops: ['status', 'list', 'up', 'down', 'add', 'remove', 'send'], sendSeats: ['orchestrator', 'iris'], bundle: 'developer', expires: '2027-01-26T07:22:00.000Z', signer: 'mac' }, 'Europe/Paris');
    expect(text).toBe("Autoriser Grok Bot sur l'équipe floor — bundle Developer : démarrer/arrêter (up/down), gérer les sièges, envoyer à orchestrator et iris. Signataire : mac. Expire le 26 janv. 2027 à 08:22 (heure de Paris).");
    expect(text.length).toBeLessThanOrEqual(GRANT_PROMPT_MAX);
  });

  test('a short grant keeps the client id', () => {
    const text = frenchGrantPrompt({ client: 'grok-bot', team: 'floor', ops: ['up', 'down'], bundle: null, expires: '2027-01-26T07:22:00.000Z', signer: 'mac' }, 'Europe/Paris');
    expect(text).toBe("Autoriser Grok Bot (client grok-bot) sur l'équipe floor : démarrer/arrêter (up/down). Signataire : mac. Expire le 26 janv. 2027 à 08:22 (heure de Paris).");
  });

  test('many send seats are counted instead of listed to stay under the prompt budget', () => {
    const seats = Array.from({ length: 18 }, (_, i) => `reviewer-seat-${i}`);
    const text = frenchGrantPrompt({ client: 'grok-bot', team: 'floor', ops: ['up', 'down', 'send'], sendSeats: seats, bundle: 'developer', expires: '2027-01-26T07:22:00.000Z', signer: 'mac' }, 'Europe/Paris');
    expect(text).toContain('envoyer à 18 sièges');
    expect(text).toContain('(up/down)');
    expect(text.length).toBeLessThanOrEqual(GRANT_PROMPT_MAX);
  });

  test('expiry reads in local time with its zone, or says it has no end', () => {
    expect(frenchExpiry('2027-07-01T10:00:00.000Z', 'Europe/Paris')).toBe('le 1 juil. 2027 à 12:00 (heure de Paris)');
    expect(frenchExpiry(null)).toBe("sans date de fin (jusqu'à révocation)");
  });
});

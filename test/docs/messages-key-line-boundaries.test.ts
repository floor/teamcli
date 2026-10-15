// The message-key paragraph on the internal messages note, held to the page and to the two
// halves of the claim it makes. The note stopped naming `team approve` — the command this build
// does not ship — and now says nothing else creates the key: creation lives under the signing
// entry point alone, while the reader the mailbox uses creates nothing. The sentence is pinned
// verbatim, the dead command pinned gone from the page and from the CLI's own registry, and
// each half of "nothing else creates it" pinned to the line in `keys.ts` that carries it.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// Whitespace runs collapse before the match, so the sentences survive line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

const MESSAGES_PAGE = '../../docs/internal/messages.md';
const KEYS_SRC = '../../src/store/keys.ts';
const CLI_SRC = '../../src/cli.ts';

describe("the messages note's message-key paragraph", () => {
  test('the rewritten paragraph, verbatim', () => {
    expect(prose(MESSAGES_PAGE)).toContain(
      'The message key is a second file, `~/.config/team-key/messages.json`, beside the approval key. It is created the first time a message or a receipt is signed; nothing else creates it, and an empty mailbox creates nothing. The approval key never signs a message.',
    );
  });

  test('the command the note stopped naming is gone, from the page and the registry', () => {
    // The old sentence handed the claim to a command this build no longer ships; the page may
    // not name it, and the CLI's own command table may not carry it.
    expect(prose(MESSAGES_PAGE)).not.toContain('team approve');
    expect(prose(CLI_SRC)).not.toContain('approve');
    // The registry the usage prints from — every command this build ships is a row here.
    expect(prose(CLI_SRC)).toContain(
      'export const commands: Record<string, () => Promise<{ default: Command; USAGE: string }>> = {',
    );
  });

  test('creation is the signing path alone', () => {
    const src = prose(KEYS_SRC);
    // The note's "the first time a message or a receipt is signed": the signing entry point's
    // own words, with the reader it points at for verification-only callers. Each fragment is
    // contiguous within one doc line, so the comment's own ` * ` markers stay out of the match.
    expect(src).toContain('The message key, an Ed25519 pair in `messages.json` beside the approval key.');
    expect(src).toContain('first time a message or a receipt is signed. A reader that only verifies uses');
    expect(src).toContain('`messageKeyState` and does not call this. An unreadable file is never replaced.');
    // And the file's own law, said once above the pair: the message key is written by the
    // signer, never by the approval key's reader and never by a read that does not sign.
    expect(src).toContain('(`messageKeyOf`), never by `keyOf` and never by a read that does not sign.');
    // "Nothing else creates it" as a count: the installer — the only path that makes the
    // folder and the file — is defined once and called from the signer alone.
    expect(src.split('installMessageKey(').length - 1).toBe(2);
    expect(src).toContain("if (installMessageKey(home, stored) === 'installed') return createPrivateKey(stored.private);");
  });

  test('the reader the mailbox runs creates nothing', () => {
    const src = prose(KEYS_SRC);
    // The note's "an empty mailbox creates nothing": the reader's own comment, its read-only
    // body — one read, no write — pinned so a mailbox run cannot grow a creation path.
    expect(src).toContain(
      '/** The message key as a file, creating nothing. `missing` when `messages.json` is not there yet. */',
    );
    expect(src).toContain('export function messageKeyState(home: string = homedir()): KeyState');
    expect(src).toContain("return readKeyFile(messageKeyPath(home), 'message key');");
  });
});

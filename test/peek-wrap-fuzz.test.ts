import { describe, expect, test } from 'bun:test';
import { KEY_PREFIXES, maskSecretRows } from '../src/file/secrets.ts';

/**
 * A wrapped credential must not survive the screen. These screens are rendered by a seeded
 * generator, so every case is deterministic and a failure names its own rows; the explicit
 * scenes above the fuzz are the shapes an independent tester reproduced against the fix before
 * the wrap rules were completed.
 */

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function permutationSlice(rng: () => number, pool: string, length: number): string {
  const chars = [...pool];
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    const held = chars[index] ?? '';
    chars[index] = chars[swap] ?? '';
    chars[swap] = held;
  }
  let out = '';
  for (let index = 0; index < length; index += 1) out += chars[index % chars.length] ?? '';
  return out;
}

const ORDINARY = ['done', 'ok', 'note', 'result.', '[done', '(ok', 'next'];
const TOKEN_BODY_POOL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_+=-';
const BASE64_POOL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const HEX_POOL = '0123456789abcdef';
const URL_POOL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_~';
const HEADERS = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  '-----BEGIN RSA PRIVATE KEY-----',
  '-----BEGIN PRIVATE KEY-----',
  '-----BEGIN EC PRIVATE KEY-----',
  '-----END OPENSSH PRIVATE KEY-----',
  '-----END RSA PRIVATE KEY-----',
  '-----END PRIVATE KEY-----',
  // A screen can carry a tab where a header has a space, and a wrap can fall anywhere else:
  // the marker is read across the join, whitespace-insensitively.
  '-----BEGIN\tOPENSSH PRIVATE KEY-----',
  '-----BEGIN RSA\tPRIVATE KEY-----',
  '-----BEGIN\tEC PRIVATE\tKEY-----',
  '-----END\tOPENSSH PRIVATE KEY-----',
  '-----END RSA\tPRIVATE\tKEY-----',
];

/** The word a base64 credential is written in, ending in `=` padding as a real one can. */
const paddedWord = 'Q7vLq2LmN4pR7sT1uV3wY6aB8cD0eF2gH5jK9mN=';

describe('the shapes an independent tester reproduced', () => {
  test('a prefixless base64 word ending in = is masked on both rows: one padding space', () => {
    const rows = ['done', `${paddedWord.slice(0, 20)} `, paddedWord.slice(20)];
    // The ordinary row the reading also touched may be masked too (the safe error); the
    // credential's own rows must be masked whole, the trailing `=` padding included.
    expect(maskSecretRows(rows).slice(1).map((row) => row.trim())).toEqual(['[masked]', '[masked]']);
  });

  test('a prefixless base64 word ending in = is masked on both rows: four padding spaces', () => {
    const rows = ['done', `${paddedWord.slice(0, 20)}    `, paddedWord.slice(20)];
    expect(maskSecretRows(rows).slice(1).map((row) => row.trim())).toEqual(['[masked]', '[masked]']);
  });

  test('a prefixless base64 word ending in = is masked over three padded rows', () => {
    const rows = [
      'done',
      `${paddedWord.slice(0, 12)}  `,
      `${paddedWord.slice(12, 28)}  `,
      `${paddedWord.slice(28)}  `,
    ];
    expect(maskSecretRows(rows).slice(1).map((row) => row.trim()))
      .toEqual(['[masked]', '[masked]', '[masked]']);
  });

  test('an OPENSSH private-key header over two rows masks both rows', () => {
    expect(maskSecretRows(['-----BEGIN ', 'OPENSSH PRIVATE KEY-----'])).toEqual(['[masked]', '[masked]']);
  });

  test('an EC private-key header over three rows masks every row', () => {
    expect(maskSecretRows(['-----BEGIN ', 'EC PRIVATE ', 'KEY-----'])).toEqual(['[masked]', '[masked]', '[masked]']);
  });
});

describe('seeded fuzz of wrapped credentials', () => {
  test('the printed screen never holds the secret or a twelve-character slice of it', () => {
    const rng = mulberry32(0x51ce_1234);
    const failures: Array<{ case: number; kind: string; rows: string[]; printed: string[]; secret: string }> = [];

    for (let index = 0; index < 3000; index += 1) {
      const kind = ['token', 'base64', 'hex', 'userinfo', 'header'][index % 5] as
        | 'token'
        | 'base64'
        | 'hex'
        | 'userinfo'
        | 'header';
      const ordinary = ORDINARY[Math.floor(rng() * ORDINARY.length)] ?? 'done';
      let secret: string;
      let text: string;
      let secretStart: number;

      if (kind === 'token') {
        const prefix = KEY_PREFIXES[index % KEY_PREFIXES.length] ?? 'ghp_';
        secret = `${prefix}${permutationSlice(rng, TOKEN_BODY_POOL, 20 + Math.floor(rng() * 21))}`;
        text = `${ordinary}${secret}`;
        secretStart = ordinary.length;
      } else if (kind === 'base64') {
        const padding = rng() < 0.15 ? (rng() < 0.5 ? '=' : '==') : '';
        secret = `${permutationSlice(rng, BASE64_POOL, 40 + Math.floor(rng() * 21))}${padding}`;
        text = `${ordinary}${secret}`;
        secretStart = ordinary.length;
      } else if (kind === 'hex') {
        secret = permutationSlice(rng, HEX_POOL, 40 + Math.floor(rng() * 25));
        text = `${ordinary}${secret}`;
        secretStart = ordinary.length;
      } else if (kind === 'userinfo') {
        const password = permutationSlice(rng, URL_POOL, 16 + Math.floor(rng() * 17));
        secret = password;
        const user = 'https://alice:';
        text = `${ordinary}${user}${password}@example.test/x`;
        secretStart = ordinary.length + user.length;
      } else {
        secret = HEADERS[Math.floor(rng() * HEADERS.length)] ?? HEADERS[0] ?? '';
        text = `${ordinary}${secret}`;
        secretStart = ordinary.length;
      }

      // A row start and a row end are boundaries the screen cannot tell from a line break, and a
      // terminal's padding is not part of the reading. The ordinary word is the row before the
      // credential (a break forced at its end), and the credential takes random wrap points: one
      // to three cuts inside it, so its row widths are random too.
      const cuts: number[] = [secretStart];
      const length = text.length - secretStart;
      const cutCount = 1 + Math.floor(rng() * 3);
      const inside = new Set<number>();
      while (inside.size < cutCount) inside.add(1 + Math.floor(rng() * (length - 1)));
      for (const cut of [...inside].sort((a, b) => a - b)) cuts.push(secretStart + cut);
      const boundaries = [...new Set(cuts)].filter((cut) => cut > 0 && cut < text.length).sort((a, b) => a - b);
      const rows: string[] = [];
      let rowStart = 0;
      for (const boundary of boundaries) {
        rows.push(text.slice(rowStart, boundary));
        rowStart = boundary;
      }
      rows.push(text.slice(rowStart));
      const padded = rows.map((row) => row + ' '.repeat(Math.floor(rng() * 81)));

      const printed = maskSecretRows(padded);
      const joined = printed.join('').replace(/\s+/g, '');
      const bare = secret.replace(/\s+/g, '');
      const slices: string[] = [];
      for (let at = 0; at + 12 <= bare.length; at += 1) slices.push(bare.slice(at, at + 12));
      const leaked = joined.includes(bare) || slices.some((slice) => joined.includes(slice));
      if (printed.length !== padded.length || leaked) failures.push({ case: index, kind, rows: padded, printed, secret });
    }

    expect(failures).toEqual([]);
  });
});

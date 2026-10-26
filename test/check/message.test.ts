import { describe, expect, test } from 'bun:test';
import { forbiddenPatterns } from '../../src/check/config.ts';
import { DEFAULT_FORBIDDEN } from '../../src/file/signature.ts';
import type { Position } from '../../src/file/types.ts';
import { checkSignature, findForbidden, splitLines, withoutPublicationTrailer } from '../../src/check/message.ts';
import { render, renderings, shape } from '../../src/check/signature.ts';
import { config, OPUS, PR_SIGNATURE, SIGNATURE, SOL } from './fixtures.ts';

const ledger = [OPUS, SOL];
const kinds = (findings: { kind: string }[]) => findings.map((finding) => finding.kind);

describe('render', () => {
  test('fills display and role', () => {
    expect(render('Agent: {display} · {role}', OPUS)).toBe(SIGNATURE);
  });

  test('fills model and version, and keeps the vendor spelling apart', () => {
    expect(render('By {model} {version} ({role})', SOL)).toBe('By GPT Sol 6 (reviewer)');
    expect(render('Agent: {display} · {role}', SOL)).toBe('Agent: GPT-6 Sol · reviewer');
  });

  test('renders one line per seat', () => {
    expect(renderings('Agent: {display} · {role}', ledger)).toEqual(
      new Set([SIGNATURE, 'Agent: GPT-6 Sol · reviewer']),
    );
  });

  test('the shape matches the form whatever the values, and escapes the fixed words', () => {
    const form = shape('**Agent:** {display} · {role}');
    expect(form.test('**Agent:** Anything 9 · tester')).toBe(true);
    expect(form.test('Agent: Anything 9 · tester')).toBe(false);
    expect(form.test('**Agent:** no separator')).toBe(false);
  });
});

describe('forbidden patterns', () => {
  test('the defaults always apply, and the file adds to them', () => {
    const sources = forbiddenPatterns(config({ forbidden: ['^Secret:'] })).map((pattern) => pattern.source);
    expect(sources).toEqual([...DEFAULT_FORBIDDEN, '^Secret:', '\\bWEB-[0-9]+\\b']);
  });

  test('a default listed again by the file counts once', () => {
    const patterns = forbiddenPatterns(config({ forbidden: [...DEFAULT_FORBIDDEN], forbiddenPublic: [] }));
    expect(patterns).toHaveLength(DEFAULT_FORBIDDEN.length);
  });

  test('the public patterns apply only to a public project', () => {
    const sources = forbiddenPatterns(config({ public: false })).map((pattern) => pattern.source);
    expect(sources).toEqual([...DEFAULT_FORBIDDEN]);
  });

  test('a pattern that is no regular expression is refused by name', () => {
    expect(() => forbiddenPatterns(config({ forbidden: ['('] }))).toThrow('forbidden pattern "("');
  });

  test('each default is matched per line, with its line number', () => {
    const patterns = forbiddenPatterns(config());
    const lines = splitLines(
      'subject\n\nClaude-Session: abc\nsee https://claude.ai/code/session_01 here\nnot a Claude-Session: line\nWEB-12 done',
    );
    expect(findForbidden(lines, patterns).map((finding) => [finding.line, finding.message])).toEqual([
      [3, 'forbidden pattern ^Claude-Session:'],
      [4, 'forbidden pattern https?://claude\\.ai/code/session'],
      [6, 'forbidden pattern \\bWEB-[0-9]+\\b'],
    ]);
  });
});

describe('a commit signature', () => {
  const rule = { template: 'Agent: {display} · {role}', position: 'trailer' as Position };
  const signed = (message: string, trailers: string[], position: Position = 'trailer') =>
    checkSignature({ lines: splitLines(message), rule: { ...rule, position }, ledger, trailers });

  test('passes in the trailer block, with another trailer after it', () => {
    expect(
      signed(`s\n\nbody\n\n${SIGNATURE}\nCo-authored-by: A <a@b.c>`, [SIGNATURE, 'Co-authored-by: A <a@b.c>']),
    ).toEqual([]);
  });

  test('passes with trailing spaces', () => {
    expect(signed(`s\n\n${SIGNATURE}  `, [`${SIGNATURE}  `])).toEqual([]);
  });

  test('prose in the signature paragraph is named as that case', () => {
    const findings = signed(`s\n\nRefs #3\n${SIGNATURE}`, []);
    expect(kinds(findings)).toEqual(['signature-in-prose']);
    expect(findings[0]?.message).toContain('"Refs #3"');
    expect(findings[0]?.line).toBe(4);
  });

  test('a signature above the last paragraph is misplaced', () => {
    const findings = signed(`s\n\n${SIGNATURE}\n\nFixes: #11`, ['Fixes: #11']);
    expect(kinds(findings)).toEqual(['signature-misplaced']);
    expect(findings[0]?.line).toBe(3);
  });

  test('a message without one is missing it', () => {
    expect(kinds(signed('s\n\nbody', []))).toEqual(['signature-missing']);
  });

  test('a signature without the version is of no seat', () => {
    const line = 'Agent: Claude Opus · implementer';
    const findings = signed(`s\n\n${line}`, [line]);
    expect(kinds(findings)).toEqual(['signature-unknown']);
    expect(findings[0]?.text).toBe(line);
  });

  test('a model and role no seat pairs is of no seat', () => {
    const line = 'Agent: Claude Opus 5.5 · reviewer';
    expect(kinds(signed(`s\n\n${line}`, [line]))).toEqual(['signature-unknown']);
  });

  test('a signature with words after it is of no seat', () => {
    const line = `${SIGNATURE} (draft)`;
    expect(kinds(signed(`s\n\n${line}`, [line]))).toEqual(['signature-unknown']);
  });

  test('last-line takes the last non-empty line only', () => {
    expect(signed(`s\n\n${SIGNATURE}\n\n`, [], 'last-line')).toEqual([]);
    expect(kinds(signed(`s\n\n${SIGNATURE}\nCo-authored-by: A <a@b.c>`, [], 'last-line'))).toEqual([
      'signature-misplaced',
    ]);
  });

  test('trailing spaces are trimmed at every position', () => {
    expect(signed(`s\n\n${SIGNATURE} \t`, [], 'last-line')).toEqual([]);
    expect(signed(`s\n\n${SIGNATURE}  \n\nmore prose`, [], 'anywhere')).toEqual([]);
    expect(kinds(signed(`s\n\n  ${SIGNATURE}`, [], 'anywhere'))).toEqual(['signature-missing']);
  });

  test('anywhere takes any whole line', () => {
    expect(signed(`s\n\n${SIGNATURE}\n\nmore prose`, [], 'anywhere')).toEqual([]);
    expect(kinds(signed(`s\n\nsigned ${SIGNATURE}`, [], 'anywhere'))).toEqual(['signature-missing']);
  });
});

describe('a pull request signature', () => {
  const rule = { template: '**Agent:** {display} · {role}', position: 'last-line' as Position };
  const signed = (body: string, position: Position = 'last-line') =>
    checkSignature({ lines: splitLines(body), rule: { ...rule, position }, ledger });

  test('passes on the last line, CRLF and a final newline included', () => {
    expect(signed(`## Summary\r\n\r\ntext\r\n\r\n${PR_SIGNATURE}\r\n`)).toEqual([]);
  });

  test('passes with trailing spaces, at the last line and in the last paragraph', () => {
    expect(signed(`text\n\n${PR_SIGNATURE}  `)).toEqual([]);
    expect(signed(`text\n\n${PR_SIGNATURE}  \nRefs #3`, 'trailer')).toEqual([]);
  });

  test('the commit form is not the pull request form', () => {
    expect(kinds(signed(`text\n\n${SIGNATURE}`))).toEqual(['signature-missing']);
  });

  test('not last is misplaced', () => {
    expect(kinds(signed(`${PR_SIGNATURE}\n\ntext`))).toEqual(['signature-misplaced']);
  });

  test('trailer means the last paragraph', () => {
    expect(signed(`text\n\n${PR_SIGNATURE}\nRefs #3\n`, 'trailer')).toEqual([]);
    const findings = signed(`${PR_SIGNATURE}\n\ntext`, 'trailer');
    expect(kinds(findings)).toEqual(['signature-misplaced']);
    expect(findings[0]?.message).toBe('the signature is not in the last paragraph');
  });

  test('an empty body is missing it', () => {
    expect(kinds(signed(''))).toEqual(['signature-missing']);
  });
});

const FOOTER_DIV = '<div><img src="https://cursor.com/assets/images/open-in-web-dark.png"><img src="https://cursor.com/assets/images/open-in-cursor-dark.png"></div>';

describe('a Cursor publication trailer', () => {
  const trailer = `\n\n<!-- CURSOR_AGENT_PR_BODY_END -->\n\n${FOOTER_DIV}\n`;

  test('drops the end marker and the open-in div, and nothing else', () => {
    expect(withoutPublicationTrailer(`The page is ready.\n\n${PR_SIGNATURE}${trailer}`))
      .toBe(`The page is ready.\n\n${PR_SIGNATURE}`);
  });

  test('leaves a body that does not end with that div', () => {
    const body = `text\n\n${PR_SIGNATURE}\n`;
    expect(withoutPublicationTrailer(body)).toBe(body);
  });

  test('leaves prose after the div, and prose between the signature and the marker', () => {
    const after = `text\n\n${PR_SIGNATURE}${trailer}\nmore prose\n`;
    expect(withoutPublicationTrailer(after)).toBe(after);
    const between = `text\n\n${PR_SIGNATURE}\n\nmore prose${trailer}`;
    expect(withoutPublicationTrailer(between)).toBe(`text\n\n${PR_SIGNATURE}\n\nmore prose`);
  });

  test('leaves a last div that is not the publication line', () => {
    const body = `text\n\n<div>notes</div>\n`;
    expect(withoutPublicationTrailer(body)).toBe(body);
  });
});

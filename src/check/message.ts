import type { ForbiddenPattern, SeatIdentity, SignatureRule } from './config.ts';
import { renderings, shape } from './signature.ts';

export type FindingKind =
  'forbidden' | 'signature-missing' | 'signature-misplaced' | 'signature-in-prose' | 'signature-unknown';

export interface Finding {
  kind: FindingKind;
  message: string;
  /** 1-based line of the commit message or PR body, when the finding has one. */
  line?: number;
  /** The offending line. */
  text?: string;
}

/** The text's lines, trailing spaces trimmed. */
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trimEnd());
}

const PUBLICATION_END = '<!-- CURSOR_AGENT_PR_BODY_END -->';

/** Cursor's open-in-web / open-in-cursor line, the one div a cloud-agent update appends. */
function isPublicationDiv(line: string): boolean {
  const text = line.trim();
  return text.startsWith('<div>') && text.endsWith('</div>')
    && text.includes('cursor.com/assets/images/open-in-web')
    && text.includes('cursor.com/assets/images/open-in-cursor');
}

/**
 * The author's text when `body` ends with Cursor's publication trailer: the end
 * marker, then that one div. Blank lines around them do not count. Any other
 * trailing line is left in place, so the signature still has to be the last
 * line the author wrote.
 */
export function withoutPublicationTrailer(body: string): string {
  const lines = body.split(/\r?\n/);
  let end = lines.length;
  const dropBlanks = (): void => {
    while (end > 0 && (lines[end - 1] ?? '').trim() === '') end--;
  };
  dropBlanks();
  if (end === 0 || !isPublicationDiv(lines[end - 1] ?? '')) return body;
  end--;
  dropBlanks();
  if (end === 0 || lines[end - 1]?.trim() !== PUBLICATION_END) return body;
  end--;
  dropBlanks();
  return lines.slice(0, end).join('\n');
}

/** Every line that matches a forbidden pattern. */
export function findForbidden(lines: readonly string[], patterns: readonly ForbiddenPattern[]): Finding[] {
  const findings: Finding[] = [];
  lines.forEach((text, index) => {
    for (const pattern of patterns) {
      if (pattern.regex.test(text)) {
        findings.push({
          kind: 'forbidden',
          message: `forbidden pattern ${pattern.source}`,
          line: index + 1,
          text,
        });
      }
    }
  });
  return findings;
}

/** The indexes of the last run of non-empty lines: [start, end). */
function lastParagraph(lines: readonly string[]): [number, number] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === '') end--;
  let start = end;
  while (start > 0 && lines[start - 1] !== '') start--;
  return [start, end];
}

const TRAILER_LINE = /^[A-Za-z0-9-]+\s*:\s*\S/;

const WHERE: Record<SignatureRule['position'], { commit: string; pr: string }> = {
  'last-line': { commit: 'the last line', pr: 'the last line' },
  trailer: { commit: 'the final trailer block', pr: 'the last paragraph' },
  anywhere: { commit: 'a line of its own', pr: 'a line of its own' },
};

export interface SignatureInput {
  lines: readonly string[];
  rule: SignatureRule;
  ledger: readonly SeatIdentity[];
  /**
   * For a commit: the lines of the final trailer block as git reads it, empty
   * when git sees none. Absent for a PR body, where `trailer` means the last
   * paragraph.
   */
  trailers?: readonly string[];
}

/** Empty when the text carries a signature of the team's at the position the rule says. */
export function checkSignature(input: SignatureInput): Finding[] {
  const { lines, rule, ledger, trailers } = input;
  const accepted = renderings(rule.template, ledger);
  const [start, end] = lastParagraph(lines);
  const where = WHERE[rule.position][trailers ? 'commit' : 'pr'];

  let candidates: readonly string[];
  if (rule.position === 'last-line') candidates = lines.slice(Math.max(end - 1, 0), end);
  else if (rule.position === 'anywhere') candidates = lines;
  else candidates = trailers ? trailers.map((line) => line.trimEnd()) : lines.slice(start, end);

  if (candidates.some((line) => accepted.has(line))) return [];

  const signed = lines.findIndex((line) => accepted.has(line));
  if (signed !== -1) {
    const text = lines[signed] as string;
    const inLastParagraph = signed >= start && signed < end;
    if (trailers && rule.position === 'trailer' && inLastParagraph) {
      const prose = lines.slice(start, end).filter((line) => !TRAILER_LINE.test(line));
      if (prose.length > 0) {
        return [
          {
            kind: 'signature-in-prose',
            message:
              `the signature shares its paragraph with prose (${prose.map((line) => JSON.stringify(line)).join(', ')}), ` +
              'so git reads no trailer block: put it in a paragraph of its own, with trailers only',
            line: signed + 1,
            text,
          },
        ];
      }
    }
    return [
      {
        kind: 'signature-misplaced',
        message: `the signature is not in ${where}`,
        line: signed + 1,
        text,
      },
    ];
  }

  const form = shape(rule.template);
  const unknown: Finding[] = [];
  lines.forEach((text, index) => {
    if (form.test(text)) {
      unknown.push({
        kind: 'signature-unknown',
        message:
          'a signature no seat of this team has had (the model, the version and the role must all match one seat)',
        line: index + 1,
        text,
      });
    }
  });
  if (unknown.length > 0) return unknown;

  return [
    {
      kind: 'signature-missing',
      message: `no signature: expected ${JSON.stringify(rule.template)} in ${where}`,
    },
  ];
}

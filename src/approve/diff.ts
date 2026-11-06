/** One line of a comparison: kept, taken out of the old text, or added by the new one. */
export type DiffLine = { kind: 'same' | 'removed' | 'added'; text: string; line: number };

/**
 * The lines of `after` against `before`, by their longest common subsequence.
 * `line` is the line's number in the text it comes from.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // lengths[i][j]: the longest common subsequence of a[i..] and b[j..].
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      (lengths[i] as number[])[j] =
        a[i] === b[j]
          ? ((lengths[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lengths[i + 1] as number[])[j] as number, (lengths[i] as number[])[j + 1] as number);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: b[j] as string, line: j + 1 });
      i++;
      j++;
    } else if (((lengths[i + 1] as number[])[j] as number) >= ((lengths[i] as number[])[j + 1] as number)) {
      out.push({ kind: 'removed', text: a[i] as string, line: i + 1 });
      i++;
    } else {
      out.push({ kind: 'added', text: b[j] as string, line: j + 1 });
      j++;
    }
  }
  for (; i < a.length; i++) out.push({ kind: 'removed', text: a[i] as string, line: i + 1 });
  for (; j < b.length; j++) out.push({ kind: 'added', text: b[j] as string, line: j + 1 });
  return out;
}

/** The changed lines only, in the unified diff's own spelling — `-old` and `+new`, the mark
 *  against the line's own indentation, nothing else — and empty when the texts are equal. The
 *  diff is read beside the approved copy it names; a line number between the mark and the text
 *  would be a number in one of the two files, not in the change. */
export function formatDiff(before: string, after: string): string[] {
  return diffLines(before, after)
    .filter((line) => line.kind !== 'same')
    .map((line) => `${line.kind === 'removed' ? '-' : '+'}${line.text}`);
}

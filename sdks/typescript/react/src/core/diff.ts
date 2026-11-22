export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string } | { kind: 'gap'; count: number };

/** Past this many lines a side, the diff is not computed: both sides are shown whole. */
const MAX_LINES = 400;
/** Unchanged lines kept around each change. */
const CONTEXT = 2;

/** A line diff of `before` and `after`, with long unchanged runs folded into gaps. Null when too long. */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before.length ? before.split('\n') : [];
  const b = after.length ? after.split('\n') : [];
  if (a.length > MAX_LINES || b.length > MAX_LINES) return null;

  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines: Array<{ kind: 'same' | 'add' | 'del'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push({ kind: 'del', text: a[i++] });
    } else {
      lines.push({ kind: 'add', text: b[j++] });
    }
  }
  while (i < a.length) lines.push({ kind: 'del', text: a[i++] });
  while (j < b.length) lines.push({ kind: 'add', text: b[j++] });

  const near = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(lines.length - 1, index + CONTEXT); k++) near[k] = true;
  });
  const out: DiffLine[] = [];
  let folded = 0;
  lines.forEach((line, index) => {
    if (line.kind !== 'same' || near[index]) {
      if (folded) out.push({ kind: 'gap', count: folded });
      folded = 0;
      out.push(line);
    } else {
      folded++;
    }
  });
  if (folded) out.push({ kind: 'gap', count: folded });
  return out;
}

import { usageError } from './errors';

/**
 * Cursors are opaque to the user. Today the API pages by offset (or by `before`
 * for policy versions); wrapping that in a cursor lets the server move to real
 * cursors later without changing the CLI contract. A cursor is bound to the list
 * that issued it, so pasting one into another command is refused rather than
 * silently paging something else.
 */
interface CursorState {
  /** Which list issued it, e.g. "runs.list". */
  l: string;
  /** Offset into the list. */
  o?: number;
  /** Policy versions: return versions older than this one. */
  b?: number;
}

export function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined, list: string): CursorState | undefined {
  if (cursor === undefined) return undefined;
  let state: unknown;
  try {
    state = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw usageError('--cursor is not a cursor issued by this CLI.');
  }
  const s = state as Partial<CursorState>;
  if (!s || typeof s !== 'object' || typeof s.l !== 'string') throw usageError('--cursor is not a cursor issued by this CLI.');
  if (s.l !== list) throw usageError(`--cursor was issued by \`${s.l.replace('.', ' ')}\`, not \`${list.replace('.', ' ')}\`.`);
  if (s.o !== undefined && !(Number.isInteger(s.o) && s.o >= 0)) throw usageError('--cursor is malformed.');
  if (s.b !== undefined && !(Number.isInteger(s.b) && s.b >= 0)) throw usageError('--cursor is malformed.');
  return s as CursorState;
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
  total?: number;
}

/** Page an offset-paginated response. */
export function offsetPage<T>(
  list: string,
  data: T[] | undefined,
  offset: number,
  pagination: { hasMore?: boolean; total?: number } | undefined,
): Page<T> {
  const items = data ?? [];
  const hasMore = pagination?.hasMore ?? false;
  return {
    data: items,
    nextCursor: hasMore && items.length > 0 ? encodeCursor({ l: list, o: offset + items.length }) : null,
    ...(typeof pagination?.total === 'number' ? { total: pagination.total } : {}),
  };
}

/** Page a list the server returns whole (e.g. actions): same contract, sliced locally. */
export function localPage<T>(list: string, all: T[] | undefined, offset: number, limit: number): Page<T> {
  const items = all ?? [];
  const data = items.slice(offset, offset + limit);
  const next = offset + data.length;
  return { data, nextCursor: next < items.length ? encodeCursor({ l: list, o: next }) : null, total: items.length };
}

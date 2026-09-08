import type { BlockAnchor } from '../domain/types.js';
export function ingestHealth(head: BlockAnchor, cursor: BlockAnchor | null, gap = false) {
  return {
    head: head.number,
    cursor: cursor?.number ?? null,
    headLagBlocks: cursor ? (head.number > cursor.number ? head.number - cursor.number : 0n) : null,
    headLagSeconds: cursor ? Math.max(0, head.timestampSec - cursor.timestampSec) : null,
    coverage: gap ? ('gap' as const) : cursor ? ('complete' as const) : ('warming' as const),
    finality: 'provisional' as const,
  };
}

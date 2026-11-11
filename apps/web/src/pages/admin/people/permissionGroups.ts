/**
 * The permission lists of the role sheets and the member's override sheet,
 * grouped by the key's first segment (`run.purchase` → `run`). Review
 * ADM1-13: each sheet grouped them itself, and the role sheets ordered the
 * groups by that segment while the override sheet ordered them by the
 * name the reader sees.
 */
export function groupPermissions<P extends { key: string }>(
  perms: readonly P[],
  groupName: (segment: string) => string,
  locale: string,
): Array<[segment: string, perms: P[]]> {
  const bySegment = new Map<string, P[]>();
  for (const p of perms) {
    const segment = p.key.split('.')[0] || 'misc';
    const list = bySegment.get(segment);
    if (list) list.push(p);
    else bySegment.set(segment, [p]);
  }
  return [...bySegment.entries()].sort((a, b) =>
    groupName(a[0]).localeCompare(groupName(b[0]), locale),
  );
}

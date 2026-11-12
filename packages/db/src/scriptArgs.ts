/**
 * `--org <slug>` (or `--org=<slug>`): the organisation an operator script
 * works on. Review DB-20 (2026-11-12): the catalog scripts took the one
 * with the slug 'default', which in production is one customer's
 * workspace. There is no default any more; null when it is not given.
 */
export function orgSlugArg(args: readonly string[]): string | null {
  const at = args.indexOf('--org');
  const value =
    at >= 0 ? args[at + 1] : args.find((arg) => arg.startsWith('--org='))?.slice('--org='.length);
  const slug = value?.trim();
  return slug && !slug.startsWith('-') ? slug : null;
}

/** orgSlugArg, else `usage` on stderr and exit code 2 (before any connection opens). */
export function requireOrgSlug(args: readonly string[], usage: string): string {
  const slug = orgSlugArg(args);
  if (slug) return slug;
  console.error(usage);
  process.exit(2);
}

/**
 * UX-24 (2026-11-14): the question asked before an invite by Telegram ID
 * adds a role to someone already in the workspace: "Leo Park is already a
 * member" / "Add Store staff at Central?". The invite used to add them
 * and say so only afterwards.
 */
import type { CatalogKey } from '@compass/i18n';

export interface Phrase {
  key: CatalogKey;
  params: Record<string, string>;
}

export function existingMemberPrompt(o: {
  /** Their name, when the inviter may see it (memberInvitePreview). */
  displayName: string | null;
  roleName: string;
  /** An org-tier role is bound organisation-wide, not in the stores. */
  orgWide: boolean;
  storeNames: readonly string[];
  /** The language's list separator (common.listSeparator). */
  separator: string;
}): { title: Phrase; body: Phrase } {
  const name = o.displayName?.trim();
  const title: Phrase = name
    ? { key: 'admin.invite.existing.title', params: { name } }
    : { key: 'admin.invite.existing.titleNoName', params: {} };
  const body: Phrase =
    o.orgWide || o.storeNames.length === 0
      ? { key: 'admin.invite.existing.bodyOrgWide', params: { role: o.roleName } }
      : {
          key: 'admin.invite.existing.body',
          params: { role: o.roleName, store: o.storeNames.join(o.separator) },
        };
  return { title, body };
}

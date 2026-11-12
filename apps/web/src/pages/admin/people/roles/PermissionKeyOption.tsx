import { Checkbox } from '@compass/ui';
import { useRoleLabels } from '../../../../hooks/useI18n';

/**
 * One permission in a role's key list (create and edit). Walkthrough F13
 * (2026-11-05): the plain-language name first, as on the role page; the
 * key under it, small. ADM1-07: a key the actor may not put in the role
 * is disabled, with the reason under it. The kit's Checkbox (ADM1-13: two
 * hand-written copies of this row), as a row of PermissionGroupList.
 */
export function PermissionKeyOption({
  perm,
  checked,
  blocked,
  onToggle,
}: {
  perm: { key: string; description: string | null };
  checked: boolean;
  /** Why it cannot be ticked, or null. */
  blocked: string | null;
  onToggle: () => void;
}) {
  const roleText = useRoleLabels();
  return (
    <Checkbox
      checked={checked}
      disabled={blocked !== null}
      onChange={onToggle}
      label={roleText.permission(perm.key, perm.description)}
      hint={
        <>
          <span className="block font-mono text-old-tiny">{perm.key}</span>
          {blocked ? <span className="block">{blocked}</span> : null}
        </>
      }
    />
  );
}

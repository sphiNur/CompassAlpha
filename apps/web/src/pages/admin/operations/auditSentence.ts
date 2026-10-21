/**
 * Admin audit row → readable sentence (2026-10-21 FE-08 / F6-02).
 *
 * The audit list used to print `action.split('.')` — raw English verb +
 * object and an 8-char id prefix — and every two-segment key
 * (`admin.memberAssignStore`, `admin.orgFinanceUpdate`, …) rendered the
 * verb as "?". Here each known action maps to an i18n template filled
 * with the names the server now resolves (`labels`); unknown actions fall
 * back to a generic "actor: object · verb" line that understands both
 * `admin.object.verb` and two-segment camelCase keys.
 *
 * Pure: the caller passes the localizers, so this is unit-testable.
 */

export type AuditCategory = 'people' | 'roles' | 'stores' | 'catalog' | 'other';
export type AuditTone = 'success' | 'danger' | 'muted';

export interface AuditRowLike {
  action: string;
  inputs?: unknown;
  actor: { displayName: string | null } | null;
  labels?: {
    memberName: string | null;
    roleName: string | null;
    storeName: string | null;
    toStoreName: string | null;
    targetName: string | null;
    targetNames: Record<string, string> | null;
  } | null;
}

export type AuditSentenceKey =
  | 'ops.audit.s.catalogArchive'
  | 'ops.audit.s.catalogCreate'
  | 'ops.audit.s.catalogRestore'
  | 'ops.audit.s.catalogUpdate'
  | 'ops.audit.s.financeUpdate'
  | 'ops.audit.s.generic'
  | 'ops.audit.s.inviteByTgId'
  | 'ops.audit.s.inviteCreate'
  | 'ops.audit.s.inviteRevoke'
  | 'ops.audit.s.memberReactivate'
  | 'ops.audit.s.memberRemove'
  | 'ops.audit.s.memberRename'
  | 'ops.audit.s.memberSuspend'
  | 'ops.audit.s.permissionAllow'
  | 'ops.audit.s.permissionDeny'
  | 'ops.audit.s.permissionRevoke'
  | 'ops.audit.s.roleCreate'
  | 'ops.audit.s.roleDelete'
  | 'ops.audit.s.roleGrant'
  | 'ops.audit.s.roleRevoke'
  | 'ops.audit.s.roleUpdate'
  | 'ops.audit.s.storeArchive'
  | 'ops.audit.s.storeAssign'
  | 'ops.audit.s.storeCloneRoles'
  | 'ops.audit.s.storeCreate'
  | 'ops.audit.s.storeDetach'
  | 'ops.audit.s.storeTransfer'
  | 'ops.audit.s.storeUnassign'
  | 'ops.audit.s.storeUpdate'
  | 'ops.audit.s.subscriptionUpdate';

export interface AuditSentence {
  category: AuditCategory;
  /** Parsed object word (e.g. `sku`) — drives the per-kind badge. */
  object: string;
  tone: AuditTone;
  /** i18n template key (see the ops.audit.s.* keys). */
  key: AuditSentenceKey;
  params: Record<string, string>;
}

/** Two-segment server keys that don't follow `admin.object.verb`. */
const TWO_SEGMENT: Record<string, { object: string; verb: string }> = {
  memberAssignStore: { object: 'member', verb: 'assignStore' },
  memberUnassignStore: { object: 'member', verb: 'unassignStore' },
  memberDetachFromStore: { object: 'member', verb: 'detachFromStore' },
  memberTransferStore: { object: 'member', verb: 'transferStore' },
  memberInviteCreate: { object: 'memberInvite', verb: 'create' },
  memberInviteRevoke: { object: 'memberInvite', verb: 'revoke' },
  memberInviteByTgId: { object: 'member', verb: 'inviteByTgId' },
  orgFinanceUpdate: { object: 'orgFinance', verb: 'update' },
};

export function parseAuditAction(action: string): { object: string; verb: string } {
  const parts = action.split('.');
  if (parts.length >= 3) {
    return { object: parts[1]!, verb: parts.slice(2).join('.') };
  }
  if (parts.length === 2) {
    const key = parts[1]!;
    const known = TWO_SEGMENT[key];
    if (known) return known;
    // Unknown camelCase key: the last capitalised word is the verb
    // ("fooBarUpdate" → fooBar / update).
    const m = /^(.*?[a-z0-9])([A-Z][a-z0-9]*)$/.exec(key);
    if (m) return { object: m[1]!, verb: m[2]!.toLowerCase() };
    return { object: key, verb: '' };
  }
  return { object: action, verb: '' };
}

const CATALOG_OBJECTS = new Set(['sku', 'category', 'supplier', 'expenseTemplate', 'dish']);

export function auditCategory(action: string): AuditCategory {
  const { object, verb } = parseAuditAction(action);
  if (object === 'role' || object === 'memberPermission') return 'roles';
  if (object === 'store' && verb === 'cloneRoles') return 'roles';
  if (object === 'member' || object === 'memberInvite') {
    return verb.endsWith('Store') ? 'stores' : 'people';
  }
  if (object === 'store') return 'stores';
  if (CATALOG_OBJECTS.has(object)) return 'catalog';
  return 'other';
}

function toneOf(verb: string, inputs: Record<string, unknown>): AuditTone {
  if (['delete', 'deny', 'revoke', 'remove', 'unassignStore', 'detachFromStore'].includes(verb)) {
    return 'danger';
  }
  if (verb === 'setStatus') return inputs.status === 'suspended' ? 'danger' : 'success';
  if (verb === 'update' && inputs.isArchived === true) return 'danger';
  if (['create', 'grant', 'allow', 'assignStore', 'inviteByTgId'].includes(verb)) return 'success';
  return 'muted';
}

export function describeAuditRow(
  row: AuditRowLike,
  loc: {
    /** Placeholder for a name that could not be resolved. */
    unknown: string;
    /** Localizes an i18n names map (SKU / category). */
    localName: (names: Record<string, string>) => string;
  },
): AuditSentence {
  const { object, verb } = parseAuditAction(row.action);
  const inputs =
    row.inputs && typeof row.inputs === 'object' ? (row.inputs as Record<string, unknown>) : {};
  const l = row.labels ?? null;
  const or = (v: string | null | undefined) => (v && v.trim() ? v : loc.unknown);
  const actor = or(row.actor?.displayName);
  const member = or(
    l?.memberName ?? (typeof inputs.displayName === 'string' ? inputs.displayName : null),
  );
  const role = or(l?.roleName ?? (typeof inputs.roleSlug === 'string' ? inputs.roleSlug : null));
  const store = or(l?.storeName);
  const category = auditCategory(row.action);
  const tone = toneOf(verb, inputs);
  const out = (key: AuditSentenceKey, params: Record<string, string> = {}): AuditSentence => ({
    category,
    object,
    tone,
    key,
    params: { actor, ...params },
  });

  switch (`${object}.${verb}`) {
    case 'role.grant':
      return out('ops.audit.s.roleGrant', { member, role });
    case 'role.revoke':
      return out('ops.audit.s.roleRevoke', { member, role });
    case 'role.create':
      return out('ops.audit.s.roleCreate', {
        role: or(l?.roleName ?? (typeof inputs.name === 'string' ? inputs.name : null)),
      });
    case 'role.update':
      return out('ops.audit.s.roleUpdate', { role });
    case 'role.delete':
      return out('ops.audit.s.roleDelete', { role });
    case 'memberPermission.allow':
    case 'memberPermission.deny':
    case 'memberPermission.revoke': {
      const permission = or(typeof inputs.permissionKey === 'string' ? inputs.permissionKey : null);
      const key =
        verb === 'allow'
          ? 'ops.audit.s.permissionAllow'
          : verb === 'deny'
            ? 'ops.audit.s.permissionDeny'
            : 'ops.audit.s.permissionRevoke';
      return out(key, { member, permission });
    }
    case 'memberInvite.create':
      return out('ops.audit.s.inviteCreate');
    case 'memberInvite.revoke':
      return out('ops.audit.s.inviteRevoke');
    case 'member.inviteByTgId':
      return out('ops.audit.s.inviteByTgId', { member });
    case 'member.remove':
      return out('ops.audit.s.memberRemove', { member });
    case 'member.setStatus':
      return out(
        inputs.status === 'suspended'
          ? 'ops.audit.s.memberSuspend'
          : 'ops.audit.s.memberReactivate',
        { member },
      );
    case 'member.setDisplayName':
      return out('ops.audit.s.memberRename', {
        name: or(typeof inputs.displayName === 'string' ? inputs.displayName : l?.memberName),
      });
    case 'member.assignStore':
      return out('ops.audit.s.storeAssign', { member, store });
    case 'member.unassignStore':
      return out('ops.audit.s.storeUnassign', { member, store });
    case 'member.detachFromStore':
      return out('ops.audit.s.storeDetach', { member, store });
    case 'member.transferStore':
      return out('ops.audit.s.storeTransfer', { member, from: store, to: or(l?.toStoreName) });
    case 'store.create':
      return out('ops.audit.s.storeCreate', {
        store: or(l?.storeName ?? (typeof inputs.name === 'string' ? inputs.name : null)),
      });
    case 'store.update':
      return out('ops.audit.s.storeUpdate', { store });
    case 'store.delete':
      return out('ops.audit.s.storeArchive', { store });
    case 'store.cloneRoles':
      return out('ops.audit.s.storeCloneRoles', { store });
    case 'orgFinance.update':
      return out('ops.audit.s.financeUpdate');
    case 'subscription.update':
      return out('ops.audit.s.subscriptionUpdate');
  }

  if (category === 'catalog' && (verb === 'create' || verb === 'update' || verb === 'delete')) {
    const fromInputs =
      typeof inputs.name === 'string'
        ? inputs.name
        : typeof inputs.label === 'string'
          ? inputs.label
          : inputs.names && typeof inputs.names === 'object'
            ? loc.localName(inputs.names as Record<string, string>)
            : null;
    const name = or(l?.targetNames ? loc.localName(l.targetNames) : (l?.targetName ?? fromInputs));
    const key =
      verb === 'create'
        ? 'ops.audit.s.catalogCreate'
        : verb === 'delete' || inputs.isArchived === true
          ? 'ops.audit.s.catalogArchive'
          : inputs.isArchived === false
            ? 'ops.audit.s.catalogRestore'
            : 'ops.audit.s.catalogUpdate';
    return out(key, { name });
  }

  return out('ops.audit.s.generic', { object, verb: verb || '—' });
}

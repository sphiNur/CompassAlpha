/**
 * ADM2-06 (2026-11-09): the "Name: Tomato → Cherry tomato" lines under an
 * audit row, from the `changes` the server now records on edits
 * (`{ field: [before, after] }`, services/auditChanges). Rows written
 * before have none and show no lines.
 *
 * Pure: the caller passes the localizers, so this is unit-testable.
 */
export type ChangeFieldKey =
  | 'admin.field.address'
  | 'admin.field.category'
  | 'admin.field.code'
  | 'admin.field.defaultPaymentMethod'
  | 'admin.field.defaultQty'
  | 'admin.field.defaultRole'
  | 'admin.field.defaultUnitPrice'
  | 'admin.field.label'
  | 'admin.field.name'
  | 'admin.field.notes'
  | 'admin.field.phone'
  | 'admin.field.slug'
  | 'admin.field.sortIndex'
  | 'admin.field.step'
  | 'admin.field.tgUsername'
  | 'admin.field.timezone'
  | 'admin.field.unit'
  | 'admin.field.unitHint'
  | 'ops.audit.field.status';

/**
 * Server field → the label the edit form shows for it, in the order the
 * forms show the fields (store, product, category, supplier and expense
 * template forms all agree with it). The lines follow this order: the
 * recorded `changes` cannot keep one, as Postgres jsonb reorders keys.
 */
const FIELD_LABEL: Record<string, ChangeFieldKey> = {
  slug: 'admin.field.slug',
  name: 'admin.field.name',
  names: 'admin.field.name',
  label: 'admin.field.label',
  category: 'admin.field.category',
  unit: 'admin.field.unit',
  step: 'admin.field.step',
  code: 'admin.field.code',
  unitHint: 'admin.field.unitHint',
  defaultQty: 'admin.field.defaultQty',
  defaultUnitPrice: 'admin.field.defaultUnitPrice',
  defaultPaymentMethod: 'admin.field.defaultPaymentMethod',
  contactPhone: 'admin.field.phone',
  contactTg: 'admin.field.tgUsername',
  address: 'admin.field.address',
  timezone: 'admin.field.timezone',
  notes: 'admin.field.notes',
  defaultRole: 'admin.field.defaultRole',
  isActive: 'ops.audit.field.status',
  sortIndex: 'admin.field.sortIndex',
};

export interface AuditChangeLine {
  field: ChangeFieldKey;
  before: string;
  after: string;
}

export interface ChangeFormat {
  /** Shown for a value that was or became empty. */
  empty: string;
  /** Localizes an i18n names map (SKU / category). */
  localName: (names: Record<string, string>) => string;
  unit: (code: string) => string;
  paymentMethod: (method: string) => string;
  /** A store's active flag. */
  active: (on: boolean) => string;
}

export function auditChangeLines(inputs: unknown, fmt: ChangeFormat): AuditChangeLine[] {
  const changes =
    inputs && typeof inputs === 'object' ? (inputs as { changes?: unknown }).changes : undefined;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return [];
  const lines: AuditChangeLine[] = [];
  for (const [field, label] of Object.entries(FIELD_LABEL)) {
    const pair = (changes as Record<string, unknown>)[field];
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    lines.push({
      field: label,
      before: show(field, pair[0], fmt),
      after: show(field, pair[1], fmt),
    });
  }
  return lines;
}

function show(field: string, value: unknown, fmt: ChangeFormat): string {
  if (value === null || value === undefined || value === '') return fmt.empty;
  if (typeof value === 'boolean') return fmt.active(value);
  if (typeof value === 'object') {
    return Array.isArray(value)
      ? fmt.empty
      : fmt.localName(value as Record<string, string>) || fmt.empty;
  }
  const text = String(value);
  if (field === 'unit') return fmt.unit(text);
  if (field === 'defaultPaymentMethod') return fmt.paymentMethod(text);
  return text;
}

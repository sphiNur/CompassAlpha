/**
 * Review ADM2-41 (2026-11-12): a store's time zone is picked from a list
 * (timeZones.ts) instead of typed as an IANA name. The first choice, empty,
 * is the workspace's zone: what the server uses for a store without one.
 */
import { useMemo } from 'react';
import { Select } from '@compass/ui';
import { zoneName } from '../../../lib/dateFormat';
import { useI18n } from '../../../hooks/useI18n';
import { useAuthStore } from '../../../stores/authStore';
import { deviceTimeZones, timeZoneChoices } from './timeZones';

export function StoreTimeZoneSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (timeZone: string) => void;
  disabled?: boolean;
}) {
  const i18n = useI18n();
  const workspaceZone = useAuthStore((s) => s.session?.member.timezone);
  const all = useMemo(() => deviceTimeZones(), []);
  const { common, other } = useMemo(() => timeZoneChoices(value, all), [value, all]);
  // The common zones by name and id (two zones can share a name); the
  // long tail by id alone.
  const named = (zone: string) => {
    const name = zoneName(zone, i18n.locale);
    return name === zone ? zone : `${name} · ${zone}`;
  };
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      <option value="">
        {i18n.t('admin.store.timezoneWorkspace', {
          timezone: workspaceZone ? zoneName(workspaceZone, i18n.locale) : '—',
        })}
      </option>
      <optgroup label={i18n.t('admin.store.timezoneCommon')}>
        {common.map((zone) => (
          <option key={zone} value={zone}>
            {named(zone)}
          </option>
        ))}
      </optgroup>
      {other.length > 0 ? (
        <optgroup label={i18n.t('admin.store.timezoneOther')}>
          {other.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </optgroup>
      ) : null}
    </Select>
  );
}

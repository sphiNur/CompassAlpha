/**
 * The month's attendance as an Excel file (2026-11-05): pick a month, and
 * the file opens in Telegram's download dialog (or the browser).
 */
import { useState } from 'react';
import { Button } from '@compass/ui';
import { useDateFormat, useI18n } from '../../hooks/useI18n';
import { haptic } from '../../hooks/useTelegram';
import { useErrToast } from '../../lib/errToast';
import { saveFile } from '../../lib/fileDownload';
import { trpc } from '../../lib/trpc';

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function AttendanceExport({ storeId }: { storeId: string }) {
  const i18n = useI18n();
  const dates = useDateFormat();
  const errToast = useErrToast();
  const [month, setMonth] = useState(thisMonth);
  const [saving, setSaving] = useState(false);
  const link = trpc.attendance.exportLink.useMutation({
    onError: errToast('attendance.export.failed'),
  });
  const current = thisMonth();

  const exportMonth = async () => {
    setSaving(true);
    try {
      const { path, fileName } = await link.mutateAsync({
        storeId,
        month,
        locale: i18n.locale,
      });
      haptic('success');
      // Telegram answers when the person closes its dialog; don't spin till then.
      void saveFile(path, fileName);
    } catch {
      // errToast above has told the person.
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mx-4 mt-5 flex flex-col gap-2 rounded-[var(--r-card)] bg-[var(--c-surface)] px-4 py-3 ring-hairline">
      <h2 className="text-old-h3 font-semibold text-[var(--c-fg)]">
        {i18n.t('attendance.export.title')}
      </h2>
      <p className="text-old-label text-[var(--c-fg-muted)]">{i18n.t('attendance.export.hint')}</p>
      <div className="flex items-center gap-2">
        <Button
          variant="utility"
          size="sm"
          onClick={() => setMonth(shiftMonth(month, -1))}
          aria-label={i18n.t('attendance.nav.prev')}
        >
          ‹
        </Button>
        <span className="min-w-0 flex-1 truncate text-center font-semibold text-[var(--c-fg)]">
          {dates.monthYear(`${month}-01T12:00:00`)}
        </span>
        <Button
          variant="utility"
          size="sm"
          disabled={month >= current}
          onClick={() => setMonth(shiftMonth(month, 1))}
          aria-label={i18n.t('attendance.nav.next')}
        >
          ›
        </Button>
      </div>
      <Button block variant="secondary" loading={saving} onClick={() => void exportMonth()}>
        {i18n.t('attendance.export.button')}
      </Button>
    </section>
  );
}

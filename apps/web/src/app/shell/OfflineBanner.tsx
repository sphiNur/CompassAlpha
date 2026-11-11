/**
 * The line at the top of every page while the device is offline.
 *
 * HIS-9 / CLS-6 (2026-10-30): offline, lists kept showing the last data
 * (or "nothing yet") with no word that it was stale.
 * R2-ENG-1 / R2-SHL-2 (2026-10-31): say how old the data on screen is (the
 * saved copy keeps its load time), or that there is none, instead of
 * always promising "the last loaded content".
 * Walkthrough F28 (2026-11-05): the banner ran to four lines and pushed the
 * first rows off a phone screen. One line by default; what still works
 * offline opens on demand.
 *
 * Review COREWEB1-10 (2026-11-12): out of Shell.tsx. COREWEB1-31: reads
 * hooks/useOnline.ts instead of a copy of it. COREWEB1-19: the title with
 * the time is one sentence of the catalog; it was two joined with " · ",
 * which fixed the word order in every language.
 */
import { useState } from 'react';
import { Banner } from '@compass/ui';
import { lastUpdatedLabel, useCachedDataAge } from '../../hooks/useCachedDataAge';
import { useDateFormat, useI18n } from '../../hooks/useI18n';
import { useOnline } from '../../hooks/useOnline';

export function OfflineBanner() {
  const i18n = useI18n();
  const online = useOnline();
  const cachedAt = useCachedDataAge(!online);
  const dateFmt = useDateFormat();
  const [details, setDetails] = useState(false);
  if (online) return null;
  return (
    <div className="px-4 pt-3">
      <Banner
        tone="warn"
        title={
          cachedAt !== null
            ? i18n.t('shell.offline.titleSince', { time: lastUpdatedLabel(cachedAt, dateFmt) })
            : i18n.t('shell.offline.title')
        }
        action={
          <button
            type="button"
            className="press min-h-11 px-1 text-old-label font-semibold text-[var(--c-action)]"
            aria-expanded={details}
            aria-controls="offline-details"
            onClick={() => setDetails(!details)}
          >
            {i18n.t(details ? 'shell.offline.hideDetails' : 'shell.offline.showDetails')}
          </button>
        }
      >
        {details ? (
          <span id="offline-details">
            {i18n.t(cachedAt !== null ? 'shell.offline.body' : 'shell.offline.noDataBody')}
          </span>
        ) : null}
      </Banner>
    </div>
  );
}

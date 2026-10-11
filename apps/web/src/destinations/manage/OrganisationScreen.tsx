import { useEffect, useState } from 'react';
import { useToast } from '@compass/ui';
import { Button, cn, Field } from '@compass/ui/kit';
import { trpc } from '../../lib/trpc';
import { useAuthStore } from '../../stores/authStore';
import { useErrToast } from '../../lib/errToast';
import { useI18n } from '../../hooks/useI18n';

// The currencies of the markets this is sold in, and the dollar for
// contracts across a border. The server takes any three-letter code.
const CURRENCIES = ['UZS', 'RUB', 'KZT', 'USD'] as const;

const CAPSULE =
  'flex h-pillbtn shrink-0 items-center rounded-pill px-lg text-label outline-none active:opacity-70 disabled:opacity-40';
const pick = (on: boolean) =>
  cn(CAPSULE, on ? 'bg-contrast text-on-contrast' : 'bg-surface text-ink');

/**
 * What holds for the whole organisation: its name, and how its money is
 * written. One's own language, name and role are under Settings; they
 * were listed here too, as if they were the organisation's.
 *
 * The money settings are on the page, not behind a row that opened a
 * sheet. Save lights up when something differs.
 */
export function OrganisationScreen() {
  const i18n = useI18n();
  const toast = useToast();
  const errToast = useErrToast();
  const session = useAuthStore((s) => s.session);
  const patchSession = useAuthStore((s) => s.patchSession);
  const may = !!session?.permissions.includes('users.manage');

  const stored = {
    currency: session?.member.currency ?? 'UZS',
    tax: session?.member.taxRatePct ?? '0',
    inclusive: session?.member.pricesIncludeTax ?? true,
  };
  const [currency, setCurrency] = useState(stored.currency);
  const [tax, setTax] = useState(stored.tax);
  const [inclusive, setInclusive] = useState(stored.inclusive);
  useEffect(() => {
    setCurrency(stored.currency);
    setTax(stored.tax);
    setInclusive(stored.inclusive);
    // Only when what is stored changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored.currency, stored.tax, stored.inclusive]);

  const save = trpc.admin.orgFinanceUpdate.useMutation({
    onSuccess: () => {
      if (session) {
        patchSession({
          ...session,
          member: {
            ...session.member,
            currency,
            taxRatePct: tax,
            pricesIncludeTax: inclusive,
          },
        });
      }
      toast.success(i18n.t('common.saved'));
    },
    onError: errToast('common.error'),
  });

  const taxOk = /^\d{1,3}(\.\d{1,2})?$/.test(tax) && Number(tax) <= 50;
  const dirty =
    currency !== stored.currency ||
    Number(tax) !== Number(stored.tax) ||
    inclusive !== stored.inclusive;

  return (
    <div className="flex flex-col gap-xl px-page">
      <div className="flex flex-col gap-xs">
        <span className="text-small text-secondary">{i18n.t('admin.workspace.name')}</span>
        <span data-testid="org-name" className="text-h2 text-ink">
          {session?.member.orgName ?? ''}
        </span>
      </div>

      <div className="flex flex-col gap-sm">
        <span className="text-label text-ink">{i18n.t('admin.workspace.currency')}</span>
        <div className="flex flex-wrap gap-sm">
          {CURRENCIES.map((code) => (
            <button
              key={code}
              type="button"
              aria-pressed={currency === code}
              data-testid="org-currency"
              disabled={!may}
              onClick={() => setCurrency(code)}
              className={pick(currency === code)}
            >
              {code}
            </button>
          ))}
        </div>
        {/* Said where the choice is made, not at the bottom of a sheet. */}
        <p className="text-small text-secondary">
          {i18n.t('admin.workspace.financeSheet.warning')}
        </p>
      </div>

      <div className="flex flex-col gap-sm">
        <Field
          numeric
          label={i18n.t('admin.workspace.taxRate') as string}
          value={tax}
          disabled={!may}
          suffix="%"
          onChange={(e) => setTax(e.target.value.replace(',', '.'))}
        />
        <p className="text-small text-secondary">{i18n.t('admin.workspace.taxRateHint')}</p>
      </div>

      {Number(tax) > 0 ? (
        <div className="flex flex-col gap-sm">
          <span className="text-label text-ink">{i18n.t('admin.workspace.pricesIncludeTax')}</span>
          <div className="flex flex-wrap gap-sm">
            {[true, false].map((on) => (
              <button
                key={String(on)}
                type="button"
                aria-pressed={inclusive === on}
                data-testid="org-tax-inclusive"
                disabled={!may}
                onClick={() => setInclusive(on)}
                className={pick(inclusive === on)}
              >
                {i18n.t(
                  on ? 'admin.workspace.pricesIncludeTaxOn' : 'admin.workspace.pricesIncludeTaxOff',
                )}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {may ? (
        <Button
          variant="primary"
          data-testid="org-save"
          busy={save.isPending}
          disabled={!dirty || !taxOk}
          onClick={() => save.mutate({ currency, taxRatePct: tax, pricesIncludeTax: inclusive })}
        >
          {i18n.t('common.save')}
        </Button>
      ) : null}
    </div>
  );
}

-- 0014_currency_and_tax.sql
--
-- (M1.17, 2026-05-08) Multi-currency + VAT/tax foundation.
--
-- Background: the system has been quietly UZS-only. Every money column,
-- every i18n suffix, every formatMoney call assumed Uzbek Som. That's
-- fine for the launch tenant, but it's structurally fragile — the next
-- tenant (KZT / RUB / USD) would require a code sweep across web,
-- contracts, i18n, and reports.
--
-- M1.17 adds the foundation columns and the Workspace admin UI to
-- edit them. It does NOT yet:
--
--   * Capture per-transaction tax (M2.x — needs domain event change
--     so historical rate edits don't retroactively rewrite past
--     purchases).
--   * Sweep i18n strings to use `{currency}` placeholders (deferred
--     until the second tenant actually arrives — premature work
--     otherwise).
--   * Re-denominate any existing money columns (NEVER — money is
--     stored as the value at recording time; flipping `currency`
--     does NOT rewrite past purchases).
--
-- Three new columns on auth.organizations:
--
--   currency           VARCHAR(3) NOT NULL DEFAULT 'UZS'
--     ISO-4217 code. Read by FE formatMoney/i18n to render the right
--     suffix. Operators should treat this as set-once per org — flipping
--     it does NOT convert historical amounts.
--
--   tax_rate_pct       NUMERIC(5,2) NOT NULL DEFAULT 0
--     Org-wide default VAT %. 0 = no tax tracking. Uzbekistan standard
--     is 12.00. Per-SKU override on inventory.skus.tax_rate_pct.
--
--   prices_include_tax BOOLEAN NOT NULL DEFAULT TRUE
--     Whether unit_price values are gross (true) or net (false). Default
--     gross matches the typical market-stall workflow where the supplier
--     quotes the price-out-of-pocket. Reports use this to surface
--     recoverable VAT without storing it as a separate column.
--
-- One new nullable column on inventory.skus:
--
--   tax_rate_pct       NUMERIC(5,2)  -- override; NULL → use org default
--
-- All defaults preserve existing behavior bit-for-bit: every org sees
-- UZS, no tax (0%), gross prices, and every SKU inherits the org rate.

ALTER TABLE auth.organizations
  ADD COLUMN currency           VARCHAR(3)    NOT NULL DEFAULT 'UZS',
  ADD COLUMN tax_rate_pct       NUMERIC(5, 2) NOT NULL DEFAULT 0,
  ADD COLUMN prices_include_tax BOOLEAN       NOT NULL DEFAULT TRUE;

ALTER TABLE inventory.skus
  ADD COLUMN tax_rate_pct NUMERIC(5, 2);

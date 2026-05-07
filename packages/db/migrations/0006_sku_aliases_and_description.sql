-- 0006_sku_aliases_and_description.sql
--
-- Adds two i18n jsonb fields to `inventory.skus`:
--
--   aliases     — search keywords by locale, used by OrderPage to make
--                 a search for "纸" (paper) match all the packaging
--                 papers without forcing the operator to know the
--                 official Uzbek name.
--                 Shape: { zh: ["卷纸","纸巾"], ru: [...], ... }
--
--   description — purchase notes by locale, e.g. "按整包,通常 10 支"
--                 next to "Sasiska (pochka)" so the operator picks the
--                 right SKU when there's a per-pack vs per-kg variant.
--                 Shape: { zh: "...", en: "...", ... }
--
-- Both default to empty jsonb objects so existing rows remain valid
-- without any backfill. No constraint changes; pure additive schema.
--
-- Driven by the real-catalog import 2026-05-05 — see
-- packages/db/src/catalog-uzbek.ts. Without these fields the catalog
-- has to lose either the search-keyword data (worse search UX) or
-- the variant-disambiguation notes (worse purchase UX).

ALTER TABLE inventory.skus
  ADD COLUMN IF NOT EXISTS aliases jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE inventory.skus
  ADD COLUMN IF NOT EXISTS description jsonb NOT NULL DEFAULT '{}'::jsonb;

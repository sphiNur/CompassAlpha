# UI/UX Redesign 2026-07 — "Ledger & Rail"

> Owner mandate (2026-07-06): full UI/UX redesign by professional judgment, no questions.
> Method: 6 per-flow functional analyses + 3 adversarial design lenses (bazaar operations /
> manager trust / density & typography) + synthesis, all grounded in the shipped code
> (10 agents, ~960k tokens). This document is the governing spec; UI_STANDARDS.md UI-1..10
> remains in force underneath it.

## Design thesis

CompassAlpha is a **pipeline of task instruments** (下单 → 审核 → 采购 → 验收 → 结算), not an
information display. Each screen serves ONE role doing ONE job — often one-handed, in
sunlight, mid-haggle, on a cheap Android panel. The redesign therefore optimizes for:
glanceable state (shape+text first, color as reinforcement), ledger-grade money
(mono, tabular, full digits on reading surfaces), silence for defaults, loudness for
exceptions and off-plan spending, and a hard tap-target floor on everything that
mutates money.

Three prior field decisions are LAW and survive every rule below: inline qty/price entry
(tap-per-item is intolerable), the in-DOM PageMainButton (native Telegram MainButton stays
dead — M3.49), and the M3.14/M3.55 type scale (field-tuned).

## Final design language (L1–L12)

**1.** L1 (STATUS RAIL, constrained): a 3px rail carved out of the row's existing left padding (3px + 6px gutter from the px-4 inset, never from the name column) may SUPPLEMENT status but never replace shape/text encodings â€” it is allowed only where >=2 states are concurrently visible in the list, only for lightness-separable colors (warn 72%L vs success/danger 58%L is OK; success-vs-danger alone is forbidden since both sit at 58%L in tokens.css:31-33), never for states derived from a default value (no unearned green from confirmStatus ?? 'ok'), and the existing Â·/âœ“/âœ— glyphs count as the mandatory ambiguity text-tag and stay.

**2.** L2 (WORK ROW, four variants): all task lists share [optional rail | NameCell(primary+secondary) + CONDITIONAL meta line | right slot], with money right slots fixed at min-w-[9ch] font-mono tabular-nums, in exactly these recipes â€” standard (py-2.5, right control <=36px, <=2 lines, 13px primary), dense (py-1.5, right control <=28px/QtyControl sm, 1 line, 13px primary), picker row (Order SKUs: 15px text-h2 primary, zero-meta-line default per M3.55, no rail), and input row (Run pending purchase: line 2 is a full-width qtyÃ—price=total|method|save grid, exempt from the single-right-slot rule per the 'tap-per-item is intolerable' mandate) â€” and any row primitive must keep primitive/stable props to preserve the documented React.memo contract (OrderPage.tsx:881-903).

**3.** L3 (SCREEN ANATOMY, corrected): 'MainButton' means the in-DOM PageMainButton bar (Shell.tsx:463-512) â€” the native Telegram MainButton stays dead (M3.49 nav-jump regression); sheets ALWAYS own their footer CTA (a sheet footer is never a duplicate of the page CTA it covers, and the page CTA hides while a sheet is open); read-only screens (Finance, all histories, detail sheets) declare NO MainButton and reclaim the ~64px reserve; summary scorecards are content, not chrome; and 'ONE Card container' applies within a ledger, not across ledgers â€” Items/Extras/Expenses are three money buckets and stay three cards.

**4.** L4-display (LEDGER MONEY): recorded money renders right-aligned font-mono tabular-nums at pinned sizes (headline text-h2 15px mono semibold, row 13px, sub-line 11px), NEVER K-abbreviated on finance/history/settlement surfaces (digits must match the TSV export); cash is silent ONLY on single-method line rows, while any aggregate that can mix methods (per-store settlement, finance groups, scorecard) shows cash AND transfer explicitly so cash+transfer=total stays verifiable; the transfer marker is the i18n key run.label.paymentTransfer as bare 11px text â€” never a hardcoded zh literal, never color-only, never a pill.

**5.** L4-entry (MONEY ENTRY): live price inputs KEEP their per-field KÂ·UZS/UZS suffix, the K-scaled lastPrice hint, and the inline =total raw-UZS preview (the only at-hand guards against the M3.36 1000x failure); the Ã—1000 bar toggle governs entry scale only; the pre-save payment method stays a visible two-state çŽ°é‡‘/è½¬è´¦ TEXT toggle (an input, not a status display); every saved money row keeps a one-tap edit path and price entry flags (never blocks) values deviating >5x from lastPrice.

**6.** L4-estimate (HONEST ESTIMATES): estimated money never wears the ledger dress (mono but not semibold), always keeps the ~ prefix AND a visible coverage marker â€” render the already-computed known/unknown counts (e.g. '~1,240,000 UZS Â· 2 é¡¹æ— ä»·') on both the OrderPage review sheet and the ApprovalPage estimate row, where estimateTotal.unknown is currently computed then silently dropped.

**7.** L5 (EMOJI ZERO in chrome, scoped): sweep ðŸ›’â“ðŸ’µðŸ¦ðŸªðŸŒðŸ“‹Î£ and SettingsSheet section emoji from all chrome, replacing with existing i18n text labels, with two exemptions â€” generated chat content (copy-to-vendor Telegram templates keep emoji) and typographic marks (Â·/âœ“/âœ—/â‹¯ are load-bearing shape encodings and tap-affordance signifiers, not emoji); status/text tags render as bare text-label 11px font-medium, never Badge/Chip pills, so pill shape regains the meaning 'tappable'.

**8.** L6 (PROGRESSIVE DISCLOSURE, evidence-exempt): disclosure may hide prose and navigation but never EVIDENCE, interactive bands, or required input â€” session extras/legacy notes on approval, the RunExtrasCard warn band (M3.31: extras 'silently disappeared' once), purchaser-added buckets, per-store split data (M3.52), rejection reasons, and estimate coverage markers all render eagerly whenever their container is open; the extras editor keeps name+qty+unit simultaneously visible; collapsed teasers may be 11px but expanded content is >=12px.

**9.** L7 (ONE ACCENT ROLE per screen): the accent is a ROLE, legitimately repeated per row when the row action IS the primary (the Run pending âœ“ save appears N times while the page button hides until all items are handled); secondary actions are quiet text at >=44px hit area; destructive = ghost until sheet, EXCEPT operational escape valves â€” Withdraw, Release claim, Take-over, Unapprove, Recall delivery â€” which stay one visible tap at ghost/pearl weight because each has a documented failure mode behind it.

**10.** L8 (EMPTY STATES): one sentence, no box, no border â€” except diagnostic dead-ends (manager with zero stores) which keep title+body copy but still lose the box.

**11.** L9 (TAP TARGET FLOOR, new): any control that mutates money or item state gets a >=44px effective hit area via padding/hit-slop even when drawn at 32px â€” the pending-row âœ“ save, the payment toggle, the N/A pill, and the record-price pill are the first fixes.

**12.** L10 (OFF-PLAN IS LOUD, new): anything bought beyond the approved order â€” addedByPurchaser SKUs, off-catalog expenses, store-requested extras â€” keeps its own visible bucket with count + total on EVERY downstream surface (approval expansion, purchasing three-card stack, finish sheet, history detail, finance), codifying M3.31/M3.41/M3.44 as design law and overriding one-card consolidation.

**13.** L11 (ANOMALY AFFORDANCE, new): the redesign adds one positive manager signal â€” in the approval expansion, where skuPriceStats is already fetched, lines whose implied cost deviates sharply from the 7d average get a quiet text tag (e.g. '+38% vs 7d'); this is the only clause that actively serves 'approve without rubber-stamping'.

**14.** L12 (SUNLIGHT RULE, new, all purchaser surfaces): information is never encoded in color alone or 3px of ink alone â€” every state needs a shape or text channel, every money figure is mono tabular at 13px or larger, and everything the thumb hits while holding a bag meets L9.

## Screen blueprints

### OrderPage (staff ä¸‹å•)

**Anatomy.** StickyPageBar: SearchInput + category ChipBar (any category tap now clears a stale search query; 'All' keeps clearing both) â†’ at most ONE status banner (claimed warn / rejected danger with reason + pearl Withdraw / submitted info + pearl Withdraw / approved success / in_run info â€” unchanged content, banners stay banners because they carry reasons and time-critical actions) â†’ ONE Card of divided SKU picker rows (hundreds, memoized) â†’ SectionLabel å…¶ä»–ç‰©å“ + extras editor (name Input with autocomplete, qty NumberInput, unit select, X remove â€” all three fields simultaneously visible; 'savingâ€¦' is the only save indicator) â†’ PageMainButton 'Review Order (N)', hidden while the review sheet is open â†’ Review Sheet: description '{N} items' only, ~estimate in mono (NOT semibold) + known/unknown coverage hint, category-grouped cards NOW WITH a SectionLabel per category, footer 'Submit order' button (the only reachable submit â€” stays).

**Work row.** PICKER ROW variant (no rail â€” single-state list fails L1's >=2-states test; myQty>0 is already signaled by the qty value, the quietest possible treatment): [NameCell primary text-h2 15px semibold + secondary locale 11px muted] + CONDITIONAL meta line (suggested-qty hint and/or aggregate 'total (N)' contributor line only when data exists â€” the M3.55 zero-meta default is codified) | right slot: QtyControl md (âˆ’ / w-16 mono value+unit, blank at zero / +) with 44px effective hit areas via padding (L9). py-1.5. Name column keeps its full ~164px; any future right-slot addition comes out of the QtyControl middle or the meta line, never the name line.

**Deletions.**
- OrderPage.tsx:829-840 â€” dead !getTg() fallback 'Review' footer button (Shell renders the in-DOM PageMainButton unconditionally since M3.49; outside Telegram this stacks two identical CTAs)
- OrderPage.tsx:517-518 â€” 'Submit order' mainButtonText branch (dead-dimmed behind the sheet scrim); add !reviewOpen to the visible flag at OrderPage.tsx:592
- OrderPage.tsx:852-854 â€” date prefix in review-sheet description (todaySession is always today); dateLabel computation at 624-629 dies with it
- OrderPage.tsx:1432-1434 â€” 'Ã—N' usage count on extras autocomplete suggestions (keep count-ranked ordering server-side)
- OrderPage.tsx:1319-1323 â€” the 1.5s 'saved' flash + its timer (keep 'savingâ€¦' and error toasts; success is silence)
- QtyControl.tsx:462-526 (+327-334 wiring) â€” the native Telegram MainButton confirm path in the quick-pick sheet (~90 lines; last consumer of the rival MainButton system that un-hides the button Shell permanently hides and jumps the layout)

**Interactions.** Primary action: PageMainButton 'Review Order (N)' â†’ sheet â†’ footer 'Submit order' (flush-before-submit ordering at 544-578 is correctness-critical and untouched). Qty: +/- optimistic with hold-to-ramp; quick-pick presets 2 taps; custom qty confirms via the in-sheet button unconditionally (no more native-MainButton layout jump). Category chip tap clears search (kills the invisible-filter empty-list trap M3.10 fixed only for 'All'). Withdraw stays a pearl button inside the submitted/rejected banners â€” time-critical escape valve per L7's exception, never quiet text. Rejected reason stays one glance away in the banner, never behind disclosure. Errors: no-matches empty state names nothing extra but survives; offline qty edits keep the outbox replay with drop-toast.

**Implementation.** Zero new components â€” this screen is already closest to the language. Order of work: (1) the six deletions above, all zero-risk; (2) hide-PMB-while-sheet-open flag; (3) chip-clears-search one-liner at 676; (4) SectionLabel per category card in the review sheet (categories already fetched at line 72); (5) quick-pick confirm unification (delete the useTelegramMainButton path). HARD CONSTRAINT: SkuRow's React.memo shallow-compare contract must survive any row-primitive extraction â€” pass primitive/stable props only, or re-ship the 400-500ms iOS WebView jank documented at 881-903. Do not touch the 15px primary (field-tuned M3.55) or the optimistic/debounce/outbox pipeline (83-380).

### ApprovalPage (manager å®¡æ ¸)

**Anatomy.** StickyPageBar: pending/approved/rejected Tabs (unchanged) â†’ <ul role='list'> of <li>-wrapped Cards (fixes the current Card-directly-in-ul semantics). Per card: [warn rail ONLY when claimed-by-other â€” the one state pair here that is lightness-separable from unclaimed] CardTitle = store name; CardMeta = submitter Â· 'N äºº' (conditional) Â· orderDate Â· bare 11px warn-ink text tag 'ç•™è¨€' when notes/extras exist (replaces the Badge pill â€” it is the only pre-expansion signal for free-text asks and must survive, just as text per L5). Claimed-by-other Banner STAYS a banner (claimant name + M3.22 handoff line + permission-gated Take-over button â€” a rail cannot carry a name or an action; documented field failure behind this). Rejected-reason danger banner stays on the rejected tab. Expansion (auto-open on Claim): dense item rows â†’ extras + legacy-notes warn band rendered EAGERLY (L6 evidence exemption, L10 bucket) â†’ estimate row '~X UZS Â· N é¡¹æ— ä»·' with L11 deviation tags per line â†’ action row: Approve (THE accent) / Reject (danger text â†’ reason sheet) / Release (ghost).

**Work row.** DENSE variant: [NameCell 13px primary, no secondary needed] | right slot QtyControl sm h-7 (single-contributor case, M3.34 flattening kept). Multi-contributor case is the codified L2 exception: parent row shows name + aggregate, nested sub-rows [contributor name 11px muted | QtyControl sm] feed adjustItem's targetMemberId â€” this nesting is irreducible (requirement #6 'who asked for what'). Pending state keys on adjust.variables per row, not adjust.isPending across the whole card, so multi-item adjustments stop serializing. Estimate row: mono 13px, tilde prefix, muted 11px 'Â· N é¡¹æ— ä»·' suffix; deviation tag '+38% vs 7d' as bare 11px warn text on offending lines.

**Deletions.**
- ApprovalPage.tsx:204-208 â€” submitter Avatar (mixed identity: photo=submitter, fallback initial=STORE name; 32px of decorative wrongness; CardMeta 216-218 already names the submitter)
- ApprovalPage.tsx:230-242 â€” the shrink-0 badge wrapper div + notes Badge pill (content survives as the bare text tag in CardMeta)
- ApprovalPage.tsx:351-357 â€” Release variant='pearl' â†’ variant='ghost' (visible one-tap stays; weight drops per L7)
- ApprovalPage.tsx:539-556 dead-accounting fix â€” estimateTotal.unknown is computed and NEVER rendered despite the comment at 617-618 claiming flagging; render it at 619-628 instead of deleting it
- ApprovalPage.tsx:176-179 and 187-190 â€” EmptyState box/border chrome (keep title+body for the no-store diagnostic per L8's exception; keep the one sentence for empty queue)

**Interactions.** Claim = 1 tap, atomically locks + auto-expands (keep). Approve = 1 tap, no confirm, haptic + toast (keep â€” morning queue processing). Reject = 2-step: danger text â†’ sheet with 2-3 canned reason chips ABOVE the mandatory free-text Input (cuts wet-market typing; disabled-until-nonempty rule at 436 stays; M3.10 dismiss-guard stays). Release = 1 ghost tap. Take-over = tap + native confirm, audit-logged (friction is correct). Unapprove (approved tab) = ADD a confirm â€” it silently reverses a decision downstream roles act on. Do NOT eager-fetch estimates per card header (NÃ—2 queries on bazaar LTE); the estimate stays inside the expansion until pendingList grows a server-side field.

**Implementation.** Components touched: card header (avatar out, text tag in), estimate row (one-line suffix), Reject sheet (chip row), QtyControl call sites (per-row pending via adjust.variables). NEW: the L11 deviation tag â€” cheapest implementation is a pure function over the already-fetched skuPriceStats (541-544) rendered as a conditional 11px span on the per-SKU total row. Migration order: (1) unknown-count surfacing + avatar deletion + Release demotion (independent one-liners); (2) li-wrapping + text-tag conversion; (3) per-row pending; (4) canned reject chips; (5) deviation tags. Risk: none of these touch the claim/take-over concurrency machinery â€” leave those mutations byte-identical.

### RunPage â€” active run (purchaser é‡‡è´­, THE money screen; bazaar lens wins every conflict)

**Anatomy.** Sticky strip: Ã—1000 toggle pill (the single bar-level K indicator, persisted) + '+ add item' + run tag shrunk toward phase-only â†’ attach-new-sessions info banner when late approvals exist (keep â€” midday top-up path) â†’ THREE cards, protected by L3's ledger clause and L10: (1) Items card â€” SectionLabel 'pending/total' fraction + view chips æŒ‰åº—é“º/æŒ‰æ‘Šä½/æŒ‰ç±»åž‹; (2) RunExtrasCard â€” warn band fully visible, tap-to-cycle Â·/âœ“/âœ— + record-price pill (44px); (3) ExpensesCard â€” header 'n Â· total UZS'; when empty, collapse to ONE quiet borderless '+ è®°æ‚è´¹' text row (correct i18n key), not a full empty card â†’ PageMainButton hidden until all items handled (deliberate; the accent ROLE during purchasing is the per-row âœ“) â†’ all phase transitions via ConfirmSheet, every sheet keeps its own footer button (M3.49 law). Delivering phase: store rows = [rail per stage â€” the one place rails genuinely earn ink since rows differ in state] + store name + 'N items Â· stage' subtitle + visible quiet 'recall' ghost text on delivered-unconfirmed rows; finish ConfirmSheet keeps total / added-beyond-order bucket / expenses bucket / per-store settlement lines with BOTH çŽ°é‡‘ and è½¬è´¦ figures as i18n text.

**Work row.** INPUT ROW variant (canonical instance, exempt from single-right-slot): line 1 [NameCell SKU name 13px + planned qtyÂ·unit + K-scaled lastPrice hint] + store-split line restyled from ringed pills to ONE muted mono 11px text line 'åº—A 2kg Â· åº—B 3kg' (M3.52 data preserved, pill chrome deleted); line 2 full-width grid: qty input Ã— price input [per-field 'KÂ·UZS'/'UZS' suffix STAYS â€” L4-entry] = live raw-UZS total hint (mono semibold 13px) | çŽ°é‡‘/è½¬è´¦ two-state TEXT toggle (i18n keys, visible both states) | âœ“ save â€” âœ“, toggle, and N/A all get 44px hit areas (L9). PURCHASED row: âœ“ glyph (shape encoding stays, text-body size) + name | mono 'qty Ã— price = total' + bare 11px è½¬è´¦ tag only when transfer + '+' added-by-purchaser marker folded into the meta line + Edit as the ONLY visible action. UNAVAILABLE row: âœ— + reason note one-liner + Restore.

**Deletions.**
- RunPage.tsx:496-512, 605-658, 1478-1506 â€” the entire dead claim subsystem (~90 lines): banner unreachable because collaborationEnabled is hardcoded true at 608; auto-claim/release effects are no-ops
- RunViews.tsx:1405-1412 â€” per-row Undo button (rare action, permanent danger-color mis-tap target adjacent to âœ“; moves inside the Edit/PurchaseSheet)
- RunPanels.tsx:506 â€” stage Badge on delivering store rows (subtitle at 504 already states the stage; the rail takes over)
- RunViews.tsx:320 + RunPanels.tsx:1252 â€” ðŸ›’ on ASSIGNED supplier headers (assigned = silent name; unassigned keeps a text tag replacing â“)
- RunViews.tsx:1319 + RunPage.tsx:1086 â€” ðŸ’µ/ðŸ¦ chrome â†’ çŽ°é‡‘/è½¬è´¦ i18n text (pending-row toggle and finish-sheet lines; vendor chat templates KEEP their emoji)
- RunViews.tsx:700-706 â€” expense-row scope pill (the adjacent store-name list already shows 1-vs-several)
- RunViews.tsx:672-676 + gate at RunPanels.tsx:452 â€” ExpensesCard misused scope-hint copy + full empty-card render
- RunPanels.tsx:1509-1511 â€” permanent eject-hint footer (text moves into the eject ConfirmSheet body at RunPage.tsx:1226-1248)
- RunViews.tsx:74, 313, 830 â€” mixed-unit qty sums in group headers (keep 'n SKUs', drop the meaningless kg+pcs+bottles number)
- RunPanels.tsx:914-917 â€” duplicated 'ä»·æ ¼æœªçŸ¥' in the preview formula
- RunSheets.tsx:132 â€” PurchaseSheet allocation list built from ALL org stores â†’ scope to run stores (mirror AddItemSheet's runStoreIds at 578-583)
- RunPanels.tsx:1103, 1111 + RunViews.tsx:820 + RunSheets.tsx:304 â€” hardcoded zh strings â†’ i18n.t (uz/ru purchasers currently read Chinese)

**Interactions.** The 2-tap money floor is inviolable: focus price (qty pre-filled from plan, price pre-filled from lastPrice) â†’ tap âœ“; explicit save stays (blur-save was field-rejected, comment 1044-1053). Proportional split recomputes silently; split text line is the receipt. NEW per L4-entry: price >5x deviation from lastPrice gets a flag (inline warn tag or toast) â€” never a block, the purchaser is mid-haggle. N/A = 1 tap â†’ reason sheet (audit gate stays). Edit = 1 tap â†’ PurchaseSheet now scoped to run stores; Undo lives inside it. Extras cycle = 1 tap per step (payload-free states â€” the pattern's legitimate home). Vendor reassign gets a visible chevron affordance (RunPanels.tsx:1028-1036 currently styles the tap target as plain text). Recall delivery = visible ghost text + 2-tap confirm with reason. Copy-to-vendor = 1 tap per vendor, emoji preserved in generated chat text.

**Implementation.** Highest-risk screen; touch anatomy least, chrome most. Order: (1) dead-code deletion (claim subsystem) â€” pure win; (2) emojiâ†’text swaps + i18n fixes â€” find/replace tier; (3) pillâ†’text restyles (store-split, scope pill) â€” CSS-tier, data untouched; (4) Undo relocation into PurchaseSheet + its run-store scoping â€” one behavioral change, test the split editor; (5) hit-area padding pass on âœ“/toggle/N/A/record-price â€” visual size unchanged; (6) delivering-row rail + recall affordance; (7) deviation flag last (new logic). NEVER: collapse the extras band, merge the three cards, strip per-field K suffixes, hide the cash state of the pre-save toggle, or resurrect the native MainButton. The offline queue + idempotency keys (RunPage.tsx:177-218) wrap every mutation here â€” no redesign may reorder save semantics.

### ConfirmPage (receiver éªŒæ”¶)

**Anatomy.** StickyPageBar: run-date context (kept, compressed â€” disambiguates late/overlapping deliveries) â†’ ONE Card, NO CardHeader title, divided exception-only rows â†’ PageMainButton 'ç¡®è®¤æ”¶è´§' (fraction deleted â€” it always read N/N) â†’ NEW ConfirmSheet on confirmStore (irreversible action, currently one unguarded tap; reuse RunPage's generic confirm-action sheet) â†’ Issue Sheet (opened per row): segmented 3-choice short/wrong/quality (role=radiogroup), for SHORT a received-qty NumberInput that auto-composes the note 'æ”¶åˆ° 2.5/4 kg', free-text mandatory only for wrong/quality, optional PhotoCapture (disableAutoFocus kept â€” iOS keyboard incident), footer Save button KEPT (L3: sheets own their footer; with the keyboard up the page CTA is unreachable â€” documented M1.9 chaos).

**Work row.** EXCEPTION-ONLY standard variant: resting row = [NameCell primary+secondary two-locale (load-bearing for ru/uz staff matching zh-catalogued crates)] | right slot: allocated qty PROMOTED to text-body 13px mono full ink (it is THE comparison target; currently 11px muted â€” spend the height reclaimed from the chip bar here) + one quiet trailing 'æœ‰é—®é¢˜' text affordance (44px hit area). NO chips at rest â€” deletes ~44px of untouched controls per row across hundreds of SKUs. ISSUE row (after sheet save): danger/warn rail + MANDATORY bare text tag short/wrong/quality (three same-severity states share a lightness band â€” L1 forbids rail-only here) + note one-liner + bare 'ç…§ç‰‡' text tag when confirmPhotoUrl exists (currently captured then never rendered â€” evidence must round-trip). ok remains the silent default; a green rail on load is forbidden (L1 no-unearned-green).

**Deletions.**
- ConfirmPage.tsx:392-419 â€” inline 'Confirm Store' button (byte-for-byte duplicate of the MainButton logic at 217-234; doubles the double-tap surface the storeConfirmed guard at 181-185 exists to fight)
- ConfirmPage.tsx:299-301 â€” CardHeader/CardTitle 'confirm.deliveredItems' (sole card on screen; M1.11 already deleted its sibling hint by the same reasoning)
- ConfirmPage.tsx:222-225 â€” 'decided/total' fraction in the MainButton label (decidedCount â‰¡ myItems.length at 179-180; fake progress)
- ConfirmPage.tsx:324-384 â€” the resting 4-chip ChipBar (ok chip either no-ops or silently destroys a note; the 3 issue chips move into the sheet's segmented choice)
- packages/ui/src/components/Chip.tsx:13,38 â€” role=tablist/tab semantics when used as a value choice â†’ radiogroup/radio (primitive-level fix, benefits every screen)

**Interactions.** Happy path = ZERO row taps + 1 MainButton tap + 1 sheet confirm (default-ok semantics already work this way at 179/306 â€” this is a pure UI change, no data-model migration). Exception path = tap 'æœ‰é—®é¢˜' â†’ sheet â†’ pick type â†’ number (short) or text (wrong/quality) â†’ optional photo â†’ footer Save; sheet stays pinned during in-flight save (443). Reverting an issue to ok now requires a discard-confirm when a note/photo would be destroyed (today's silent data-loss footgun at 343-365, amplified by any bigger tap target). Optimistic chip-paint pipeline (109-127, the quadruple-event fix) and offline replay (67-80) are preserved verbatim under the new affordance. Deliver/Recall (purchaser side): keep 2-tap confirms; recall gains its visible ghost affordance on delivered-unconfirmed rows (see Run blueprint).

**Implementation.** Order: (1) delete inline button + header + fraction (three independent zero-risk cuts); (2) exception-only row conversion â€” the big one: resting row loses the ChipBar, gains the trailing affordance; the issue sheet gains the segmented status choice (statuses were formerly picked by chip tap); (3) received-qty input for short + auto-composed note; (4) photo/note evidence rendered back on issue rows; (5) confirmStore ConfirmSheet + ok-discard-confirm; (6) Chip primitive semantics fix. Risks: do NOT introduce an 'unreviewed' null status â€” that is a data-model + API change (allDecided at 179, MainButton gate at 226-227, run.confirmStoreItem contract); the blueprint deliberately keeps default-ok semantics. Whole-row tap stays unassigned (no tap-to-ok â€” conflicts with reading notes; tap grammar: row body inert, 'æœ‰é—®é¢˜' opens sheet).

### RunHistory + Finance (owner/manager reading surfaces)

**Anatomy.** RunHistorySection (Run tab, inline): month group header 'YYYY-MM Â· åˆè®¡ X UZS' (the daily calendar-ledger read, kept) â†’ settlement rows (12-row cap) â†’ 'View all' header link â†’ RunHistoryPage (header meta 'N Â· total UZS', same rows + per-store sub-buttons deep-linking initialStoreId) â†’ RunHistoryDetailSheet: headline total text-h2 15px mono semibold + bought/NA counts + cash/transfer breakdown row (only when mixed, BOTH figures, i18n text) + store filter pills (the strict-per-store mandate, untouched) + per-item rows [name | mono line total or NA text tag] + muted 'qty Ã— price' spot-check line + split data as muted mono text (multi-store all-view only) + per-store settlement list [store | unique-SKUs Â· expenses n+total | mono total | cashÂ·transfer when mixed]. FinanceSection: preset Segmented (today/yesterday/thisMonth/lastMonth/custom) + resolved 'start â†’ end' text â†’ SCORECARD as a content block (L3 exemption): çŽ°é‡‘ / è½¬è´¦ / åˆè®¡ columns, text-h2 mono semibold, FULL DIGITS, 'N ç¬”/N æ¬¡é‡‡è´­' muted sub-labels kept â†’ view Segmented æŒ‰æ—¥/æŒ‰ä¾›åº”å•†/æŒ‰é—¨åº— + quiet 'å¤åˆ¶ä¸º TSV' text button â†’ single-open accordion groups [date-or-name | mono group total] + 'cash X Â· transfer Y' sub-line when mixed â†’ expanded lines single-line 11px [sku Â· store Â· supplier Â· qty Ã— price | mono amount]. NO MainButton anywhere on these screens â€” the ~64px reserve returns to content (1-2 extra rows per viewport).

**Work row.** SETTLEMENT/READING ROW variant: [primary 13px = date (+ conditional '#N' runIndex) or store/supplier name] | right slot = mono tabular total, min-w-[9ch], right-aligned â€” the amount moves INTO the right slot freed by the deleted constant badge; line 2 (only when mixed) 'cash X Â· transfer Y' as i18n text 11px; line 3 per-store totals as ONE muted mono text line 'StoreA 120,000 Â· StoreB 80,000' (data kept, N ring-bordered pills deleted). Deepest finance drill lines are EXEMPT from full NameCell anatomy â€” single-line 11px + mono right slot is already terminal-correct; forcing two-line anatomy would reduce density on the most-scanned drill level. Expand affordance = row tap, max two levels, never disclosure on the money itself.

**Deletions.**
- RunPage.tsx:6777 and 6874 â€” Badge tone='success' {r.status} on every history row (lists are pre-filtered to finished at 6633-6634: a constant green chip with an untranslated raw enum; the freed right slot takes the mono total)
- RunPage.tsx:6788-6792 (+ i18n key run.history.viewAllHint, zh.ts:706) â€” truncation footer pointing at ç®¡ç†â†’è¿è¥â†’æäº¤åŽ†å², which is ORDER-submission history, not run history; 'View all' four lines up is the real path
- RunPage.tsx:6761-6771 â€” pill/ring chrome on per-store total chips â†’ one muted mono text line
- RunPage.tsx:6749-6750, 7229-7237, 7422-7423 â€” ðŸ’µ/ðŸ¦ glyphs in mixed-split and settlement lines â†’ run.label.paymentCash/paymentTransfer i18n text (both NUMBERS stay â€” L4-display aggregate rule)
- AdminPage.tsx:7297, 7308, 7319 â€” ðŸ’µ/ðŸ¦/Î£ prefixes in scorecard SectionLabels (localized words already present); 7357 â€” ðŸ“‹ on export; 7421, 7509 â€” ðŸª in byStore headers/metas
- AdminPage.tsx:7413, 7479, 7533 â€” per-line ðŸ’µ cash prefixes (single-method LINE rows: cash silent, transfer gets the bare text tag)
- AdminPage.tsx:6254, 6267, 6305, 6311, 6320, 6339 â€” HistorySection hardcoded English â†’ i18n.t (audience is zh owner + ru/uz managers); the status WORD badge on these rows STAYS (approved/in_run/archived collapse to one success tone at 6276-6281 â€” text is the only disambiguator)
- AdminPage.tsx:7242-7248 â€” broken export failure path: toast says 'check console' but the console.log was deleted; add a textarea select-copy fallback or fix the string

**Interactions.** All read-only: 1-tap preset switch, 1-tap pivot (expansion resets on pivot â€” correct), 1-tap single-open accordion, 1-tap detail sheet with lazy run.get, 1-tap store filter pill / deep-link. Export stays a quiet inline secondary (weekly cadence â€” never promoted to a button bar). K-abbreviation is forbidden on every figure here: reconciliation is against bank statements, the TSV emits raw values, and on-screen digits must match the export exactly; the zh owner's ä¸‡-based arithmetic collides with K.

**Implementation.** Cheapest whole-flow win in the redesign â€” almost entirely deletions and text swaps on existing Card/SectionLabel primitives. Order: (1) two badge deletions + total-to-right-slot (aligns both history lists with L2/L4 in two edits); (2) wrong-hint deletion; (3) emoji sweep + i18n localization batch; (4) pillâ†’text restyle; (5) export fallback fix. The settlement/reading row can be extracted as a shared component AFTER the edits prove the layout, and adopted later by HistorySection cards. Do not restructure FinanceSection's picker+scorecard+switcher stack to satisfy naive L3 â€” the scorecard IS the answer to the owner's daily question (L3 reading-screen carve-out).

### AdminPage home + Operations + SettingsSheet

**Anatomy.** Admin home menu: the existing 5 section rows (Organization / Stores / Roles & Permissions / Catalog / Operations) PLUS two promoted rows â€” Finance and Price report â€” added directly to the home <ul> (AdminPage.tsx:300-335) so both daily money checks drop from 3 taps to 2; the Operations copies remain until a navStore enum migration is written (persisted opsSub state must never point at a deleted view). OperationsHome reordered by usage: Finance first, then Price report, History, Activity, Audit, Maintenance â€” with the repeated IconActivity deleted (icon column dropped or differentiated). Section titles lose their ðŸŒ/ðŸª emoji prefixes. Workspace card de-duplicated (finance ListRow hint dies; DetailRows stay). Member cards: avatar+name+@username+last-seen stay; 'active' badge deleted (suspended-only per L1 silent-default); role chips become INERT displays; Revoke moves into the existing â‹¯ overflow sheet. Roles list: 'grantable' badge deleted (only the blocking 'your rank â‰¤ this' case renders); the always-on 'How permissions work' banner collapses behind a one-line disclosure. SettingsSheet: 4 section-header emoji and the trailing Cancel button deleted; About block stays (bug-report info).

**Work row.** CRUD-ROW variant (Admin's own anatomy â€” the task-list WORK ROW misfits two-action editors): [NameCell primary 13px + meta line] | right slot = visible Edit text action (NOT overflow â€” the weekly SKU loop cannot afford an extra tap per the hundreds-of-SKUs mandate), with Archive staying danger-ghost in the row footer strip. Reading rows in Activity/History/Audit adopt the settlement/reading row where money appears, and keep literal status words wherever tones collapse (HistorySection). Recent-events rows gate 'seq N' + raw 'streamType.Type' labels behind isSuperAdmin, reusing the exact gate already applied to audit inputs JSON at 6880; audit rows gate the 8-char resourceId hash the same way.

**Deletions.**
- AdminPage.tsx:402, 408, 414, 421, 429 â€” identical IconActivity on 5 OperationsHome rows
- AdminPage.tsx:349-350 â€” ðŸŒ/ðŸª emoji prefixes in titleForSection
- AdminPage.tsx:919-921 and 3493-3495 â€” 'active' status badges on members and stores (render only suspended/paused)
- AdminPage.tsx:1350-1356 â€” 'grantable' badge on role rows
- AdminPage.tsx:957-978 â€” role-chip tap-to-revoke (the cheapest destructive gesture in the app; moves into the â‹¯ sheet at 1138-1241; chips become inert)
- AdminPage.tsx:613-617 â€” finance ListRow hint duplicating the currency/tax DetailRows at 594-601
- AdminPage.tsx:6160-6186 (partial) â€” 'seq N' + raw event keys for non-super-admins (gate, not delete)
- AdminPage.tsx:6856-6860 (partial) â€” audit resourceId UUID slice for non-super-admins (gate)
- AdminPage.tsx:1308-1313 and 6970-6975 â€” permanent explainer banners â†’ one-line disclosure
- AdminPage.tsx:3265 â€” hidden i18n-linter span shipped in GrantRoleSheet DOM
- AdminPage.tsx:390 â€” stale '3 day-to-day tools' comment on a 6-row menu
- SettingsSheet.tsx:366-370 â€” trailing Cancel button (sheets dismiss via scrim/back); SettingsSheet.tsx:153, 204, 251, 334 â€” section-header emoji ðŸ‘¤ðŸŒðŸªâ„¹ï¸

**Interactions.** Finance check: 2 taps from Admin home (was 3 through a same-icon menu). Telegram BackButton keeps popping exactly one level; navStore persistence (M3.16-B) untouched â€” new home rows ADD enum values, never rename existing ones. Grant role keeps its good 2-tap+3-pick sheet. Revoke: â‹¯ â†’ sheet â†’ confirm (was: one accidental chip tap). Permission-override matrix keeps MORE visible state, not less â€” the 'from role' baseline badge stays out of any disclosure, and each Segmented tap still fires live (add an undo toast if budget allows; never hide the baseline). Maintenance's dry-run â†’ preview â†’ typed-slug pipeline is exempt from every density rule â€” each element there is a fence. Multi-creator screens (+ New store, + New SKU, Invite) confirm the no-single-MainButton stance for Admin; sheets keep their own footers (they stack two deep here).

**Implementation.** This is chrome surgery on one 7,852-line file â€” batch by mechanism, not by screen: (1) find/replace tier: emoji sweep, badge deletions, icon deletion, comment fix, hidden-span removal; (2) gating tier: reuse the 6880 isSuperAdmin pattern twice; (3) behavior tier: role-chip inerting + Revoke relocation (test the confirm path), bannerâ†’disclosure collapses; (4) IA tier: two home rows + OperationsHome reorder (pure list edits; navStore-safe because values are added, not renamed); (5) i18n tier: route Stores/Permissions/Maintenance hardcoded English through i18n.t â€” the flow's owner reads Chinese. Inventory stocktake / Sales recording relocation OUT of Admin (4-5 taps deep, wrong tab for store managers) is flagged as a follow-up IA project â€” it needs a nav-tab decision, not a blueprint line.

### Shell / nav (chrome)

**Anatomy.** Top: no in-app header inside Telegram (unchanged; 'Compass'+orgName fallback renders only outside Telegram) â†’ content viewport â†’ PageMainButton bar (in-DOM, above nav): renders ONLY when the active page declares a primary action â€” Order (Review), Confirm (ç¡®è®¤æ”¶è´§), Run (phase transitions when actionable); reading pages (Finance, histories) declare none and the ~64px reserve collapses into content per L3 â†’ bottom nav: 5 permission-filtered tabs (orderâ†’approveâ†’runâ†’confirmâ†’admin, pipeline order), icon + localized label, active = accent + semibold, anchored at ALL times â€” the owner's non-negotiable; the native Telegram MainButton stays permanently hidden (M3.49) and no code path may un-hide it again once QtyControl's rival consumer is deleted.

**Work row.** n/a â€” chrome. The PageMainButton bar is the codified 'one accent role' slot at page level: one label, one action, hidden rather than disabled when no action applies (the existing hide-until-actionable pattern on Run is the reference). Nav tabs keep the 0.5-opacity + pointer-events-none in-flight mutation guard (M3.50 race fix) â€” it is the affordance, not decoration.

**Deletions.**
- No Shell.tsx deletions â€” Shell is the system the redesign standardizes ON; the deletions live in its clients: OrderPage.tsx:829-840 (dead fallback CTA), QtyControl.tsx:462-526 (last native-MainButton consumer), ConfirmPage.tsx:392-419 (inline CTA duplicate)
- Shell.tsx:463-512 gains one behavior, not a deletion: the reserve renders nothing (no spacer) when the active page declares no primary action â€” reclaiming 1-2 data rows on every reading screen

**Interactions.** Tab switch = 1 tap, persisted across sessions with permission-loss fallback (Shell.tsx:144-154, untouched). Settings via Telegram gear â†’ SettingsSheet (1 tap, zero layout cost, untouched). Optional nicety: re-tapping the Admin tab while inside a drill resets navStore to Admin home (a shortcut on top of one-level BackButton popping, which stays predictable). Sheets everywhere render above the PageMainButton bar and therefore always own their footer CTA â€” this is the L3 law that prevents re-shipping the M3.49 regression, and Shell is where it is enforced by construction.

**Implementation.** Shell changes are deliberately minimal and LAST in the migration: every page-level blueprint above must first converge on 'declare your primary action or declare none' before the conditional-reserve change lands, otherwise reading pages jump. Order of operations across the whole redesign: (1) dead-code + emoji + badge deletion batch (all screens, zero behavior risk); (2) text-tag/pill conversions + i18n batch; (3) row-variant work per screen (picker/input/dense/settlement/CRUD recipes on the existing Row/NameCell/QtyControl primitives â€” no new primitive until two screens prove a recipe); (4) behavioral upgrades (Confirm exception-only rows, Reject chips, discard-confirms, deviation tags, hit-area pass); (5) Shell conditional reserve + Admin IA rows. Global invariants that survive everything: bottom nav anchored, native MainButton dead, sheet footers sovereign, SkuRow memo contract, offline/optimistic pipelines byte-identical, K suffixes on entry fields, full digits on ledgers, and no color-only information anywhere a purchaser stands in the sun.

## Execution order (global)

1. **B1 Deletion batch** — dead code, constant badges, decorative chrome (zero behavior risk).
2. **B2 Text & i18n batch** — emoji→i18n text tags, pill→bare-text restyles, hardcoded zh/en → i18n.t.
3. **B3 Row recipes** — picker/dense/input/settlement/CRUD row variants on existing primitives
   (no new primitive until two screens prove a recipe).
4. **B4 Behavioral upgrades** — Confirm exception-only rows, Reject reason chips, discard-confirms,
   L11 deviation tags, L9 hit-area pass.
5. **B5 Chrome & IA** — Shell conditional MainButton reserve, Admin home Finance/Price-report rows.

Global invariants: bottom nav anchored; native MainButton dead; sheet footers sovereign;
SkuRow memo contract; offline/optimistic pipelines byte-identical; K suffixes stay on entry
fields; full digits on ledgers; no color-only information on purchaser surfaces.

*NOTE: file:line citations were taken against main@9aacc15 by the analysis agents; verify each
against current code before cutting — some cite pre-split AdminPage line numbers whose content
now lives in pages/admin/*.*


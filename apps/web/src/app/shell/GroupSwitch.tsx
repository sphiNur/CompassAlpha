/**
 * Owner 2026-11-23: the switch between the tabs of one group (下单 | 验收,
 * 采购 | 历史), at the top of the page. The bar has one item for the group
 * (tabGroups.ts); this is how the person moves inside it. A member with
 * something waiting (goods to receive, orders to buy) carries its count.
 *
 * Each option is the member's own tab, so a switch goes through the same
 * guards as a tap on the bar (an unsaved form asks first), and the page
 * title, deep links and the saved tab name the member.
 */
import { Segmented } from '@compass/ui';
import { useI18n } from '../../hooks/useI18n';
import type { NavBadge } from '../../lib/navBadges';
import { NAV_BADGE_COUNT_CLASS, navBadgeCountText } from '../../lib/navBadgeLook';
import type { Tab } from '../../stores/navStore';
import type { TabDef } from './tabs';

export function GroupSwitch({
  members,
  tab,
  badges,
  onSelect,
}: {
  /** The group's visible tabs, in the switch's order. */
  members: readonly TabDef[];
  tab: Tab;
  badges: Partial<Record<Tab, NavBadge>>;
  onSelect: (tab: Tab) => void;
}) {
  const i18n = useI18n();
  return (
    <div className="px-4 pt-3" data-testid="group-switch">
      <Segmented<Tab>
        value={tab}
        ariaLabel={i18n.t('nav.group.switchAria')}
        controls="main-content"
        onChange={(next) => {
          if (next !== tab) onSelect(next);
        }}
        options={members.map(({ key, labelKey }) => {
          const badge = badges[key];
          const label = i18n.t(labelKey);
          return {
            value: key,
            label: (
              <span data-testid={`group-${key}`} className="inline-flex items-center gap-1.5">
                {label}
                {typeof badge === 'number' ? (
                  <span
                    aria-label={i18n.t('nav.badge.count', { label, n: badge })}
                    className={`${NAV_BADGE_COUNT_CLASS} border-0`}
                  >
                    {navBadgeCountText(badge)}
                  </span>
                ) : null}
              </span>
            ),
          };
        })}
      />
    </div>
  );
}

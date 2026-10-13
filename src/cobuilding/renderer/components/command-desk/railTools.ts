/**
 * Which tools the rail lists, and under which heading.
 *
 * - "Pinned tools": every active tool the user pinned, in the order they were
 *   pinned, so a new pin never reshuffles the others. Always shown.
 * - "Recent tools": the most recently opened active tools that are not
 *   pinned. A tool that was never opened is not recent, so it is left out
 *   rather than padding the list.
 *
 * Archived tools appear in neither: they live only in the Tools page's
 * Archived section, and keep their pin for when they are restored.
 */

export interface RailTool {
  dirName: string;
  name: string;
  icon: string | null;
}

export interface RailToolSource extends RailTool {
  lastOpened: string | null;
  archived: boolean;
  pinned: boolean;
  pinnedAt: string | null;
}

export const RECENT_TOOLS_LIMIT = 3;

const time = (iso: string | null): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

const toRailTool = ({ dirName, name, icon }: RailToolSource): RailTool => ({ dirName, name, icon });

export function railToolLists(apps: readonly RailToolSource[]): { pinned: RailTool[]; recent: RailTool[] } {
  const active = apps.filter((a) => !a.archived);

  const pinned = active
    .filter((a) => a.pinned)
    // A pin without a readable time sorts last; ties fall back to the name so
    // the order never depends on directory listing order.
    .sort((a, b) => (time(a.pinnedAt) || Infinity) - (time(b.pinnedAt) || Infinity) || a.name.localeCompare(b.name))
    .map(toRailTool);

  const recent = active
    .filter((a) => !a.pinned && time(a.lastOpened) > 0)
    .sort((a, b) => time(b.lastOpened) - time(a.lastOpened) || a.name.localeCompare(b.name))
    .slice(0, RECENT_TOOLS_LIMIT)
    .map(toRailTool);

  return { pinned, recent };
}

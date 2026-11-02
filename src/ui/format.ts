/**
 * Date formatting for server-rendered pages.
 *
 * Fixed to a written month and UTC rather than `toLocaleDateString()`: the
 * Worker's locale is not the reader's, and "9/2/2026" is 2 September to most
 * of the world and 9 February to the rest. "Sep 2, 2026" reads one way.
 */
const DATE = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** "Sep 2, 2026"; an unparseable value is shown verbatim, as evidence of what is stored. */
export function formatDate(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : DATE.format(parsed);
}

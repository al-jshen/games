/**
 * How a move's timestamp is written in the log.
 *
 * Pulled out of the component so the branch below can be tested against a fixed "now" — it is the
 * kind of logic that only misbehaves at a date boundary, which is exactly when nobody is looking.
 *
 * Formatting is delegated to the browser's locale rather than hard-coded, so 24-hour clocks and
 * day-before-month come out right without being asked.
 */

/** Epoch ms that could plausibly be a timestamp. Guards against a malformed or absent field. */
export function isRealTimestamp(at: number): boolean {
  return Number.isFinite(at) && at > 0;
}

/**
 * The short label shown beside a move or a message.
 *
 * Moves get seconds: turns in a duel are often seconds apart, and a log where three of them all say
 * "2:07 PM" cannot tell you what order they happened in — which is most of what a log is for.
 * Messages do not, because their order is plain from where they sit and the sidebar is only 250px
 * wide, where eight characters of timestamp is real estate taken from what somebody said.
 *
 * Anything from another day shows its date instead of its time. The column is narrow and a full
 * date-and-time would not fit; the exact moment is one hover away in `fullMoveTime`, and knowing
 * *which day* matters more at a glance than knowing the second, now that a match can be put down
 * and picked up a week later.
 */
export function moveTimeLabel(at: number, now: Date = new Date(), withSeconds = true): string {
  const when = new Date(at);
  const sameDay =
    when.getFullYear() === now.getFullYear() &&
    when.getMonth() === now.getMonth() &&
    when.getDate() === now.getDate();
  if (!sameDay) return when.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return when.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  });
}

/** The whole thing, for the tooltip: date and time to the second, however the locale writes it. */
export function fullMoveTime(at: number): string {
  return new Date(at).toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
}

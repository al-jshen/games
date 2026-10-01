import { GEM_COLORS, type SplendorView } from '@games/splendor-duel';

/**
 * A view with the things that are orderings rather than facts put in one order, and the two fields
 * BGA has no counterpart for (and the network never sees) blanked.
 *
 * Translating a BGA snapshot back has to give our own redaction "modulo" exactly this, and this is
 * the complete list: four orderings, two fields.
 */
export function canonical(view: SplendorView): unknown {
  const royals = view.royals.filter((r): r is string => r !== null).sort();
  return {
    ...view,
    // No stall rule on BGA, and neither field is an input to the encoder or to legality.
    options: {},
    turnsWithoutPurchase: 0,
    // Which table slot a royal sits in is arbitrary on both sides.
    royals: [...royals, ...new Array<null>(4 - royals.length).fill(null)],
    players: view.players.map((p) => ({
      ...p,
      stacks: [...p.stacks].sort((a, b) => GEM_COLORS.indexOf(a.color) - GEM_COLORS.indexOf(b.color)),
      reserved: [...p.reserved].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      royals: [...p.royals].sort(),
      colorless: [...p.colorless].sort(),
    })),
  };
}

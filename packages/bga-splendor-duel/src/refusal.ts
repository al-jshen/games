/**
 * Why the adapter stopped.
 *
 * Every layer returns one of these as a value instead of throwing or guessing. The rule they exist
 * to enforce: when our picture of the table and BGA's might differ, the bot does not move. A person
 * finishes the game, and the snapshot that caused the stop is kept so it can become a test.
 */
export type RefusalReason =
  /** The page did not hand over the shape we read. BGA changed, or the page was not a game. */
  | 'bad-snapshot'
  /** The Counterfeiters expansion, which our engine does not model. */
  | 'expansion'
  /** The logged-in account is not seated at this table. */
  | 'spectator'
  | 'not-our-turn'
  /** A BGA state with no translation. */
  | 'unknown-state'
  /** Half-way through something that is a single action to us. Finish or cancel it. */
  | 'mid-action'
  /** A colour, cell or card BGA named that we have no word for. */
  | 'unmapped'
  /** The snapshot contradicts itself, or cannot be a position of this game. */
  | 'inconsistent'
  /** Our rules and BGA's allow different moves here. */
  | 'disagreement'
  /** BGA turned down a move we submitted. */
  | 'refused'
  /**
   * The page could not be read, or is no longer the table that was vetted. Also where an error
   * thrown anywhere in the loop ends up, with its message, so that it stops the game cleanly.
   */
  | 'page-error';

export interface Refusal {
  reason: RefusalReason;
  detail: string;
}

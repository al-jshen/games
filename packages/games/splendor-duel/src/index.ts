import type { GameModule, Outcome, Seat } from '@games/engine';
import { apply } from './apply.js';
import { legalActions, validate } from './legal.js';
import { applyToView, legalActionsFromView } from './predict.js';
import { redactEffect, redactFor } from './redact.js';
import { actionValidator, optionsValidator } from './schema.js';
import { setup } from './setup.js';
import { totalPoints } from './score.js';
import type { SplendorAction, SplendorOptions, SplendorState, SplendorView } from './types.js';

function outcome(state: SplendorState): Outcome {
  if (state.stage !== 'over') return { status: 'active' };
  const scores = [totalPoints(state.players[0]), totalPoints(state.players[1])];
  return {
    status: 'over',
    winners: state.winner === null ? [] : [state.winner],
    reason: state.winReason ?? 'over',
    scores,
  };
}

export const splendorDuel: GameModule<SplendorState, SplendorAction, SplendorView, SplendorOptions> = {
  id: 'splendor-duel',
  stateVersion: 1,
  meta: {
    title: 'Splendor Duel',
    blurb: 'Two-player gem duel. Race to 20 prestige, 10 crowns, or 10 points in one colour.',
    minPlayers: 2,
    maxPlayers: 2,
    estMinutes: [20, 35],
  },
  actionValidator,
  optionsValidator,
  setup,
  currentActors(state) {
    return state.stage === 'over' ? [] : [state.turn];
  },
  legalActions,
  isLegal(state, seat: Seat, action) {
    return validate(state, seat, action);
  },
  apply,
  outcome,
  redactFor,
  redactEffect,
  applyToView,
  legalActionsFromView,
};

export default splendorDuel;

export * from './types.js';
export { CARD_DEFS, card, tryCard, jewelDeck, royalIds } from './cards.js';
export { SPIRAL, CENTER_CELL, ALL_LINES, availableTokenLines, isLegalTokenLine } from './spiral.js';
export {
  bonuses,
  colorPoints,
  effectiveCost,
  costTotal,
  minimalPayment,
  tokenTotal,
  totalCrowns,
  totalPoints,
  victoryFor,
  purchasedJewels,
  emptyTokens,
} from './score.js';
export { legalActions, validate, overTokenLimit } from './legal.js';
export { redactFor, redactEffect, secretsFor } from './redact.js';
export { setup } from './setup.js';
export { apply } from './apply.js';
export { applyToView, legalActionsFromView } from './predict.js';
export { zSplendorAction, zSplendorOptions } from './schema.js';

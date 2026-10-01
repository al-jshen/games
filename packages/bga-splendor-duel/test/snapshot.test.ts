import { setup } from '@games/splendor-duel';
import { describe, expect, it } from 'vitest';
import { buyableIds, parseSnapshot, zPlayActionArgs } from '../src/snapshot.js';
import { stateKind } from '../src/states.js';
import { PLAYER_ID, synthSnapshot } from './support/synth.js';
import { walk } from './support/play.js';

/**
 * The schema is the adapter's only defence against BGA changing shape under it. Anything it lets
 * through is treated as the position on the table, so what it must not do is let through something
 * it half-understands.
 */

const opening = () => setup({ seed: 'snapshot', seats: [0, 1], options: {} });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('the snapshot schema', () => {
  it('accepts every position of a whole game, from either seat', () => {
    let checked = 0;
    walk('snapshot-walk', 250, (state) => {
      for (const viewer of [0, 1] as const) {
        const parsed = parseSnapshot(clone(synthSnapshot(state, viewer)));
        expect(parsed.ok, parsed.ok ? '' : parsed.refusal.detail).toBe(true);
        checked += 1;
      }
    });
    expect(checked).toBeGreaterThan(100);
  });

  it('turns the numeric strings BGA sends into numbers', () => {
    const parsed = parseSnapshot(clone(synthSnapshot(opening(), 0)));
    if (!parsed.ok) throw new Error(parsed.refusal.detail);
    const ids = Object.values(parsed.snapshot.gamedatas.players).map((p) => p.id);
    expect(ids.sort()).toEqual([...PLAYER_ID]);
    expect(typeof parsed.snapshot.gamestate.active_player).toBe('number');
  });

  it('refuses a snapshot with a part missing, and says which', () => {
    const raw = clone(synthSnapshot(opening(), 0)) as { gamedatas: Record<string, unknown> };
    delete raw.gamedatas.board;
    const parsed = parseSnapshot(raw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusal.reason).toBe('bad-snapshot');
    expect(parsed.refusal.detail).toContain('gamedatas.board');
  });

  it('refuses a field of the wrong type rather than coercing it', () => {
    const raw = clone(synthSnapshot(opening(), 0)) as { gamedatas: { board: { id: unknown }[] } };
    (raw.gamedatas.board[0] as { id: unknown }).id = 'twelve';
    expect(parseSnapshot(raw).ok).toBe(false);
    expect(parseSnapshot(null).ok).toBe(false);
    expect(parseSnapshot('gamedatas').ok).toBe(false);
  });
});

describe('state arguments', () => {
  it('reads buyable cards whether PHP sent a map or an empty list', () => {
    const base = { privileges: 0, canRefill: false, mustRefill: false, canTakeTokens: true, canReserve: true, canBuyCard: false };
    expect(buyableIds(zPlayActionArgs.parse({ ...base, buyableCards: [] }))).toEqual([]);
    expect(buyableIds(zPlayActionArgs.parse({ ...base, buyableCards: { 12: [{}], 40: [{}] } }))).toEqual([12, 40]);
  });
});

describe('state names', () => {
  it('sorts the states this adapter knows from the ones it does not', () => {
    for (const name of ['playAction', 'takeBoardToken', 'takeOpponentToken', 'takeRoyalCard', 'discardTokens']) {
      expect(stateKind(name)).toBe('decision');
    }
    for (const name of ['usePrivilege', 'reserveCard', 'placeJoker']) expect(stateKind(name)).toBe('mid-action');
    expect(stateKind('gameEnd')).toBe('over');
    // Expansion states and anything BGA adds later.
    expect(stateKind('beforeEndTurn')).toBe('unknown');
    expect(stateKind('takeCounterfeiterCard')).toBe('unknown');
  });
});

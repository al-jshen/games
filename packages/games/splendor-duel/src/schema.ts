import type { Validator } from '@games/engine';
import { z } from 'zod';
import type { SplendorAction, SplendorOptions } from './types.js';
import { BOARD_CELLS, GEM_COLORS, PAY_COLORS } from './types.js';

const zCell = z.number().int().min(0).max(BOARD_CELLS - 1);
const zLevel = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const zGem = z.enum(GEM_COLORS as [string, ...string[]]);
const zPay = z.enum(PAY_COLORS as [string, ...string[]]);

/**
 * A sparse `{colour: count}` purse; absent keys mean zero.
 *
 * Spelled out as an optional-per-key object rather than `z.record(z.enum(...), ...)`, because in
 * zod 4 a record keyed by an enum is *exhaustive* — it requires every colour to be present. That
 * silently rejected every real purchase and discard while unit tests, which call the reducer
 * directly and skip the validator, all passed.
 */
const zPurse = z
  .object({
    white: z.number().int().min(0).optional(),
    blue: z.number().int().min(0).optional(),
    green: z.number().int().min(0).optional(),
    red: z.number().int().min(0).optional(),
    black: z.number().int().min(0).optional(),
    pearl: z.number().int().min(0).optional(),
    gold: z.number().int().min(0).optional(),
  })
  .strict();

const zCardRef = z.discriminatedUnion('t', [
  z.object({ t: z.literal('pyramid'), level: zLevel, slot: z.number().int().min(0).max(4) }),
  z.object({ t: z.literal('reserved'), cardId: z.string().min(1).max(16) }),
]);

export const zSplendorAction = z.discriminatedUnion('t', [
  z.object({ t: z.literal('usePrivilege'), cell: zCell }),
  z.object({ t: z.literal('replenish') }),
  z.object({ t: z.literal('takeTokens'), cells: z.array(zCell).min(1).max(3) }),
  z.object({
    t: z.literal('reserve'),
    goldCell: zCell,
    from: z.discriminatedUnion('t', [
      z.object({ t: z.literal('pyramid'), level: zLevel, slot: z.number().int().min(0).max(4) }),
      z.object({ t: z.literal('deck'), level: zLevel }),
    ]),
  }),
  z.object({
    t: z.literal('purchase'),
    from: zCardRef,
    payment: zPurse,
    wildColor: zGem.optional(),
  }),
  z.object({ t: z.literal('chooseMatchingToken'), cell: zCell }),
  z.object({ t: z.literal('chooseSteal'), color: zPay }),
  z.object({ t: z.literal('chooseRoyal'), royalId: z.string().min(1).max(16) }),
  z.object({ t: z.literal('discard'), tokens: zPurse }),
  z.object({ t: z.literal('pass') }),
]);

export const zSplendorOptions = z.object({
  maxTurnsWithoutPurchase: z.number().int().min(0).max(1000).optional(),
});

function adapt<T>(schema: z.ZodType<unknown>): Validator<T> {
  return {
    validate(input: unknown) {
      const parsed = schema.safeParse(input);
      if (parsed.success) return { ok: true, value: parsed.data as T };
      const issue = parsed.error.issues[0];
      const path = issue?.path.join('.') ?? '';
      return { ok: false, error: `${path ? `${path}: ` : ''}${issue?.message ?? 'invalid'}` };
    },
  };
}

export const actionValidator: Validator<SplendorAction> = adapt<SplendorAction>(zSplendorAction);
export const optionsValidator: Validator<SplendorOptions> = adapt<SplendorOptions>(
  zSplendorOptions.default({}),
);

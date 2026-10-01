import { describe, expect, it } from 'vitest';
import { FakeTable } from '../../../packages/bga-splendor-duel/test/support/fakeTable.ts';
import { introduce } from '../session.mjs';

/**
 * How every command that sits at or watches a table begins: one look at the table, and a line per
 * player saying who they are and what they are rated. `watch` and `advise` both start here, so what
 * one of them reads at a live table, the other reads the same way.
 */

async function intro(table) {
  const said = [];
  const result = await introduce({ table, say: (line) => said.push(line) });
  return { result, text: said.join('\n') };
}

describe('introduce', () => {
  it('says who is at the table and what each is rated, from the stands', async () => {
    const { result, text } = await intro(new FakeTable('intro-watch', null));
    expect(result.ok).toBe(true);
    expect(result.seated).toBe(false);
    expect(text).toContain('Ann (seat 1) — rated 1510 — BGA player 1000');
    expect(text).toContain('Bob (seat 2) — rated 1640 — BGA player 2000');
    expect(text).not.toMatch(/you/);
  });

  it('says the same from a seat, and which one is ours', async () => {
    const { result, text } = await intro(new FakeTable('intro-seated', 1));
    expect(result.ok).toBe(true);
    expect(result.seated).toBe(true);
    expect(text).toContain('Ann (seat 1) — rated 1510 — BGA player 1000');
    expect(text).toContain('Bob (seat 2) — rated 1640 — BGA player 2000 — you');
  });

  it('hands back what it read, so nothing is read twice or differently later', async () => {
    const table = new FakeTable('intro-facts', 0);
    const { result } = await intro(table);
    expect(result.snapshot.me).toBe(1000);
    expect(result.facts.ratings).toEqual({ 1000: 1510, 2000: 1640 });
  });

  it('says so when a rating is not shown, or cannot be asked for at all', async () => {
    const hidden = new FakeTable('intro-hidden', null);
    hidden.facts = async () => ({ info: null, ratings: { 1000: null, 2000: 1640 } });
    expect((await intro(hidden)).text).toContain('Ann (seat 1) — rating not shown — BGA player 1000');

    const broken = new FakeTable('intro-broken', null);
    broken.facts = async () => {
      throw new Error('no such endpoint');
    };
    const { result, text } = await intro(broken);
    expect(result.ok).toBe(true);
    expect(result.facts).toEqual({ info: null, ratings: {} });
    expect(text).toContain('Ann (seat 1) — rating not shown — BGA player 1000');
    expect(text).toMatch(/could not ask BGA .*no such endpoint/);
  });

  it('refuses a page it cannot read', async () => {
    const table = new FakeTable('intro-garbled', null);
    table.snapshot = async () => ({ not: 'a game' });
    const { result } = await intro(table);
    expect(result.ok).toBe(false);
    expect(result.why).toMatch(/not the shape/);
  });
});

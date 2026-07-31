# Splendor Duel — the rules as implemented

The spec the reducer was written against. It resolves the places where sources disagree, and records
the two decisions the official rules leave open.

Sources: the official rulebook (English and French — the French is more precise in several places),
the BoardGameArena game-help wiki, and the BGG rulings threads. Where they conflict, the rulebook
wins.

> **Note on splendortactics.com**, which is where the card data comes from: its *rules* page has two
> errors. It says the level-3 deck goes at the bottom of the column (the rulebook says level 1), and
> it omits "gain a privilege" from its list of card abilities. Its *card* pages are accurate.

## Components

25 tokens: 4 each of white, blue, green, red, black; 2 pearl; 3 gold. 67 jewel cards (30 / 24 / 13).
4 royal cards. 3 privilege scrolls. A 5×5 board.

Totals the data generator asserts: **92** prestige on jewel cards, **9** on royals, **28** crowns,
**5** double-bonus cards (all level 2), **9** wild cards, **3** with no bonus (3, 5 and 6 prestige).

## Setup

1. Shuffle the three decks separately.
2. Reveal 5 level-1, 4 level-2 and 3 level-3 cards. Decks are left at 25 / 20 / 10.
3. Place **all 25 tokens** on the board from the centre outward along the spiral. **The bag starts
   empty**, so replenishing is impossible until tokens return to it.
4. First player is random; their opponent starts with 1 privilege scroll, leaving 2 above the board.

## Turn order — strict and enforced

1. *Optional, repeatable*: spend privilege scrolls. Each returns to the pool and takes one gem or
   pearl (never gold) from anywhere on the board — no adjacency rule.
2. *Optional, once*: replenish. Illegal with an empty bag. Fills empty spaces from the centre outward
   until the bag empties, then the **opponent** gains a scroll. **Scrolls may not be spent after
   replenishing** — encoded as a flag rather than trusted to the client.
3. *Mandatory*, exactly one of:
   - **Take up to 3 tokens.** 1–3 cells consecutive along a row, column, or either diagonal. Every
     cell in the run must hold a non-gold token: an empty space *or a gold token inside the run*
     makes it illegal, and you may not jump over either. Taking **3 of one colour** or **both
     pearls** gives the opponent a scroll; two of a colour gives nothing.
   - **Take 1 gold and reserve a card.** Illegal with no gold *on the board*, or with 3 already
     reserved. Then take a face-up card or the top of a deck. This is the only source of gold.
   - **Buy a card** from the pyramid or your reserve.
4. Resolve the bought card's abilities.
5. On crossing your **3rd** and again your **6th** crown, take a royal card and resolve it. Not an
   action. A single card carries at most 3 crowns, so one purchase can never cross both.
6. Discard down to **10** tokens, into the bag. Exceeding 10 mid-turn is legal.
7. Check victory. Then take any pending extra turn as a full fresh turn.

## Buying

`cost(colour) = max(0, printed − bonuses(colour))`. Discounts are **compulsory** and floor at zero —
you never gain tokens, and you cannot decline a discount to shed unwanted tokens. **There are no
pearl bonuses**, so pearls are paid with pearls or gold. Gold is wild for any gem or pearl. Spent
tokens go to the bag, which is what makes a later replenish possible.

Any valid split of the payment is accepted, including substituting gold for a gem you could have
paid — that is a real tactic (dumping gold, or protecting a gem from a steal).

## Card abilities

Mandatory, not optional: the rulebook is imperative throughout, and the only escape clauses are for
effects that are literally impossible, which are skipped rather than converted into something else.

| | Ability | Notes |
| --- | --- | --- |
| ↻ | Take another turn | A full new turn *after* this one ends — after the discard and the victory check. Chains. |
| ↓ | Take a matching token | Of this card's bonus colour, from the board only. No steal fallback, no substitute colour. Skipped if none. *Which* token is a real choice, since removing it changes future lines. |
| ✋ | Steal a token | A gem or pearl from the opponent. **Never gold.** Skipped if they hold only gold or nothing. |
| ✦ | Gain a privilege | From the pool; if empty, from the opponent; if you hold all 3, nothing happens. |
| ◈ | Wild ("associate") | See below. |

**Wild cards** are the fiddly ones, and every detail here is load-bearing:

- A hard **purchase precondition**, not a skippable effect: with no bonus card you cannot buy one at
  all.
- On purchase it joins a colour you already own and counts as that colour **permanently**.
- It grants exactly **one** bonus, even stacked on a double-bonus card.
- It may stack onto another already-assigned wild card, but never onto a no-bonus card or a royal.
- It does **not** copy the overlapped card's ability.
- One card — level 3, cost 8 red, 3 prestige — is wild **and** extra-turn, so abilities are a set.

**Royals**: 2 prestige + steal, 2 + extra turn, 2 + gain a privilege, 3 + nothing. No crowns, no
bonus colour.

## Victory

Checked **only at the end of your own turn**, after the discard. The game stops immediately; there is
no equalising turn and no draw.

1. **≥20 prestige**, counting jewel *and* royal cards.
2. **≥10 crowns**. Crowns only ever come from jewel cards.
3. **≥10 prestige within one bonus colour.** Wild cards count in their assigned colour. Royals and
   the three no-bonus cards have no colour and cannot contribute.

Points and crowns are only gained on your own turn and nothing ever removes them, so there is exactly
one winner.

## Two decisions the rules leave open

### Pyramid refill vs. ability resolution

Space Cowboys answered this two contradictory ways by email. BGG consensus is refill-first;
BoardGameArena implements ability-first. It is observable when an ability steals a token, grants an
extra turn, or when a royal is chosen from a display that may have just changed.

**We refill, then resolve** — rules-as-written, and the community reading. It is one code path in
`apply.ts`, in the `purchase` case.

### The spiral

Both rulebooks only say "starting with the central space and following the printed spiral", and the
spiral is art on the physical board, so no text source settles its orientation. Of five fan
implementations, three step *right* out of the centre and two step *up*.

**How much this matters, precisely.** Less than it first appears. Cell positions are used for exactly
two things: which cells form a takeable line, and the order the board refills. Line legality treats
rows, columns and both diagonals symmetrically, so it is invariant under all eight symmetries of the
square — and every valid outward square spiral is one of those eight symmetries applied to any other.
So two implementations that choose different orientations are playing relabellings of the same game,
and the popular disagreement (up versus down out of the centre) is exactly a 180 degree rotation.

`test/spiral-symmetry.test.ts` proves this rather than asserting it: it constructs all eight valid
spirals from scratch, shows that set is precisely the symmetry orbit of the one we ship, and shows the
set of legal token lines is invariant under each symmetry.

What the orientation *does* determine is whether the board on screen refills the way the printed one
does. That is cosmetic, but it is also cheap to get right, so it was measured rather than guessed.

**The measurement.** Each cell of the printed board carries a path segment. Detecting which of the
cell's four edges that segment touches recovers the undirected path; the centre has degree one, which
orients it. The result is self-checking: all 25 edge detections agree with their neighbours, there are
exactly two degree-one endpoints (the centre and the top-left corner), the walk covers all 25 cells
once, and the leg lengths are 1,1,2,2,3,3,4,4,4 — the signature of an outward square spiral. Getting
the geometry constants wrong fails one of those four checks rather than producing a plausible answer.

The answer is **centre, then up, then clockwise**:

```
24  9 10 11 12
23  8  1  2 13      SPIRAL = [12,7,8,13,18,17,16,11,6,1,2,3,4,
22  7  0  3 14                 9,14,19,24,23,22,21,20,15,10,5,0]
21  6  5  4 15
20 19 18 17 16
```

`npm run verify:spiral` re-derives it from the board art and fails if it disagrees with the constant
the engine ships. It caches the image under a gitignored directory rather than committing it, since
the artwork is not ours and only a handful of integers are needed from it.

## The position the rules do not cover

**A player can legally have no move at all**, and the usual argument that this cannot happen is
incomplete.

That argument goes: each player holds at most 10 tokens between turns, so board + bag ≥ 5; at most 3
are gold, so at least 2 non-gold tokens are always reachable and a one-token take is always legal.

It misses that **spending privileges legally takes you above 10 mid-turn**. Three scrolls means a
player can hold 13, so board + bag can fall to 2 — and both of those can be gold. If that player also
holds 3 reserved cards and cannot afford anything, they have no mandatory action, and replenishing is
impossible with an empty bag. Random play finds this within about 60 moves, so it is not a curiosity.

The rulebook offers no resolution, and the publisher has explicitly declined to add a draw, a turn
limit, or a stalemate rule. So this implementation adds a narrowly-scoped `pass` action, legal **only**
when no mandatory action and no replenish is available.

It provably unsticks itself, and not by a turn cap. Being stuck means at most 3 tokens are outside the
players' hands, so between them they hold at least 22 — both cannot be at or under 10, so at least one
is over the limit and *their* end-of-turn discard is forced. That discard goes to the bag, which makes
the next replenish legal and refills the board. Worst case is one pass each.

## Non-official option

`maxTurnsWithoutPurchase` (default **0**, meaning off). The official game cannot be forced to
terminate — a player who hoards the pearls and gold can loop indefinitely, and the publisher's
position is that this is a matter for tournament conduct rather than rules. Set a positive number to
end such a match; the winner is decided on prestige, then crowns, then a draw. Useful for self-play;
label it clearly if you enable it for human games.

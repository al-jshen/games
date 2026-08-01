import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Real-browser tests of the actual interface, against the production build served by the real server.
 *
 * Two independent browser contexts stand in for two people at two computers, which is the only way to
 * exercise the parts that matter: that a code typed into one browser lands you in the other's match,
 * that both boards update, and that a refresh gets you back into your seat.
 */

/** Open a fresh browser context, so the two players do not share localStorage or a session. */
async function openPlayer(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  (page as Page & { problems: string[] }).problems = problems;

  await page.goto('/');
  await expect(page.getByText('Connected')).toBeVisible();
  await page.getByLabel('Your name').fill(name);
  return page;
}

function problemsOf(page: Page): string[] {
  return (page as Page & { problems?: string[] }).problems ?? [];
}

/** Dismiss the first-run rules panel if it is showing. */
async function dismissHelp(page: Page): Promise<void> {
  const close = page.getByRole('button', { name: 'Close help' });
  if (await close.isVisible().catch(() => false)) await close.click();
}

/** Host a match in `host` and join it from `guest`; returns the room code. */
async function pairUp(host: Page, guest: Page, gameTitle: string): Promise<string> {
  await host
    .locator('.game-card', { has: host.getByRole('heading', { name: gameTitle }) })
    .getByRole('button', { name: 'Create match' })
    .click();

  await expect(host.getByText('Match code')).toBeVisible();
  const code = ((await host.locator('.code-display').textContent()) ?? '').trim();
  expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);

  // Type it the way a person would, in the other browser.
  await guest.getByLabel('Match code').fill(code.toLowerCase());
  await guest.getByRole('button', { name: 'Join' }).click();

  // Both sides must see two seated players before the match is really underway.
  await expect(host.locator('.players li')).toHaveCount(2);
  await expect(guest.locator('.players li')).toHaveCount(2);
  return code;
}

test.describe('lobby and pairing', () => {
  test('lists the games the server offers', async ({ browser }) => {
    const page = await openPlayer(browser, 'Ann');
    await expect(page.getByRole('heading', { name: 'Splendor Duel' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Tic-Tac-Toe' })).toBeVisible();
    await page.close();
  });

  test('a code from one browser lets the other into the same match', async ({ browser }) => {
    const host = await openPlayer(browser, 'Ann');
    const guest = await openPlayer(browser, 'Ben');
    const code = await pairUp(host, guest, 'Splendor Duel');

    // Each sees themselves marked, and the other not.
    await expect(host.locator('.players li', { hasText: 'Ann (you)' })).toBeVisible();
    await expect(host.locator('.players li', { hasText: 'Ben' })).toBeVisible();
    await expect(guest.locator('.players li', { hasText: 'Ben (you)' })).toBeVisible();

    // The URL becomes a shareable deep link.
    expect(host.url()).toContain(`/g/${code}`);
    await host.close();
    await guest.close();
  });

  test('rejects a code that does not exist, without breaking the page', async ({ browser }) => {
    const page = await openPlayer(browser, 'Ann');
    await page.getByLabel('Match code').fill('ZZZZZZ');
    await page.getByRole('button', { name: 'Join' }).click();
    await expect(page.getByText(/No match with code/)).toBeVisible();
    // Still usable afterwards.
    await expect(page.getByRole('heading', { name: 'Splendor Duel' })).toBeVisible();
    await page.close();
  });
});

test.describe('Splendor Duel board', () => {
  test('renders the board, and shows the rules panel to a first-time player', async ({ browser }) => {
    const host = await openPlayer(browser, 'Ann');
    const guest = await openPlayer(browser, 'Ben');
    await pairUp(host, guest, 'Splendor Duel');

    // The cheatsheet opens unprompted the first time.
    const help = host.getByRole('dialog', { name: /rules summary/i });
    await expect(help).toBeVisible();
    await expect(help.getByText('How to win (checked at the end of your turn)')).toBeVisible();
    await expect(help.getByText(/unbroken straight line/)).toBeVisible();
    await host.getByRole('button', { name: 'Close help' }).click();
    await expect(help).toBeHidden();

    // ...and can be reopened, then dismissed with Escape.
    await host.getByRole('button', { name: 'Rules & help' }).click();
    await expect(host.getByRole('dialog', { name: /rules summary/i })).toBeVisible();
    await host.keyboard.press('Escape');
    await expect(host.getByRole('dialog', { name: /rules summary/i })).toBeHidden();

    await dismissHelp(guest);

    // The board itself: 25 token cells, 12 face-up cards, 4 royals, both player strips.
    await expect(host.locator('.token-board [role="gridcell"]')).toHaveCount(25);
    await expect(host.locator('.sd-row .card')).toHaveCount(12);
    await expect(host.locator('.sd-royals .card')).toHaveCount(4);
    await expect(host.locator('.sd-player')).toHaveCount(2);

    // All 25 tokens start on the board, so the bag is empty.
    await expect(host.locator('.sd-bag').getByText('empty')).toBeVisible();

    await host.close();
    await guest.close();
  });

  test('tells the player to move what they can do, and the other to wait', async ({ browser }) => {
    const host = await openPlayer(browser, 'Ann');
    const guest = await openPlayer(browser, 'Ben');
    await pairUp(host, guest, 'Splendor Duel');
    await dismissHelp(host);
    await dismissHelp(guest);

    // Exactly one of them is to move; first player is random, so find out which.
    const hostToMove = await host.locator('.sd-guide', { hasText: 'Your turn' }).isVisible();
    const active = hostToMove ? host : guest;
    const waiting = hostToMove ? guest : host;

    const guide = active.locator('.sd-guide');
    await expect(guide).toContainText('Your turn — you can:');
    await expect(guide).toContainText('Take up to 3 tokens');
    // Turn one: the bag is empty and nothing is affordable yet, so those must not be offered.
    await expect(guide).not.toContainText('Replenish the board');
    await expect(guide).toContainText('No card is affordable yet');

    await expect(waiting.locator('.sd-guide')).toContainText('Waiting for your opponent');
    // The action buttons are not merely disabled for the waiting player, they are absent -- there is
    // nothing for them to do, so offering greyed-out controls would just be noise.
    await expect(waiting.getByRole('button', { name: /^Take/ })).toHaveCount(0);
    await expect(waiting.locator('.sd-actions')).toContainText('Waiting for your opponent');
    // Tokens must not be clickable on their screen either.
    await expect(waiting.locator('.token-board .cell-selectable')).toHaveCount(0);

    await active.close();
    await waiting.close();
  });

  test('takes tokens by clicking a line, and both boards update', async ({ browser }) => {
    const host = await openPlayer(browser, 'Ann');
    const guest = await openPlayer(browser, 'Ben');
    await pairUp(host, guest, 'Splendor Duel');
    await dismissHelp(host);
    await dismissHelp(guest);

    const hostToMove = await host.locator('.sd-guide', { hasText: 'Your turn' }).isVisible();
    const active = hostToMove ? host : guest;
    const other = hostToMove ? guest : host;

    const takeButton = active.getByRole('button', { name: /^Take/ });
    await expect(takeButton).toBeDisabled();

    // Only cells that could extend into a legal line are clickable, so pick from those.
    const selectable = active.locator('.token-board .cell-selectable');
    await expect(selectable.first()).toBeVisible();
    await selectable.first().click();
    await expect(active.locator('.token-board .cell-selected')).toHaveCount(1);
    // One token is already a legal take.
    await expect(takeButton).toBeEnabled();

    // Extend to a second cell; the set of offers narrows to whatever keeps the line straight.
    const stillSelectable = active.locator('.token-board .cell-selectable:not(.cell-selected)');
    if (await stillSelectable.count()) {
      await stillSelectable.first().click();
      await expect(active.locator('.token-board .cell-selected')).toHaveCount(2);
    }

    const tokensBefore = await active.locator('.sd-player').last().locator('.sd-tokens svg').count();
    await takeButton.click();

    // The mover now holds tokens, and the turn has passed.
    await expect(active.locator('.sd-player').last().locator('.sd-tokens svg')).not.toHaveCount(tokensBefore);
    await expect(active.locator('.sd-guide')).toContainText('Waiting for your opponent');

    // The opponent's board reflects it too, and the move shows up in the log.
    await expect(other.locator('.sd-guide')).toContainText('Your turn');
    await expect(other.locator('.log li').first()).toContainText('took');

    await host.close();
    await guest.close();
  });

  test('warns before a take that hands the opponent a scroll', async ({ browser }) => {
    const host = await openPlayer(browser, 'Ann');
    const guest = await openPlayer(browser, 'Ben');
    await pairUp(host, guest, 'Splendor Duel');
    await dismissHelp(host);
    await dismissHelp(guest);

    const hostToMove = await host.locator('.sd-guide', { hasText: 'Your turn' }).isVisible();
    const active = hostToMove ? host : guest;

    // The guide flags the rule regardless of what is selected.
    await expect(active.locator('.sd-guide')).toContainText(
      'Taking 3 tokens of the same colour, or both pearls in one go, hands your opponent a privilege scroll',
    );

    await host.close();
    await guest.close();
  });

  test('shows progress toward all three victory conditions', async ({ browser }) => {
    const host = await openPlayer(browser, 'Ann');
    const guest = await openPlayer(browser, 'Ben');
    await pairUp(host, guest, 'Splendor Duel');
    await dismissHelp(host);

    const tracker = host.locator('.sd-victory');
    await expect(tracker).toContainText('Any one of these wins');
    await expect(tracker.locator('.sd-victory-row')).toHaveCount(3);
    await expect(tracker).toContainText('0/20');
    await expect(tracker).toContainText('0/10');

    await host.close();
    await guest.close();
  });
});

test.describe('session resilience', () => {
  test('a refresh puts you back in your seat with the game intact', async ({ browser }) => {
    const host = await openPlayer(browser, 'Ann');
    const guest = await openPlayer(browser, 'Ben');
    const code = await pairUp(host, guest, 'Splendor Duel');
    await dismissHelp(host);
    await dismissHelp(guest);

    // Make a move so there is state worth preserving.
    const hostToMove = await host.locator('.sd-guide', { hasText: 'Your turn' }).isVisible();
    const active = hostToMove ? host : guest;
    await active.locator('.token-board .cell-selectable').first().click();
    await active.getByRole('button', { name: /^Take/ }).click();
    await expect(active.locator('.log li')).toHaveCount(1);

    // Reload: the seat is reclaimed via the stored session token, not taken as a new one.
    await host.reload();
    await expect(host.getByText('Connected')).toBeVisible();
    await expect(host.locator('.code-display')).toHaveText(code);
    await expect(host.locator('.players li')).toHaveCount(2);
    await expect(host.locator('.players li', { hasText: 'Ann (you)' })).toBeVisible();
    // History survives, including the move made before the reload.
    await expect(host.locator('.log li')).toHaveCount(1);

    await host.close();
    await guest.close();
  });

  test('closing the browser and coming back later resumes the game', async ({ browser }) => {
    /*
     * The scenario people actually have: stop playing, close everything, come back another time.
     *
     * A reload keeps the page's memory alive in ways a real return does not, so this throws the
     * whole browser context away and builds a new one from nothing but the saved storage -- which
     * is what a browser restart leaves you with. The half of the story that happens after the room
     * has been evicted from the server's memory is covered in apps/server/test/resume.test.ts,
     * where a sweep and a full server restart can be forced.
     */
    const host = await openPlayer(browser, 'Ann');
    const guest = await openPlayer(browser, 'Ben');
    const code = await pairUp(host, guest, 'Splendor Duel');
    await dismissHelp(host);
    await dismissHelp(guest);

    const hostToMove = await host.locator('.sd-guide', { hasText: 'Your turn' }).isVisible();
    const active = hostToMove ? host : guest;
    await active.locator('.token-board .cell-selectable').first().click();
    await active.getByRole('button', { name: /^Take/ }).click();
    await expect(active.locator('.log li')).toHaveCount(1);

    // Everything the browser would keep on disk, and nothing else.
    const saved = await host.context().storageState();
    await host.context().close();
    await guest.context().close();

    const returning = await browser.newContext({ storageState: saved });
    const page = await returning.newPage();
    await page.goto('/');
    await expect(page.getByText('Connected')).toBeVisible();

    // The lobby offers the game back, so you do not have to have kept the link.
    const entry = page.locator('.resume-item', { hasText: code });
    await expect(entry).toBeVisible();
    await expect(entry).toContainText('Splendor Duel');
    await entry.click();

    // Same seat, same board, same history.
    await expect(page.locator('.code-display')).toHaveText(code);
    await expect(page.locator('.players li', { hasText: 'Ann (you)' })).toBeVisible();
    await expect(page.locator('.players li')).toHaveCount(2);
    await expect(page.locator('.log li')).toHaveCount(1);
    expect(problemsOf(page)).toEqual([]);

    await returning.close();
  });

  test('a deep link joins the match directly', async ({ browser }) => {
    const host = await openPlayer(browser, 'Ann');
    const code = await host
      .locator('.game-card', { has: host.getByRole('heading', { name: 'Splendor Duel' }) })
      .getByRole('button', { name: 'Create match' })
      .click()
      .then(async () => ((await host.locator('.code-display').textContent()) ?? '').trim());

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    await guest.goto(`/g/${code}`);

    await expect(guest.locator('.code-display')).toHaveText(code);
    await expect(guest.locator('.players li')).toHaveCount(2);
    await expect(host.locator('.players li')).toHaveCount(2);

    await host.close();
    await guest.close();
  });
});

test.describe('tic-tac-toe, as a second game', () => {
  test('plays a full game to a win in the browser', async ({ browser }) => {
    const host = await openPlayer(browser, 'Ann');
    const guest = await openPlayer(browser, 'Ben');
    await pairUp(host, guest, 'Tic-Tac-Toe');

    // Seat 0 is always X and always starts, so the host moves first here.
    const cells = (page: Page) => page.locator('.ttt-cell');
    const play = async (page: Page, index: number) => {
      await expect(cells(page).nth(index)).toBeEnabled();
      await cells(page).nth(index).click();
    };

    // X takes the top row while O answers along the middle.
    await play(host, 0);
    await play(guest, 3);
    await play(host, 1);
    await play(guest, 4);
    await play(host, 2);

    await expect(host.locator('.result h3')).toHaveText('You win');
    await expect(guest.locator('.result h3')).toHaveText('You lose');
    await expect(host.locator('.result')).toContainText('Three in a row');

    await host.close();
    await guest.close();
  });
});

test.afterEach(async ({ browser }) => {
  // Surface any uncaught page error or console error as a failure, rather than letting a silently
  // broken render pass because the assertions happened to still match.
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const problems = problemsOf(page).filter(
        // The lobby test deliberately provokes a rejected join.
        (message) => !/NO_SUCH_MATCH/.test(message),
      );
      expect(problems, `page reported errors:\n${problems.join('\n')}`).toEqual([]);
    }
  }
});

test.describe('a long game in the browser', () => {
  /**
   * Plays many real turns through the UI, buying whenever possible so purchases, wild-colour
   * choices, pending decisions and the discard prompt all get exercised.
   *
   * The assertion that matters runs after *every* move: the guide must never claim it is your turn
   * while offering nothing to do. That state is reachable if the board ever mixes the server's
   * `actors` with an optimistically-predicted view, and it is exactly what a player would report as
   * "the game is stuck".
   */
  test('stays coherent over many turns and never offers a dead end', async ({ browser }) => {
    const host = await openPlayer(browser, 'Ann');
    const guest = await openPlayer(browser, 'Ben');
    await pairUp(host, guest, 'Splendor Duel');
    await dismissHelp(host);
    await dismissHelp(guest);

    const bothCoherent = async () => {
      for (const page of [host, guest]) {
        const guide = page.locator('.sd-guide');
        const text = (await guide.textContent()) ?? '';
        if (!text.includes('Your turn')) continue;
        // "Your turn" must come with at least one thing you can actually do.
        const bullets = await guide.locator('li').allTextContents();
        expect(bullets.length, `guide claimed a turn with no options: ${text}`).toBeGreaterThan(0);

        // Some bullets are informational rather than offers. If *every* bullet is one of those, the
        // player has been told it is their turn and given nothing to do — which is the exact symptom
        // of the board mixing server `actors` with a predicted view.
        const informational = [/^No card is affordable yet/, /^Watch out/, /^You are holding/];
        const offers = bullets.filter((b) => !informational.some((pattern) => pattern.test(b.trim())));
        expect(offers.length, `guide offered nothing actionable: ${bullets.join(' | ')}`).toBeGreaterThan(0);
      }
    };

    let moves = 0;
    const cardWidths = new Set<number>();
    const sampleCardWidth = async () => {
      const width = await host.evaluate(() => {
        const card = document.querySelector('.card--pyramid');
        return card ? Math.round(card.getBoundingClientRect().width) : 0;
      });
      if (width > 0) cardWidths.add(width);
    };
    await sampleCardWidth();

    for (let i = 0; i < 70; i++) {
      const hostToMove = await host.locator('.sd-guide', { hasText: 'Your turn' }).isVisible();
      const guestToMove = await guest.locator('.sd-guide', { hasText: 'Your turn' }).isVisible();
      if (!hostToMove && !guestToMove) break; // finished, or momentarily between states
      const active = hostToMove ? host : guest;

      // Resolve any outstanding decision first — the UI blocks everything else until it is answered.
      const prompt = active.locator('.sd-actions .prompt');
      if (await prompt.isVisible().catch(() => false)) {
        const promptText = (await prompt.textContent()) ?? '';
        if (/Discard/.test(promptText)) {
          const count = Number(/Discard (\d+)/.exec(promptText)?.[1] ?? '1');
          // Click whichever "+" is still enabled, so a colour running out does not strand us.
          for (let n = 0; n < count; n++) {
            const plus = prompt.locator('button[aria-label^="One more"]:not([disabled])').first();
            await plus.click();
          }
          const confirm = prompt.getByRole('button', { name: 'Discard' });
          await expect(confirm).toBeEnabled();
          await confirm.click();
        } else if (/Steal a token/.test(promptText)) {
          await prompt.locator('button.mini').first().click();
        } else if (/Take a .* token from the board/.test(promptText)) {
          await active.locator('.token-board .cell-selectable').first().click();
        } else if (/Claim a royal/.test(promptText)) {
          await active.locator('.sd-royals .card-affordable').first().click();
        }
        await active.waitForTimeout(60);
        await bothCoherent();
        continue;
      }

      // Prefer buying, so the tableau and the wild-colour path get used.
      const affordable = active.locator('.sd-row .card-affordable');
      if (await affordable.count()) {
        await affordable.first().click();
        const panel = active.locator('.sd-buy');
        const wild = panel.locator('.sd-wild button.mini');
        if (await wild.count()) await wild.first().click();
        const buy = panel.getByRole('button', { name: 'Buy' });
        if (await buy.isEnabled().catch(() => false)) {
          await buy.click();
          moves += 1;
          await active.waitForTimeout(60);
          await bothCoherent();
          continue;
        }
        await panel.getByRole('button', { name: 'cancel' }).click();
      }

      const cells = active.locator('.token-board .cell-selectable');
      if (await cells.count()) {
        await cells.first().click();
        const more = active.locator('.token-board .cell-selectable:not(.cell-selected)');
        if (await more.count()) await more.first().click();
        const take = active.getByRole('button', { name: /^Take/ });
        if (await take.isEnabled().catch(() => false)) {
          await take.click();
          moves += 1;
          await active.waitForTimeout(60);
          await bothCoherent();
          continue;
        }
      }

      // Fall back to the optional actions if nothing else was possible.
      for (const label of ['Replenish', 'Pass (stuck)']) {
        const button = active.getByRole('button', { name: label });
        if (await button.isEnabled().catch(() => false)) {
          await button.click();
          moves += 1;
          break;
        }
      }
      await active.waitForTimeout(60);
      await bothCoherent();
      await sampleCardWidth();
    }

    expect(moves, 'the loop should have played a substantial number of turns').toBeGreaterThan(25);

    /*
     * Card size must not have moved during the whole match. Anything in the board column whose height
     * depends on game state will resize every card as the state changes -- the bag row did exactly
     * that, growing to two lines as the bag filled -- and a board that reflows on every move is both
     * unpleasant and, for a click, genuinely unhittable.
     */
    expect(cardWidths.size, `card width changed mid-match: ${[...cardWidths].join(', ')}`).toBe(1);
    // Both players should have accumulated something: tokens, cards, or score.
    await expect(host.locator('.log li').first()).toBeVisible();
    expect((await host.locator('.log li').count())).toBeGreaterThan(20);

    await host.close();
    await guest.close();
  });
});

test.describe('the board fits without scrolling', () => {
  /**
   * The whole match view is height-bounded: the pyramid and the token board size themselves from the
   * space they are given, so no combination of content should ever push the page into a scroll.
   *
   * Asserted at several laptop-ish viewports, and in the states that add the most content: your turn
   * with the full guide showing, a card panel open, and a pending decision.
   */
  for (const viewport of [
    { width: 1152, height: 720 },
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
    { width: 1728, height: 1000 },
  ]) {
    test(`at ${viewport.width}x${viewport.height}`, async ({ browser }) => {
      const contexts = await Promise.all([browser.newContext({ viewport }), browser.newContext({ viewport })]);
      const [host, guest] = await Promise.all(contexts.map((c) => c.newPage()));
      for (const page of [host!, guest!]) {
        await page.goto('/');
        await expect(page.getByText('Connected')).toBeVisible();
      }

      await host!
        .locator('.game-card', { has: host!.getByRole('heading', { name: 'Splendor Duel' }) })
        .getByRole('button', { name: 'Create match' })
        .click();
      const code = ((await host!.locator('.code-display').textContent()) ?? '').trim();
      await guest!.getByLabel('Match code').fill(code);
      await guest!.getByRole('button', { name: 'Join' }).click();
      await expect(host!.locator('.players li')).toHaveCount(2);
      await dismissHelp(host!);
      await dismissHelp(guest!);

      const overflow = (page: Page) =>
        page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight);

      // A couple of pixels of rounding slack; anything more means real clipping or a scrollbar.
      const SLACK = 2;
      for (const page of [host!, guest!]) {
        expect(await overflow(page), 'fresh board overflows').toBeLessThanOrEqual(SLACK);
      }

      const active = (await host!.locator('.sd-guide', { hasText: 'Your turn' }).isVisible()) ? host! : guest!;

      // With the card panel open — it floats, so it must not extend the page.
      await active.locator('.sd-row .card').first().click();
      await expect(active.locator('.sd-buy')).toBeVisible();
      expect(await overflow(active), 'card panel overflows').toBeLessThanOrEqual(SLACK);
      await active.locator('.sd-buy').getByRole('button', { name: 'cancel' }).click();

      // Play far enough for tableaus, reserved cards and prompts to appear.
      for (let i = 0; i < 40; i++) {
        const hostToMove = await host!.locator('.sd-guide', { hasText: 'Your turn' }).isVisible();
        const guestToMove = await guest!.locator('.sd-guide', { hasText: 'Your turn' }).isVisible();
        if (!hostToMove && !guestToMove) break;
        const mover = hostToMove ? host! : guest!;

        const prompt = mover.locator('.sd-actions .prompt');
        if (await prompt.isVisible().catch(() => false)) {
          const text = (await prompt.textContent()) ?? '';
          expect(await overflow(mover), `overflow while prompting: ${text.slice(0, 40)}`).toBeLessThanOrEqual(SLACK);
          if (/Discard/.test(text)) {
            const count = Number(/Discard (\d+)/.exec(text)?.[1] ?? '1');
            for (let n = 0; n < count; n++) {
              await prompt.locator('button[aria-label^="One more"]:not([disabled])').first().click();
            }
            await prompt.getByRole('button', { name: 'Discard' }).click();
          } else if (/Steal a token/.test(text)) await prompt.locator('button.mini').first().click();
          else if (/token from the board/.test(text)) await mover.locator('.token-board .cell-selectable').first().click();
          else if (/Claim a royal/.test(text)) await mover.locator('.sd-royals .card-affordable').first().click();
          await mover.waitForTimeout(30);
          continue;
        }

        const affordable = mover.locator('.sd-row .card-affordable');
        if (await affordable.count()) {
          await affordable.last().click();
          const panel = mover.locator('.sd-buy');
          const wild = panel.locator('.sd-wild button.mini');
          if (await wild.count()) await wild.first().click();
          const buy = panel.getByRole('button', { name: 'Buy' });
          if (await buy.isEnabled().catch(() => false)) {
            await buy.click();
            await mover.waitForTimeout(30);
            continue;
          }
          await panel.getByRole('button', { name: 'cancel' }).click();
        }

        const cells = mover.locator('.token-board .cell-selectable');
        if (await cells.count()) {
          await cells.first().click();
          const take = mover.getByRole('button', { name: /^Take/ });
          if (await take.isEnabled().catch(() => false)) {
            await take.click();
            await mover.waitForTimeout(30);
            continue;
          }
        }
        for (const label of ['Replenish', 'Pass (stuck)']) {
          const button = mover.getByRole('button', { name: label });
          if (await button.isEnabled().catch(() => false)) {
            await button.click();
            break;
          }
        }
        await mover.waitForTimeout(30);
      }

      for (const page of [host!, guest!]) {
        expect(await overflow(page), 'mid-game board overflows').toBeLessThanOrEqual(SLACK);
      }

      // Nothing may be clipped out of view either: the royals strip used to hide behind the player
      // panel once it was moved, which no overflow check would have caught.
      for (const selector of ['.sd-royals .card', '.token-board', '.sd-actions', '.sd-bottom']) {
        const box = await host!.locator(selector).first().boundingBox();
        expect(box, `${selector} has no box`).not.toBeNull();
        if (box) {
          expect(box.y + box.height, `${selector} is cut off at the bottom`).toBeLessThanOrEqual(viewport.height + SLACK);
          expect(box.height, `${selector} collapsed to nothing`).toBeGreaterThan(8);
        }
      }

      // ...and nothing may be clipped by an *ancestor* either. Bounding boxes ignore a parent's
      // `overflow: hidden`, so the checks above happily passed while the level-1 card row and the
      // bottom of the token board were being cut off inside a too-short container.
      const clipped = await host!.evaluate(() => {
        const problems: string[] = [];
        const check = (childSel: string, parentSel: string) => {
          const child = document.querySelector(childSel);
          const parent = document.querySelector(parentSel);
          if (!child || !parent) {
            problems.push(`missing ${childSel} or ${parentSel}`);
            return;
          }
          if (getComputedStyle(parent).overflow === 'visible') return;
          const c = child.getBoundingClientRect();
          const p = parent.getBoundingClientRect();
          if (c.bottom > p.bottom + 2) problems.push(`${childSel} overflows ${parentSel} by ${Math.round(c.bottom - p.bottom)}px`);
          if (c.right > p.right + 2) problems.push(`${childSel} overflows ${parentSel} horizontally`);
        };
        check('.sd-row:last-of-type', '.sd-middle');
        check('.token-board', '.sd-middle');
        check('.sd-middle', '.sd');
        check('.sd-actions', '.sd');
        return problems;
      });
      expect(clipped, 'content is clipped by an ancestor').toEqual([]);

      /*
       * The turn guide is allowed to be taller than its box, but only if it genuinely scrolls. It
       * once had `overflow-y: auto` on a list whose height nothing constrained, so the property did
       * nothing and the parent's `overflow: hidden` simply cut the text off — advice a new player
       * could not read and could not reach.
       */
      const guide = await host!.evaluate(() => {
        const list = document.querySelector('.sd-guide ul') as HTMLElement | null;
        if (!list) return { present: false, reachable: true, viewport: 0 };
        const items = [...list.querySelectorAll('li')];
        list.scrollTop = list.scrollHeight;
        const last = items[items.length - 1]?.getBoundingClientRect();
        const box = list.getBoundingClientRect();
        return {
          present: true,
          viewport: Math.round(list.clientHeight),
          // After scrolling to the bottom, the final bullet must actually be inside the viewport.
          reachable: !last || (last.top >= box.top - 2 && last.bottom <= box.bottom + 2),
        };
      });
      if (guide.present) {
        expect(guide.reachable, 'the last line of the turn guide cannot be scrolled into view').toBe(true);
        // A viewport shorter than a line of text is scrollable in theory and unusable in practice.
        expect(guide.viewport, 'the turn guide is too short to read').toBeGreaterThan(60);
      }

      await host!.close();
      await guest!.close();
    });
  }
});

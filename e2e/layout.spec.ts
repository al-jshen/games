import { expect, test, type Page } from '@playwright/test';
import { GameClient } from '@games/client-sdk';
import { legalActionsFromView, type SplendorAction, type SplendorView } from '@games/splendor-duel';
import { mkdirSync } from 'node:fs';

/**
 * Does the board still fit at the size the player's monitor actually is?
 *
 * The room is a fixed-height layout -- `.app { height: 100dvh; overflow: hidden }` -- so nothing
 * overflows visibly. It just *disappears*, silently, wherever a panel is taller than the space it
 * was given. That is the failure this exists to catch: the last row of the victory tracker gone at
 * 768px, a reserved card's cost cut off, a turn guide ending mid-sentence. None of it throws, none
 * of it fails an existing test, and none of it is visible on the machine of whoever wrote the CSS.
 *
 * So this is not a screenshot test in the usual sense. Screenshots are written for a human to look
 * at, but the assertion is mechanical: find every element that clips its own content, and fail. A
 * golden-image test would be worse than nothing here -- it would break on every deliberate change
 * and say nothing about whether the result is *readable*.
 *
 * `overflow: auto` is exempt. Content taller than a scrollable box is not lost, it is scrolled, and
 * the sidebar deliberately scrolls as a safety net. Only `hidden` and `clip` destroy information.
 */

/** Real monitors, weighted toward the short ones -- vertical space is what runs out. */
const VIEWPORTS = [
  { name: '1024x768-small', width: 1024, height: 768 },
  { name: '1280x720-720p', width: 1280, height: 720 },
  { name: '1280x800-small-laptop', width: 1280, height: 800 },
  { name: '1366x768-common-laptop', width: 1366, height: 768 },
  { name: '1440x900-air', width: 1440, height: 900 },
  { name: '1512x982-mbp14', width: 1512, height: 982 },
  { name: '1680x1050', width: 1680, height: 1050 },
  { name: '1920x1080-desktop', width: 1920, height: 1080 },
  { name: '2560x1440-qhd', width: 2560, height: 1440 },
];

const SHOTS = '.cache/screens';

interface Seated {
  code: string;
  token: string;
}

/**
 * A room played to a genuinely busy position, driven over the socket rather than through the UI.
 *
 * Clicking a game this far forward in a browser takes minutes and is its own source of flakiness;
 * the SDK reaches the same server state in about a second. What matters for layout is that the
 * position is *full* -- cards reserved, cards bought, bonuses accumulated, the victory tracker
 * showing real progress -- because an empty opening board fits at any size and proves nothing.
 */
async function playedOutRoom(baseURL: string): Promise<Seated> {
  const url = `${baseURL.replace('http', 'ws')}/ws`;
  const store = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
  };

  let code: string | null = null;
  let token: string | null = null;

  /*
   * Reserving and buying are what make the layout hard: they are the two things that add rows to a
   * player's side of the board. A uniformly random player does both eventually, but preferring them
   * gets there in a quarter of the moves and keeps the position reproducible.
   */
  const pick = (actions: SplendorAction[]): SplendorAction => {
    const reserve = actions.filter((a) => a.t === 'reserve');
    const buy = actions.filter((a) => a.t === 'purchase');
    if (buy.length > 0) return buy[0] as SplendorAction;
    if (reserve.length > 0) return reserve[0] as SplendorAction;
    return actions[0] as SplendorAction;
  };

  const drive = (client: GameClient) => (state: Parameters<NonNullable<ConstructorParameters<typeof GameClient>[0]['onChange']>>[0]) => {
    if (state.code) code ??= state.code;
    if (!state.confirmed || state.seat === null) return;
    if (state.confirmed.outcome?.status === 'over') return;
    if (!state.actors.includes(state.seat) || state.pending) return;
    const { actions } = legalActionsFromView(state.view as SplendorView, state.seat);
    if (actions.length > 0) client.submit(pick(actions));
  };

  const host: GameClient = new GameClient({ url, storage: store(), onChange: (s) => drive(host)(s) });
  host.connect();
  host.createMatch('splendor-duel', 'You');
  await expect.poll(() => code, { timeout: 10_000 }).not.toBeNull();

  const guest: GameClient = new GameClient({ url, storage: store(), onChange: (s) => drive(guest)(s) });
  guest.connect();
  guest.joinMatch(code as unknown as string, 'Opponent');

  // Far enough in that both players hold reservations, bonuses and prestige.
  await expect.poll(() => host.state.version, { timeout: 30_000 }).toBeGreaterThan(28);

  // The token the browser needs to sit in seat 0. Read from the client's own storage, which is
  // where the SDK put it -- the same key the app reads.
  token = (host as unknown as { storage: { getItem(k: string): string | null } }).storage.getItem(
    `match:${code}`,
  );
  if (!token) throw new Error('the host never received a seat token');

  host.close();
  guest.close();
  return { code: code as unknown as string, token };
}

/** Every element that destroys its own content, with enough context to find it in the CSS. */
async function clipped(page: Page) {
  return page.evaluate(() => {
    const out: { selector: string; text: string; overflowY: number; overflowX: number }[] = [];
    const describe = (el: Element): string => {
      const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
      return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}`;
    };
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const style = getComputedStyle(el);
      const hides = (v: string) => v === 'hidden' || v === 'clip';
      const overflowY = el.scrollHeight - el.clientHeight;
      const overflowX = el.scrollWidth - el.clientWidth;
      // 1px of slack: subpixel layout rounds, and a one-pixel overhang is not lost information.
      const badY = hides(style.overflowY) && overflowY > 1;
      const badX = hides(style.overflowX) && overflowX > 1;
      if (!badY && !badX) continue;
      // An SVG scales its own contents; `scrollHeight` on one is not a clipping report.
      if (el.namespaceURI === 'http://www.w3.org/2000/svg') continue;
      out.push({
        selector: describe(el),
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 70),
        overflowY: badY ? overflowY : 0,
        overflowX: badX ? overflowX : 0,
      });
    }
    return out;
  });
}

test.describe('the board fits the monitor', () => {
  let room: Seated;

  test.beforeAll(async ({ baseURL }) => {
    mkdirSync(SHOTS, { recursive: true });
    room = await playedOutRoom(baseURL as string);
  });

  for (const viewport of VIEWPORTS) {
    test(`nothing is cut off at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.addInitScript(
        ([code, token]) => localStorage.setItem(`match:${code}`, token as string),
        [room.code, room.token],
      );
      await page.goto(`/g/${room.code}`);
      /*
       * The victory tracker, not the board's `svg`: the card art is drawn from a `<svg width="0"
       * height="0">` sprite sheet that is never visible, so waiting on an `svg` waits for something
       * that will not arrive. This is also the panel most likely to be clipped, so waiting on it is
       * waiting for the thing under test.
       */
      await page.waitForSelector('.sd-victory', { timeout: 20_000 });
      // The help dialog opens on a first visit and covers the board.
      const close = page.getByRole('button', { name: 'Close help' });
      if (await close.isVisible().catch(() => false)) await close.click();
      await page.waitForTimeout(500);

      await page.screenshot({ path: `${SHOTS}/room-${viewport.name}.png`, fullPage: false });

      const bad = await clipped(page);
      expect(bad, `clipped at ${viewport.name}:\n${JSON.stringify(bad, null, 2)}`).toEqual([]);
    });
  }
});

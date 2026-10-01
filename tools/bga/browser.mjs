import { chromium } from 'playwright';

/**
 * A real browser with a profile that persists.
 *
 * Visible unless told otherwise, because in `advise` mode the operator plays in this window, and in
 * `play` mode it is what they take over when the adapter stops. Persistent, so the operator signs in
 * to BGA once, by hand, and this program never sees a password: the session lives in the profile
 * directory like any browser's would.
 *
 * `headless` is for the commands that only read (`watch`, `capture`): the same browser and the same
 * profile, with no window. The caller decides which commands those are.
 */
export async function openBrowser(profileDir, { headless = false } = {}) {
  return chromium.launchPersistentContext(profileDir, headless ? { headless: true } : { headless: false, viewport: null });
}

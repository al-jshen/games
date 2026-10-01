import { chromium } from 'playwright';

/**
 * A real, visible browser with a profile that persists.
 *
 * Visible, because in `advise` mode the operator plays in this window, and in `play` mode it is
 * what they take over when the adapter stops. Persistent, so the operator signs in to BGA once, by
 * hand, and this program never sees a password: the session lives in the profile directory like
 * any browser's would.
 */
export async function openBrowser(profileDir) {
  return chromium.launchPersistentContext(profileDir, { headless: false, viewport: null });
}

import { CODE_LENGTH } from '@games/protocol';

/**
 * The matches this browser can walk back into.
 *
 * Every seat this browser has ever held left a session token behind under `match:<CODE>`, so the
 * list of games you can resume is already sitting in local storage — it just has never been shown.
 * Without it, resuming depends on still having the link, which is exactly what closing a browser
 * tends to lose.
 *
 * The server is asked what each one actually is, both because the code alone says nothing about
 * which game it was and because that is the only way to know a match is still there.
 */

const TOKEN_PREFIX = 'match:';

export interface ResumableMatch {
  code: string;
  gameId: string;
  status: 'lobby' | 'active' | 'finished';
  seatsFilled: number;
  maxSeats: number;
  moves: number;
  createdAt: number;
}

interface MatchInfo {
  code?: string;
  gameId?: string;
  status?: ResumableMatch['status'];
  seatsFilled?: number;
  maxSeats?: number;
  version?: number;
  createdAt?: number;
}

/** Codes this browser holds a seat token for. */
export function heldCodes(): string[] {
  const codes: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(TOKEN_PREFIX)) continue;
      const code = key.slice(TOKEN_PREFIX.length);
      if (code.length === CODE_LENGTH) codes.push(code);
    }
  } catch {
    // Private browsing: no stored seats to offer, which is the correct answer rather than an error.
  }
  return codes;
}

function tokenFor(code: string): string | null {
  try {
    return localStorage.getItem(`${TOKEN_PREFIX}${code}`);
  } catch {
    return null;
  }
}

function forget(code: string): void {
  try {
    localStorage.removeItem(`${TOKEN_PREFIX}${code}`);
  } catch {
    // Nothing to do; the entry is unreadable anyway.
  }
}

/**
 * Close a match for good, at the server, then forget the seat locally.
 *
 * Not a local hide: the other player's copy would carry on existing and the game would still be
 * sitting there the next time either of them opened the link. The seat token is what authorises it,
 * so a code alone cannot end somebody else's game.
 *
 * The local token is dropped whichever way the request goes. If the server has never heard of the
 * match, or says it is already closed, the entry is stale and hiding it is exactly right.
 */
export async function closeMatch(code: string): Promise<{ ok: boolean; message?: string }> {
  const sessionToken = tokenFor(code);
  if (!sessionToken) {
    forget(code);
    return { ok: true };
  }
  try {
    const res = await fetch(`/api/matches/${code}/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionToken }),
    });
    if (res.ok || res.status === 404 || res.status === 410) {
      forget(code);
      return { ok: true };
    }
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    // Left in the list on purpose: it still exists, and pretending otherwise would be a lie the
    // player discovers later.
    return { ok: false, message: body.message ?? `The server refused (${res.status}).` };
  } catch {
    return { ok: false, message: 'Could not reach the server.' };
  }
}

/** Where a transfer link carries the seat. A fragment, never a query: see `redeemSeatFromUrl`. */
const SEAT_FRAGMENT = 'seat=';

/**
 * Ask for a link that carries this seat to another device.
 *
 * The token goes in the URL *fragment*, which browsers do not send to the server — so it stays out of
 * access logs, proxy logs and `Referer` headers, the same reason the socket takes its token in a
 * frame rather than a query string.
 */
export async function seatTransferLink(code: string): Promise<{ ok: true; link: string; expiresAt: number } | { ok: false; message: string }> {
  const sessionToken = tokenFor(code);
  if (!sessionToken) return { ok: false, message: 'This browser does not hold a seat in that match.' };
  try {
    const res = await fetch(`/api/matches/${code}/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionToken }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      return { ok: false, message: body.message ?? `The server refused (${res.status}).` };
    }
    const body = (await res.json()) as { transferToken: string; expiresAt: number };
    return {
      ok: true,
      link: `${location.origin}/g/${code}#${SEAT_FRAGMENT}${encodeURIComponent(body.transferToken)}`,
      expiresAt: body.expiresAt,
    };
  } catch {
    return { ok: false, message: 'Could not reach the server.' };
  }
}

/**
 * If this page was opened from a transfer link, exchange the fragment for a real seat.
 *
 * The fragment is stripped either way, so a reload cannot try to redeem a token that has already been
 * spent, and so the credential does not sit in the address bar to be copied onward by accident.
 */
export async function redeemSeatFromUrl(): Promise<{ redeemed: boolean; error?: string }> {
  const hash = location.hash.replace(/^#/, '');
  if (!hash.startsWith(SEAT_FRAGMENT)) return { redeemed: false };
  const transferToken = decodeURIComponent(hash.slice(SEAT_FRAGMENT.length));
  const code = /^\/g\/([A-Za-z0-9-]+)\/?$/.exec(location.pathname)?.[1]?.toUpperCase();

  const clearFragment = () => history.replaceState({}, '', location.pathname + location.search);
  if (!code || !transferToken) {
    clearFragment();
    return { redeemed: false };
  }

  try {
    const res = await fetch(`/api/matches/${code}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transferToken }),
    });
    clearFragment();
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      return { redeemed: false, error: body.message ?? 'That transfer link did not work.' };
    }
    const body = (await res.json()) as { sessionToken: string };
    localStorage.setItem(`${TOKEN_PREFIX}${code}`, body.sessionToken);
    return { redeemed: true };
  } catch {
    clearFragment();
    return { redeemed: false, error: 'Could not reach the server.' };
  }
}

/**
 * Look up every held code, newest first. Codes the server has never heard of are dropped from
 * storage as we go, so a browser does not accumulate dead seats forever.
 */
export async function listResumable(): Promise<ResumableMatch[]> {
  const found = await Promise.all(
    heldCodes().map(async (code): Promise<ResumableMatch | null> => {
      let res: Response;
      try {
        res = await fetch(`/api/matches/${code}`);
      } catch {
        // Offline or the server is down: keep the token, this says nothing about the match.
        return null;
      }
      // 404: never existed. 410: existed and was closed by somebody. Either way this browser is
      // holding a seat in a game it can no longer join, so drop it.
      if (res.status === 404 || res.status === 410) {
        forget(code);
        return null;
      }
      if (!res.ok) return null;
      const info = (await res.json()) as MatchInfo;
      if (!info.gameId) return null;
      return {
        code,
        gameId: info.gameId,
        status: info.status ?? 'active',
        seatsFilled: info.seatsFilled ?? 0,
        maxSeats: info.maxSeats ?? 2,
        moves: info.version ?? 0,
        createdAt: info.createdAt ?? 0,
      };
    }),
  );

  return found.filter((m): m is ResumableMatch => m !== null).sort((a, b) => b.createdAt - a.createdAt);
}

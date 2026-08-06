import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Stateless session tokens.
 *
 * HMAC over the claim rather than a lookup table, so a server restart with the same secret still
 * accepts tokens that were issued before it — there is no session store to lose. The token is what
 * lets a player reclaim their seat after a refresh, so losing them all on deploy would mean
 * killing every match in progress.
 */

export interface SessionClaim {
  matchId: string;
  seat: number;
  /** Distinguishes two players who somehow share a seat history; also makes tokens unguessable. */
  playerId: string;
  /** Issued-at, epoch ms. */
  iat: number;
  /**
   * `'transfer'` marks a short-lived token minted to carry a seat to another device. Absent on an
   * ordinary session token, which does not expire.
   *
   * The distinction is load-bearing: a transfer token travels through a clipboard and probably a chat
   * app, so it must stop working quickly, and it must not be usable as a session on its own — a
   * device redeems it for a real one and keeps that.
   */
  kind?: 'transfer';
  /** Expiry, epoch ms. Only on transfer tokens. */
  exp?: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sign(secret: string, body: string): string {
  return b64url(createHmac('sha256', secret).update(body).digest());
}

export function mintToken(secret: string, claim: SessionClaim): string {
  const body = b64url(Buffer.from(JSON.stringify(claim), 'utf8'));
  return `${body}.${sign(secret, body)}`;
}

/**
 * Verify and decode, rejecting anything expired.
 *
 * `now` is a parameter so the expiry can be tested without waiting for it, and so a caller can be
 * explicit about which clock it means.
 */
export function verifyToken(secret: string, token: string, now = Date.now()): SessionClaim | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(secret, body);
  // Constant-time compare; length mismatch would make timingSafeEqual throw.
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const claim = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionClaim;
    if (typeof claim.matchId !== 'string' || typeof claim.seat !== 'number') return null;
    // A signature proves we minted it, not that it is still good.
    if (typeof claim.exp === 'number' && now >= claim.exp) return null;
    return claim;
  } catch {
    return null;
  }
}

/** How long a transfer link is good for. Long enough to send to yourself, short enough to matter. */
export const TRANSFER_TTL_MS = 10 * 60 * 1000;

/**
 * A token that carries a seat to another device, and nothing else.
 *
 * Same seat, same signature, but it expires and it is marked, so the socket path can refuse it. What
 * the other device does with it is exchange it for an ordinary session token, which is the one that
 * lasts.
 */
export function mintTransferToken(secret: string, claim: SessionClaim, now = Date.now()): string {
  return mintToken(secret, {
    matchId: claim.matchId,
    seat: claim.seat,
    playerId: claim.playerId,
    iat: now,
    kind: 'transfer',
    exp: now + TRANSFER_TTL_MS,
  });
}

export function newPlayerId(): string {
  return randomBytes(9).toString('base64url');
}

/**
 * A per-process secret when none is configured. Fine for local dev; set `SESSION_SECRET` in
 * production or every restart invalidates outstanding tokens.
 */
export function resolveSecret(fromEnv: string | undefined): string {
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  return randomBytes(32).toString('base64url');
}

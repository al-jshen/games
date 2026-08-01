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

function forget(code: string): void {
  try {
    localStorage.removeItem(`${TOKEN_PREFIX}${code}`);
  } catch {
    // Nothing to do; the entry is unreadable anyway.
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
      if (res.status === 404) {
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

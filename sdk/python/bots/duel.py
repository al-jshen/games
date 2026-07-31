#!/usr/bin/env python3
"""Run two bots against a live server, start to finish.

This is the smoke test for the whole stack -- HTTP create, WebSocket join, server-side legal-move
enumeration, action submission, and the end-of-match frames -- exercised the same way a real bot
would. It is also the fastest way to sanity-check a rules change against a running server.

    python3 sdk/python/bots/duel.py --games 3 --game splendor-duel
"""

from __future__ import annotations

import argparse
import random
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gameclient import GameConnection, Rejected  # noqa: E402


def greedy(view: Any, actions: List[Any]) -> Any:
    """Buy the most valuable thing available, else take tokens, else whatever is legal.

    Not a good player -- just enough shape to be more interesting than random, and to exercise the
    purchase path (including wild-colour choices) far more often than random play does.
    """
    purchases = [a for a in actions if a.get("t") == "purchase"]
    if purchases:
        return purchases[0]
    takes = [a for a in actions if a.get("t") == "takeTokens"]
    if takes:
        return max(takes, key=lambda a: len(a["cells"]))
    return actions[0]


STRATEGIES = {"random": None, "greedy": greedy}


def run_one(url: str, base: str, game_id: str, seed: int, p1: str, p2: str, verbose: bool,
            transport: Optional[str] = None) -> Dict[str, Any]:
    rng1, rng2 = random.Random(seed), random.Random(seed + 10_000)

    def pick(name: str, rng: random.Random):
        fn = STRATEGIES[name]
        return fn if fn else (lambda _v, actions: rng.choice(actions))

    host = GameConnection(url, transport=transport)
    guest = GameConnection(url, transport=transport)
    try:
        host.hello()
        host.create(game_id, name=f"{p1}-host")
        guest.hello()
        guest.join(host.code or "", name=f"{p2}-guest")
        # Both sides get a sync once the room fills.
        host.wait_for("sync", predicate=lambda f: len(f["snapshot"]["players"]) == 2)
        guest.wait_for("sync")

        conns = {host.seat: (host, pick(p1, rng1)), guest.seat: (guest, pick(p2, rng2))}
        moves = 0
        rejections = 0
        started = time.time()

        while not host.finished and moves < 4000:
            actor = host.snapshot["actors"]
            if not actor:
                break
            conn, choose = conns[actor[0]]
            conn.wait_for_turn()
            if conn.finished:
                break
            actions = conn.legal_actions()
            if not actions:
                break
            try:
                conn.submit(choose(conn.view, actions))
                rejections = 0
            except Rejected as err:
                rejections += 1
                if verbose:
                    print(f"    rejected: {err}")
                if err.code == "RATE_LIMITED":
                    time.sleep(0.25)
                elif rejections >= 12:
                    # A run of rejections means the server is refusing moves it called legal, which
                    # is a bug worth surfacing rather than spinning on.
                    raise RuntimeError(f"stuck: {rejections} consecutive rejections, last {err}") from err
                continue
            moves += 1
            # Keep the other seat's view current so `actors` is accurate on the next pass.
            other = guest if conn is host else host
            try:
                other.wait_for("applied", "over", timeout=5)
            except Exception:  # noqa: BLE001 - a missed broadcast is not fatal here
                pass

        outcome = host.outcome or {}
        return {
            "seed": seed,
            "moves": moves,
            "seconds": round(time.time() - started, 2),
            "winners": outcome.get("winners", []),
            "reason": outcome.get("reason"),
            "scores": outcome.get("scores"),
            "code": host.code,
            "transport": host.transport_name,
        }
    finally:
        host.close()
        guest.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Bot-vs-bot smoke test against a live server.")
    parser.add_argument("--url", default="ws://localhost:8787/ws")
    parser.add_argument(
        "--transport",
        choices=["websockets", "stdlib"],
        help="force a WebSocket implementation; default prefers websockets if installed",
    )
    parser.add_argument("--http", default="http://localhost:8787")
    parser.add_argument("--game", default="splendor-duel")
    parser.add_argument("--games", type=int, default=1)
    parser.add_argument("--p1", choices=sorted(STRATEGIES), default="greedy")
    parser.add_argument("--p2", choices=sorted(STRATEGIES), default="random")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    reasons: Counter[str] = Counter()
    wins: Counter[str] = Counter()
    total_moves = 0
    transport_used = None

    for i in range(args.games):
        result = run_one(args.url, args.http, args.game, args.seed + i, args.p1, args.p2, args.verbose,
                         transport=args.transport)
        total_moves += result["moves"]
        transport_used = result.get("transport")
        reasons[str(result["reason"])] += 1
        winners = result["winners"]
        wins["draw" if not winners else f"seat {winners[0]}"] += 1
        print(
            f"[{i + 1}/{args.games}] {result['code']} "
            f"{result['moves']} moves in {result['seconds']}s -> "
            f"{'draw' if not winners else f'seat {winners[0]} wins'} by {result['reason']} "
            f"scores={result['scores']}"
        )

    print()
    print(f"transport: {transport_used or 'unknown'}")
    print(f"moves total {total_moves} (avg {total_moves / max(1, args.games):.1f})")
    print(f"win conditions: {dict(reasons)}")
    print(f"results: {dict(wins)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

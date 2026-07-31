#!/usr/bin/env python3
"""Play a match by choosing uniformly among the server's legal moves.

The simplest useful bot, and the reference for how to write one:

    # join a human's match
    python3 sdk/python/bots/random_bot.py --code ABC234

    # create a match and print the code for someone to join
    python3 sdk/python/bots/random_bot.py --create splendor-duel
"""

from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gameclient import GameConnection, play, random_strategy  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Random-move bot.")
    parser.add_argument("--url", default="ws://localhost:8787/ws")
    parser.add_argument(
        "--transport",
        choices=["websockets", "stdlib"],
        help="force a WebSocket implementation; default prefers websockets if installed",
    )
    parser.add_argument("--code", help="join an existing match by code")
    parser.add_argument("--create", metavar="GAME_ID", help="create a new match instead of joining")
    parser.add_argument("--name", default="RandomBot")
    parser.add_argument("--seed", type=int, help="seed the bot's own choices, for reproducibility")
    args = parser.parse_args()

    if not args.code and not args.create:
        parser.error("pass either --code to join or --create GAME_ID to host")

    rng = random.Random(args.seed)
    with GameConnection(args.url, transport=args.transport) as conn:
        print(f"Using the {conn.transport_name} WebSocket transport.")
        hello = conn.hello()
        if args.create:
            known = [g["id"] for g in hello["games"]]
            if args.create not in known:
                print(f"unknown game {args.create!r}; server offers: {', '.join(known)}")
                return 2
            conn.create(args.create, name=args.name)
            print(f"Match created. Share this code: {conn.code}")
            print(f"Or this link: http://localhost:8787/g/{conn.code}")
        else:
            conn.join(args.code, name=args.name)
            print(f"Joined {conn.code} as seat {conn.seat}.")

        print("Waiting for the match to start...")
        outcome = play(conn, random_strategy(rng), verbose=True)

    if not outcome or outcome.get("status") != "over":
        print("Match did not finish.")
        return 1
    winners = outcome.get("winners", [])
    if not winners:
        print(f"Draw ({outcome.get('reason')}).")
    elif conn.seat in winners:
        print(f"Bot won by {outcome.get('reason')}.")
    else:
        print(f"Bot lost ({outcome.get('reason')}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

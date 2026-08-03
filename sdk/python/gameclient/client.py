"""Client for the games server's WebSocket protocol.

This is the same protocol the web app speaks -- a bot is not a special kind of client, it is just a
client that happens to be a script. See ``docs/protocol.md`` for the frame reference.

The one affordance that makes non-TypeScript bots practical is :meth:`GameConnection.legal_actions`:
the server enumerates every legal move on request, so a bot never has to reimplement the rules of
the game it is playing.
"""

from __future__ import annotations

import itertools
import json
import os
import random
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, List, Optional

from .transport import Transport, connect as open_transport
from .ws import WebSocketClosed

PROTOCOL_VERSION = 1

_ids = itertools.count(1)


class ProtocolError(RuntimeError):
    pass


class Rejected(RuntimeError):
    """The server refused an action. ``snapshot`` is authoritative state to recover from."""

    def __init__(self, code: str, message: str, snapshot: Optional[Dict[str, Any]]):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.snapshot = snapshot


class GameConnection:
    """A seated connection to one match."""

    def __init__(
        self,
        url: str = "ws://localhost:8787/ws",
        timeout: float = 30.0,
        transport: Optional[str] = None,
    ):
        """Connect to a match server.

        `transport` selects the WebSocket implementation: ``"websockets"``, ``"stdlib"``, or the
        default ``None`` to prefer `websockets` when it is installed. The protocol is identical
        either way; see `transport.py` for why both exist.
        """
        self.ws: Transport = open_transport(url, timeout=timeout, prefer=transport)
        self.transport_name = self.ws.name
        self.timeout = timeout
        self._pending: List[Dict[str, Any]] = []
        self.games: List[Dict[str, Any]] = []
        self.snapshot: Optional[Dict[str, Any]] = None
        self.seat: Optional[int] = None
        self.code: Optional[str] = None
        self.game_id: Optional[str] = None
        self.session_token: Optional[str] = None
        self.log: List[Dict[str, Any]] = []

    # ------------------------------------------------------------------ plumbing

    def _absorb(self, frame: Dict[str, Any]) -> Dict[str, Any]:
        kind = frame.get("t")
        if kind == "hello_ok":
            self.games = frame.get("games", [])
        elif kind == "joined":
            self.seat = frame["seat"]
            self.code = frame["code"]
            self.game_id = frame["gameId"]
            self.session_token = frame["sessionToken"]
        elif kind in ("sync", "applied", "over", "rejected"):
            self.snapshot = frame["snapshot"]
            if kind == "sync":
                self.log = frame.get("log", [])
            elif kind == "applied":
                self.log.append(
                    {
                        "version": frame["snapshot"]["version"],
                        "seat": frame["seat"],
                        "at": frame.get("at"),
                        "effects": frame["effects"],
                    }
                )
        return frame

    def recv(self, timeout: Optional[float] = None) -> Dict[str, Any]:
        if self._pending:
            return self._pending.pop(0)
        return self._absorb(self.ws.recv_json(timeout=timeout or self.timeout))

    def wait_for(
        self,
        *kinds: str,
        predicate: Optional[Callable[[Dict[str, Any]], bool]] = None,
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Next frame whose ``t`` is in ``kinds``. Other frames are queued, not dropped."""
        for i, frame in enumerate(self._pending):
            if frame.get("t") in kinds and (predicate is None or predicate(frame)):
                return self._pending.pop(i)
        while True:
            frame = self._absorb(self.ws.recv_json(timeout=timeout or self.timeout))
            if frame.get("t") == "error" and "error" not in kinds:
                raise ProtocolError(f"{frame.get('code')}: {frame.get('message')}")
            if frame.get("t") in kinds and (predicate is None or predicate(frame)):
                return frame
            self._pending.append(frame)

    # ------------------------------------------------------------------ handshake

    def hello(self, session_token: Optional[str] = None) -> Dict[str, Any]:
        frame: Dict[str, Any] = {"t": "hello", "protocolVersion": PROTOCOL_VERSION}
        if session_token:
            frame["sessionToken"] = session_token
        self.ws.send_json(frame)
        return self.wait_for("hello_ok")

    def create(self, game_id: str, name: Optional[str] = None, options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        frame: Dict[str, Any] = {"t": "create", "gameId": game_id}
        if name:
            frame["name"] = name
        if options is not None:
            frame["options"] = options
        self.ws.send_json(frame)
        return self.wait_for("joined")

    def join(self, code: str, name: Optional[str] = None) -> Dict[str, Any]:
        frame: Dict[str, Any] = {"t": "join", "code": code.strip().upper()}
        if name:
            frame["name"] = name
        self.ws.send_json(frame)
        return self.wait_for("joined")

    # ------------------------------------------------------------------ play

    @property
    def version(self) -> int:
        return self.snapshot["version"] if self.snapshot else 0

    @property
    def view(self) -> Any:
        return self.snapshot["view"] if self.snapshot else None

    @property
    def my_turn(self) -> bool:
        return bool(self.snapshot and self.seat in self.snapshot.get("actors", []))

    @property
    def finished(self) -> bool:
        return bool(self.snapshot and self.snapshot["outcome"]["status"] == "over")

    @property
    def outcome(self) -> Optional[Dict[str, Any]]:
        return self.snapshot["outcome"] if self.snapshot else None

    def legal_actions(self) -> List[Any]:
        """Ask the server to enumerate this seat's legal moves."""
        self.ws.send_json({"t": "legalActions"})
        frame = self.wait_for("legal")
        return frame["actions"]

    def resync(self) -> Dict[str, Any]:
        self.ws.send_json({"t": "resync"})
        return self.wait_for("sync")

    def submit(self, action: Any) -> Dict[str, Any]:
        """Submit an action and block until the server accepts or refuses it.

        ``expectVersion`` guards against acting on a stale view, and ``clientActionId`` makes the
        submission idempotent -- resending after a hiccup replays the stored result rather than
        buying the same card twice.
        """
        action_id = f"py-{os.getpid()}-{next(_ids)}"
        self.ws.send_json(
            {
                "t": "action",
                "expectVersion": self.version,
                "clientActionId": action_id,
                "action": action,
            }
        )
        frame = self.wait_for(
            "applied",
            "rejected",
            predicate=lambda f: f.get("clientActionId") == action_id,
        )
        if frame["t"] == "rejected":
            raise Rejected(frame["code"], frame["message"], frame.get("snapshot"))
        return frame

    def request_undo(self) -> None:
        """Propose taking the last move back. Nothing happens unless the other player agrees."""
        self.ws.send_json({"t": "undoRequest"})

    def respond_undo(self, accept: bool) -> None:
        """Answer a pending ``undoProposed`` -- or withdraw your own request with ``False``.

        A bot that never calls this simply lets proposals lapse, which reads to the other player as
        no answer rather than as a refusal. If you want a bot that plays along, wait for
        ``undoProposed`` and call this; ``undoResolved`` says how it ended, and an accepted undo is
        followed by a ``sync`` that rewinds the board.
        """
        self.ws.send_json({"t": "undoRespond", "accept": accept})

    def wait_for_turn(self, timeout: Optional[float] = None) -> None:
        """Block until this seat may act, or the match ends."""
        while not self.my_turn and not self.finished:
            self.wait_for("sync", "applied", "over", "presence", timeout=timeout)

    def close(self) -> None:
        self.ws.close()

    def __enter__(self) -> "GameConnection":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()


Strategy = Callable[[Any, List[Any]], Any]


def play(
    conn: GameConnection,
    choose: Strategy,
    max_moves: int = 5000,
    verbose: bool = False,
    max_consecutive_rejections: int = 12,
) -> Optional[Dict[str, Any]]:
    """Drive a seated connection with ``choose(view, legal_actions) -> action`` until the match ends.

    Rejections are retried, because a stale version heals itself in one round trip. But a *run* of
    rejections means something is actually wrong -- a schema mismatch, say -- and retrying forever
    turns that into a silent hang instead of an error, so it gives up and raises.
    """
    rejections = 0
    for _ in range(max_moves):
        if conn.finished:
            return conn.outcome
        try:
            conn.wait_for_turn()
        except WebSocketClosed:
            return conn.outcome
        if conn.finished:
            return conn.outcome

        actions = conn.legal_actions()
        if not actions:
            # Not our turn after all; go back to waiting.
            continue
        action = choose(conn.view, actions)
        try:
            conn.submit(action)
            rejections = 0
        except Rejected as err:
            # The rejection carried authoritative state, so we are already repaired and can retry.
            rejections += 1
            if verbose:
                print(f"  rejected ({err.code}); retrying from version {conn.version}")
            if err.code == "RATE_LIMITED":
                time.sleep(0.25)
            elif rejections >= max_consecutive_rejections:
                raise ProtocolError(
                    f"{rejections} consecutive rejections; last was {err.code}: {err.message}. "
                    "The server is refusing moves it offered as legal."
                ) from err
            continue
    return conn.outcome


def create_match_http(base_url: str, game_id: str, options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Create a match over plain HTTP, so a code exists before any socket is opened."""
    body = json.dumps({"gameId": game_id, "options": options or {}}).encode()
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/matches",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as err:
        raise ProtocolError(f"create failed: {err.read().decode(errors='replace')}") from err


def random_strategy(rng: Optional[random.Random] = None) -> Strategy:
    picker = rng or random.Random()

    def choose(_view: Any, actions: List[Any]) -> Any:
        return picker.choice(actions)

    return choose

"""Transport selection for the protocol client.

Prefers the `websockets` library and falls back to the bundled standard-library client.

Why prefer `websockets`: it is the de facto standard, it is maintained and security-reviewed, and it
has spent years absorbing the parts of RFC 6455 that are easy to get subtly wrong — close handshakes,
fragmentation, keepalive timeouts, TLS and proxy edge cases. A bot SDK is not the place to maintain a
bespoke framing layer.

Why keep the fallback: `python3 bot.py` then works with nothing installed, which matters for a
self-hosted tool where the first thing you do is try an example. It is the same ~40-line interface
either way, so the cost is one small module rather than an ongoing tax.

Force one explicitly with `GAMECLIENT_TRANSPORT=websockets` or `=stdlib`, mainly so the test suite
can exercise both.
"""

from __future__ import annotations

import json
import os
from typing import Any, Optional

from .ws import WebSocket as StdlibWebSocket, WebSocketClosed, WebSocketError


class Transport:
    """The little that the protocol client needs from a WebSocket."""

    name = "unknown"

    def send_text(self, text: str) -> None:
        raise NotImplementedError

    def recv_text(self, timeout: Optional[float] = None) -> str:
        raise NotImplementedError

    def close(self) -> None:
        raise NotImplementedError

    def send_json(self, value: Any) -> None:
        self.send_text(json.dumps(value, separators=(",", ":")))

    def recv_json(self, timeout: Optional[float] = None) -> Any:
        return json.loads(self.recv_text(timeout=timeout))

    def __enter__(self) -> "Transport":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()


class StdlibTransport(Transport):
    """The bundled zero-dependency client."""

    name = "stdlib"

    def __init__(self, url: str, timeout: float):
        self._ws = StdlibWebSocket(url, timeout=timeout)

    def send_text(self, text: str) -> None:
        self._ws.send_text(text)

    def recv_text(self, timeout: Optional[float] = None) -> str:
        return self._ws.recv_text(timeout=timeout)

    def close(self) -> None:
        self._ws.close()


class WebsocketsTransport(Transport):
    """`websockets` >= 13, via its synchronous client."""

    name = "websockets"

    def __init__(self, url: str, timeout: float):
        from websockets.sync.client import connect

        # The server disables permessage-deflate: frames are a few KB, so compressing them costs more
        # CPU than it saves bytes. Matching that here avoids a pointless negotiation.
        self._ws = connect(url, open_timeout=timeout, compression=None, max_size=2**20)
        self._default_timeout = timeout

    def send_text(self, text: str) -> None:
        from websockets.exceptions import ConnectionClosed

        try:
            self._ws.send(text)
        except ConnectionClosed as err:
            raise WebSocketClosed(getattr(err, "code", 1006) or 1006, str(err)) from err

    def recv_text(self, timeout: Optional[float] = None) -> str:
        from websockets.exceptions import ConnectionClosed

        try:
            message = self._ws.recv(timeout=timeout if timeout is not None else self._default_timeout)
        except ConnectionClosed as err:
            # Normalise so callers only ever handle one closed-connection exception.
            raise WebSocketClosed(getattr(err, "code", 1006) or 1006, str(err)) from err
        if isinstance(message, bytes):
            # This protocol is JSON text only; a binary frame is not something we should see.
            raise WebSocketError("unexpected binary frame")
        return message

    def close(self) -> None:
        try:
            self._ws.close()
        except Exception:  # noqa: BLE001 - closing a dead socket is not worth raising over
            pass


def websockets_available() -> bool:
    try:
        from websockets.sync.client import connect  # noqa: F401
    except Exception:  # noqa: BLE001 - absent, or too old to have the sync client
        return False
    return True


def connect(url: str, timeout: float = 30.0, prefer: Optional[str] = None) -> Transport:
    """Open a connection using the best available transport."""
    choice = (prefer or os.environ.get("GAMECLIENT_TRANSPORT") or "auto").lower()

    if choice == "stdlib":
        return StdlibTransport(url, timeout)
    if choice == "websockets":
        if not websockets_available():
            raise WebSocketError(
                "GAMECLIENT_TRANSPORT=websockets but the websockets package (>=13, for its sync "
                "client) is not importable. Run: pip install 'websockets>=13'"
            )
        return WebsocketsTransport(url, timeout)
    if choice != "auto":
        raise WebSocketError(f"unknown transport {choice!r}; use 'websockets', 'stdlib' or 'auto'")

    return WebsocketsTransport(url, timeout) if websockets_available() else StdlibTransport(url, timeout)

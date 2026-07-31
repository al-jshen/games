"""Python client for the games server.

Uses the `websockets` package when it is installed, and falls back to a bundled standard-library
client so the examples run with nothing to install. See `transport.py` for the reasoning.

    pip install 'websockets>=13'     # recommended
"""

from .client import (
    PROTOCOL_VERSION,
    GameConnection,
    ProtocolError,
    Rejected,
    Strategy,
    create_match_http,
    play,
    random_strategy,
)
from .transport import Transport, connect, websockets_available
from .ws import WebSocket, WebSocketClosed, WebSocketError

__all__ = [
    "PROTOCOL_VERSION",
    "GameConnection",
    "ProtocolError",
    "Rejected",
    "Strategy",
    "Transport",
    "WebSocket",
    "WebSocketClosed",
    "WebSocketError",
    "connect",
    "create_match_http",
    "play",
    "random_strategy",
    "websockets_available",
]

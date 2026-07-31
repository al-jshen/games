"""A minimal RFC 6455 WebSocket client, using only the standard library.

Written from scratch rather than depending on ``websockets`` or ``websocket-client`` so that a bot
is genuinely ``python3 bot.py`` with nothing to install. That matters more than it sounds: the whole
argument for a tagged-JSON protocol is that a bot in any language is a short file, and a pip
install in front of that undercuts it.

Scope is deliberately narrow -- client side, text frames, no compression, no TLS-specific tuning --
which is exactly what this protocol needs. It does handle the things that actually bite: masking
(mandatory for clients), fragmented messages, and ping/close control frames arriving mid-stream.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import ssl
import struct
from typing import Any, Optional, Tuple
from urllib.parse import urlparse

_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONTINUATION = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA


class WebSocketError(RuntimeError):
    pass


class WebSocketClosed(WebSocketError):
    def __init__(self, code: int = 1006, reason: str = ""):
        super().__init__(f"websocket closed ({code}) {reason}".strip())
        self.code = code
        self.reason = reason


class WebSocket:
    """A blocking client connection. One thread only; not safe to share."""

    def __init__(self, url: str, timeout: float = 30.0):
        parsed = urlparse(url)
        secure = parsed.scheme == "wss"
        if parsed.scheme not in ("ws", "wss"):
            raise WebSocketError(f"unsupported scheme: {parsed.scheme}")
        host = parsed.hostname or "localhost"
        port = parsed.port or (443 if secure else 80)
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"

        raw = socket.create_connection((host, port), timeout=timeout)
        # Small JSON frames, so Nagle plus delayed ACK would add a silent ~40 ms per move.
        raw.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self._sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host) if secure else raw
        self._buffer = b""
        self._closed = False
        self._handshake(host, port, path, secure)

    # ------------------------------------------------------------------ handshake

    def _handshake(self, host: str, port: int, path: str, secure: bool) -> None:
        key = base64.b64encode(os.urandom(16)).decode()
        origin_port = "" if (secure and port == 443) or (not secure and port == 80) else f":{port}"
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}{origin_port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )
        self._sock.sendall(request.encode())

        header = b""
        while b"\r\n\r\n" not in header:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise WebSocketError("connection closed during handshake")
            header += chunk
        head, _, rest = header.partition(b"\r\n\r\n")
        self._buffer = rest

        status_line = head.split(b"\r\n")[0].decode(errors="replace")
        if "101" not in status_line:
            raise WebSocketError(f"handshake failed: {status_line}")

        expected = base64.b64encode(hashlib.sha1((key + _GUID).encode()).digest()).decode()
        got = ""
        for line in head.split(b"\r\n")[1:]:
            name, _, value = line.decode(errors="replace").partition(":")
            if name.strip().lower() == "sec-websocket-accept":
                got = value.strip()
        if got != expected:
            raise WebSocketError("handshake failed: bad Sec-WebSocket-Accept")

    # ------------------------------------------------------------------ io

    def _read_exact(self, count: int) -> bytes:
        while len(self._buffer) < count:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise WebSocketClosed(1006, "connection reset")
            self._buffer += chunk
        out, self._buffer = self._buffer[:count], self._buffer[count:]
        return out

    def _read_frame(self) -> Tuple[int, bool, bytes]:
        b0, b1 = self._read_exact(2)
        fin = bool(b0 & 0x80)
        opcode = b0 & 0x0F
        masked = bool(b1 & 0x80)
        length = b1 & 0x7F
        if length == 126:
            (length,) = struct.unpack(">H", self._read_exact(2))
        elif length == 127:
            (length,) = struct.unpack(">Q", self._read_exact(8))
        # A server must not mask, but tolerate it rather than desync the stream.
        mask = self._read_exact(4) if masked else b""
        payload = self._read_exact(length) if length else b""
        if masked:
            payload = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        return opcode, fin, payload

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        if self._closed:
            raise WebSocketClosed(1000, "already closed")
        header = bytearray([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", length)
        # Clients must mask every frame.
        mask = os.urandom(4)
        header += mask
        masked = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        self._sock.sendall(bytes(header) + masked)

    def send_text(self, text: str) -> None:
        self._send_frame(OP_TEXT, text.encode("utf-8"))

    def send_json(self, value: Any) -> None:
        self.send_text(json.dumps(value, separators=(",", ":")))

    def recv_text(self, timeout: Optional[float] = None) -> str:
        """Next complete text message. Control frames are handled transparently."""
        if timeout is not None:
            self._sock.settimeout(timeout)
        parts: list[bytes] = []
        message_opcode: Optional[int] = None

        while True:
            opcode, fin, payload = self._read_frame()

            if opcode == OP_CLOSE:
                code, reason = 1005, ""
                if len(payload) >= 2:
                    (code,) = struct.unpack(">H", payload[:2])
                    reason = payload[2:].decode("utf-8", errors="replace")
                self._closed = True
                raise WebSocketClosed(code, reason)
            if opcode == OP_PING:
                self._send_frame(OP_PONG, payload)
                continue
            if opcode == OP_PONG:
                continue

            if opcode in (OP_TEXT, OP_BINARY):
                message_opcode = opcode
                parts = [payload]
            elif opcode == OP_CONTINUATION:
                parts.append(payload)
            else:
                raise WebSocketError(f"unexpected opcode {opcode}")

            if fin:
                data = b"".join(parts)
                if message_opcode == OP_BINARY:
                    # This protocol is JSON only; ignore and wait for the next message.
                    parts, message_opcode = [], None
                    continue
                return data.decode("utf-8")

    def recv_json(self, timeout: Optional[float] = None) -> Any:
        return json.loads(self.recv_text(timeout=timeout))

    def close(self, code: int = 1000) -> None:
        if not self._closed:
            try:
                self._send_frame(OP_CLOSE, struct.pack(">H", code))
            except OSError:
                pass
            self._closed = True
        try:
            self._sock.close()
        except OSError:
            pass

    def __enter__(self) -> "WebSocket":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

"""Small deterministic redaction helpers for diagnostics and fixtures."""
from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


_SECRET_KEYS = frozenset({
    "api_key", "auth", "authorization", "client_secret", "cookie", "cookies",
    "credential", "credentials", "jwt", "password", "private_key", "proxy_password",
    "proxy_user", "proxy_username", "secret_key", "session", "session_id", "set_cookie",
    "signing_key", "token", "access_token", "refresh_token",
})


def _secret_key(value: Any) -> bool:
    raw = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", str(value or "").strip())
    normalized = re.sub(r"[^a-zA-Z0-9]+", "_", raw).strip("_").lower()
    return (
        normalized in _SECRET_KEYS
        or normalized.endswith(("_password", "_secret", "_token", "_api_key"))
    )


def redact_url(value: str) -> str:
    """Remove userinfo and secret-like query values from a URL."""
    try:
        parsed = urlsplit(str(value or ""))
    except ValueError:
        return "<invalid-url>"
    host = parsed.hostname or ""
    if parsed.port:
        host = f"{host}:{parsed.port}"
    query = []
    for key, item in parse_qsl(parsed.query, keep_blank_values=True):
        query.append((key, "***" if _secret_key(key) else item))
    fragment = "***" if parsed.fragment else ""
    return urlunsplit((parsed.scheme, host, parsed.path, urlencode(query), fragment))


def _redact_value(key: str, item: Any) -> Any:
    if isinstance(item, Mapping):
        return redact_mapping(item)
    if isinstance(item, Sequence) and not isinstance(item, (str, bytes, bytearray)):
        return [_redact_value("", value) for value in item]
    if isinstance(item, str) and ("url" in key.lower() or "://" in item):
        return redact_url(item)
    return item


def redact_mapping(value: Mapping[str, Any]) -> dict[str, Any]:
    """Recursively redact common secret fields while preserving evidence."""
    result: dict[str, Any] = {}
    for key, item in value.items():
        if _secret_key(key):
            result[str(key)] = "***"
        else:
            result[str(key)] = _redact_value(str(key), item)
    return result

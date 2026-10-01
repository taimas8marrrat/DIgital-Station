"""Базовая аутентификация: подписанный токен, две роли (dispatcher, admin)."""
import base64
import hashlib
import hmac
import time

from fastapi import Depends, HTTPException, Query, Request

from . import config

USERS = {
    config.ADMIN_USER: (config.ADMIN_PASSWORD, "admin"),
    config.DISPATCHER_USER: (config.DISPATCHER_PASSWORD, "dispatcher"),
}


def _sign(body: str) -> str:
    return hmac.new(config.AUTH_SECRET.encode(), body.encode(), hashlib.sha256).hexdigest()[:32]


def issue(user: str, role: str, ttl=12 * 3600) -> str:
    body = f"{user}:{role}:{int(time.time()) + ttl}"
    return base64.urlsafe_b64encode(f"{body}:{_sign(body)}".encode()).decode()


def verify(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        user, role, exp, sig = base64.urlsafe_b64decode(token.encode()).decode().split(":")
    except Exception:
        return None
    body = f"{user}:{role}:{exp}"
    if not hmac.compare_digest(sig, _sign(body)) or int(exp) < time.time():
        return None
    return {"user": user, "role": role}


def login(user: str, password: str) -> dict | None:
    u = USERS.get(user)
    if not u or not hmac.compare_digest(u[0], password):
        return None
    return {"token": issue(user, u[1]), "role": u[1], "user": user}


def current_user(request: Request, token: str | None = Query(default=None)):
    h = request.headers.get("authorization", "")
    tok = h[7:] if h.lower().startswith("bearer ") else token
    u = verify(tok)
    if not u:
        raise HTTPException(401, "Требуется вход")
    return u


def require_admin(u=Depends(current_user)):
    if u["role"] != "admin":
        raise HTTPException(403, "Только для роли admin")
    return u

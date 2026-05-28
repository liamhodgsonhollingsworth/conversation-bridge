"""Reference Conversation Bridge Protocol (CBP) v1 endpoint.

Implements GET /spec, GET /health, POST /events. Writes each accepted event
to BRIDGE_INBOX_DIR as <eventId>.json. Default inbox: ~/.bridge-inbox/.

Usage:
    pip install -r requirements.txt
    python server.py
    # or, with custom inbox + port:
    BRIDGE_INBOX_DIR=/path/to/inbox BRIDGE_PORT=8000 python server.py

Authentication is optional. If you set BRIDGE_AUTH_TOKEN, the endpoint will
require Authorization: Bearer <token> on POST /events.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

VERSION = "0.1.0"
PROTOCOL_VERSION = 1
INBOX_DIR = Path(os.environ.get("BRIDGE_INBOX_DIR", str(Path.home() / ".bridge-inbox"))).expanduser()
AUTH_TOKEN = os.environ.get("BRIDGE_AUTH_TOKEN")  # optional
HMAC_SECRET = os.environ.get("BRIDGE_HMAC_SECRET")  # optional
ENDPOINT_NAME = os.environ.get("BRIDGE_ENDPOINT_NAME", "Local Bridge Inbox")
DATA_FLOW = os.environ.get(
    "BRIDGE_DATA_FLOW",
    f"Writes each event as JSON to {INBOX_DIR} on the local disk. Files are kept until manually deleted. No network egress.",
)

INBOX_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Conversation Bridge Reference Endpoint", version=VERSION)


# CORS: extension content scripts make these requests from chrome-extension://,
# but background fetch uses host_permissions and skips CORS. We allow * for
# convenience on localhost.
@app.middleware("http")
async def cors(request: Request, call_next):
    if request.method == "OPTIONS":
        return JSONResponse({}, headers=_cors_headers())
    resp = await call_next(request)
    for k, v in _cors_headers().items():
        resp.headers[k] = v
    return resp


def _cors_headers() -> dict[str, str]:
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
    }


@app.get("/spec")
def get_spec() -> dict:
    return {
        "name": ENDPOINT_NAME,
        "version": VERSION,
        "accepts": ["conversation.complete", "conversation.captured", "manual.push"],
        "dataFlow": DATA_FLOW,
        "contact": "https://github.com/liamhodgsonhollingsworth/conversation-bridge",
        "repository": "https://github.com/liamhodgsonhollingsworth/conversation-bridge",
    }


@app.get("/health")
def get_health() -> dict:
    return {"status": "ready" if INBOX_DIR.exists() else "degraded"}


@app.post("/events")
async def post_event(
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict:
    if AUTH_TOKEN:
        expected = f"Bearer {AUTH_TOKEN}"
        if authorization != expected:
            raise HTTPException(status_code=401, detail="invalid or missing bearer token")

    raw = await request.body()
    try:
        event = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="body is not valid JSON")

    if HMAC_SECRET:
        sig = event.pop("signature", None)
        if not sig:
            raise HTTPException(status_code=401, detail="missing signature")
        # The client signs the body before adding the signature field.
        body_without_sig = json.dumps(event, separators=(",", ":"), ensure_ascii=False)
        expected_sig = hmac.new(
            HMAC_SECRET.encode("utf-8"),
            body_without_sig.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(sig, expected_sig):
            raise HTTPException(status_code=401, detail="signature mismatch")

    event_id = event.get("id")
    if not event_id or not isinstance(event_id, str):
        raise HTTPException(status_code=400, detail="event.id missing or invalid")

    safe_id = "".join(c for c in event_id if c.isalnum() or c in "-_")
    path = INBOX_DIR / f"{safe_id}.json"
    path.write_text(json.dumps(event, indent=2, ensure_ascii=False), encoding="utf-8")
    return {"accepted": True, "eventId": event_id}


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("BRIDGE_PORT", "8000"))
    print(f"Conversation Bridge endpoint listening on http://localhost:{port}")
    print(f"Inbox: {INBOX_DIR}")
    if AUTH_TOKEN:
        print("Bearer-token auth: REQUIRED")
    else:
        print("Bearer-token auth: disabled (set BRIDGE_AUTH_TOKEN to enable)")
    uvicorn.run(app, host="127.0.0.1", port=port)

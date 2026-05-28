# Reference Conversation Bridge endpoint (Python)

A minimal CBP v1 endpoint in ~100 lines of Python. Implements `/spec`,
`/health`, and `/events`. Stores received events as JSON files on disk.

## Setup

```bash
pip install -r requirements.txt
python server.py
```

The server starts on `http://localhost:8000` and writes events to
`~/.bridge-inbox/<eventId>.json`.

## Configuration

Environment variables:

| Var                    | Default                                    | Meaning                                            |
|------------------------|--------------------------------------------|----------------------------------------------------|
| `BRIDGE_PORT`          | `8000`                                     | Listen port                                        |
| `BRIDGE_INBOX_DIR`     | `~/.bridge-inbox/`                         | Where event JSON files are written                 |
| `BRIDGE_AUTH_TOKEN`    | (unset)                                    | If set, requires `Authorization: Bearer <token>`   |
| `BRIDGE_HMAC_SECRET`   | (unset)                                    | If set, requires HMAC-SHA256 signature on events   |
| `BRIDGE_ENDPOINT_NAME` | `Local Bridge Inbox`                       | Friendly name shown in the extension's trust UI    |
| `BRIDGE_DATA_FLOW`     | `Writes each event...`                     | Text shown in the extension's trust UI             |

## Adapting for project-specific routing

The extension is agnostic about what your endpoint does with events.
This reference writes them to a flat directory; your own endpoint might
instead:

- Append them to a database
- Forward them to a message queue
- Trigger a webhook
- Write them into a structured inbox (e.g. an Alethea `Alethea-cc/inbox/`)

For project-specific cases, fork or copy this server and replace the
`path.write_text(...)` call in `post_event()` with your routing logic.
The rest of the protocol — `/spec`, `/health`, auth, HMAC — stays the same.

## Verifying the install

After starting the server, in another terminal:

```bash
curl http://localhost:8000/spec
curl http://localhost:8000/health
```

Then sideload the Conversation Bridge extension, click "+ Add", point at
`http://localhost:8000`, and walk through the trust screen.

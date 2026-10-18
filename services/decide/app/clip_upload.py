"""Decide-runner clip upload client (ADAAAA-6741 G4).

Uploads a clip the decide runner built from its stash to the server, which
persists + publishes it (server = clip store + feed/entitlement layer). The
server endpoint is ``POST /jobs/:id/clips`` (multipart: ``clip`` file +
``metadata`` JSON) — see ``services/server/src/api.ts``.

The client is injectable (a plain function) so the build-or-discard path can be
unit-tested without a live server; production wires it from ``CLIP_UPLOAD_BASE``.
"""
from __future__ import annotations

import json
import os
from typing import Callable, Optional

import httpx


def upload_clip(
    server_base: str,
    job_id: str,
    clip_path: str,
    metadata: dict,
    timeout_s: float = 120.0,
    client: Optional[httpx.Client] = None,
) -> dict:
    """POST a built clip to the server and return the parsed response.

    Returns ``{"ok": True, "id", "clipUri"}`` on success, or
    ``{"ok": False, "status", "error"}`` — never raises for an HTTP error.
    """
    base = (server_base or "").strip().rstrip("/")
    if not base:
        return {"ok": False, "error": "no CLIP_UPLOAD_BASE configured"}
    url = f"{base}/jobs/{job_id}/clips"
    data = {"metadata": json.dumps(metadata)}
    try:
        if client is not None:
            with open(clip_path, "rb") as fh:
                r = client.post(
                    url,
                    files={"clip": (os.path.basename(clip_path), fh, "video/mp4")},
                    data=data,
                    timeout=timeout_s,
                )
        else:
            with open(clip_path, "rb") as fh:
                r = httpx.post(
                    url,
                    files={"clip": (os.path.basename(clip_path), fh, "video/mp4")},
                    data=data,
                    timeout=timeout_s,
                )
    except Exception as e:  # network-level failure
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    body = {}
    try:
        body = r.json() if r.content else {}
    except Exception:
        body = {"raw": r.text[:400]}
    ok = 200 <= r.status_code < 300
    return {"ok": ok, "status": r.status_code, "id": body.get("id"), "clipUri": body.get("clipUri"), **body}


def make_upload_client(server_base: str) -> Callable[[str, dict], dict]:
    """Return an ``upload(clip_path, metadata) -> dict`` closure for the stash's
    build-or-discard path, bound to ``server_base``."""
    def upload(clip_path: str, metadata: dict) -> dict:
        job_id = metadata.get("jobId") or ""
        return upload_clip(server_base, job_id, clip_path, metadata)
    return upload


def upload_base_from_env() -> str:
    return os.environ.get("CLIP_UPLOAD_BASE", "").strip().rstrip("/")

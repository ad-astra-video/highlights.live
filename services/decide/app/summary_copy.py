"""ADAAAA-8668 — the `summary` (body-copy) text runner.

Why this is its OWN module and not a function in `gemma.py`: the decide prompt and
the decide contract are frozen for this increment (spec ADAAAA-8665 §3, AC3 —
"`git diff` on those files must be empty"), and `gemma.py` is the decide prompt's
home. Body copy is a SEPARATE lane that must never be able to change a verdict,
the decide schema or the window prompt, so it lives here:

* one text-only chat completion, retried by the CALLER (the server's
  post-promotion lane), never here;
* the prompt is composed by the server from the row's own evidence
  (`packages/events/src/highlight-summary.ts`), so the prompt contract is
  snapshot-tested in one place and this module stays a thin runner;
* the reply is gated by the server (`gateSummaryDetail`), so this module returns
  raw text and never decides whether copy may ship;
* any failure returns `None`. There is deliberately NO deterministic fallback: a
  drop is a drop, and the card serves on its headline. A synthesised sentence
  would be exactly the placeholder the spec forbids.
"""
import logging
import os

log = logging.getLogger("highlights.decide.summary")

DEFAULT_GEMMA_URL = "http://127.0.0.1:8088"


def summary_with_gemma(
    prompt: str,
    url: str | None = None,
    timeout_s: float = 2.5,
    max_words: int = 70,
) -> str | None:
    """Run the server-composed body-copy prompt through a text-only Gemma call.

    Returns the raw sentence(s) on success, `None` on any transport/parse failure
    or an empty reply. No images, no audio, no tool block: this is one text-only
    completion, which is why it can ride the lowest priority of the decide pool
    without touching the live detect path.
    """
    import httpx

    body = (prompt or "").strip()
    if not body:
        return None
    payload = {
        "messages": [{"role": "user", "content": body}],
        # Copy, not a verdict: a little headroom keeps the sentences from reading
        # like a template, while the server gate still enforces the depth band.
        "temperature": 0.2,
        "reasoning_effort": "none",
        "chat_template_kwargs": {"enable_thinking": False},
        # ~2 tokens/word plus headroom for the clamp's over-length buffer.
        "max_tokens": max(160, int(max_words * 2)),
        "stream": False,
    }
    model = os.environ.get("GEMMA_MODEL")
    if model:
        payload["model"] = model
    u = url or os.environ.get("GEMMA_URL", DEFAULT_GEMMA_URL)
    try:
        resp = httpx.post(u.rstrip("/") + "/v1/chat/completions", json=payload, timeout=timeout_s)
        resp.raise_for_status()
        text = resp.json()["choices"][0]["message"]["content"]
    except Exception as e:  # noqa: BLE001
        log.error("gemma summary call failed url=%s: %s", u, e)
        return None
    out = (text or "").strip().strip('"').strip()
    if not out:
        return None
    # Hard transport ceiling; the server's clamp/gate owns the real band.
    return out[:1400]

"""App logging configuration for highlights-decide.

The decide app has no app loggers wired at all (the /highlight and /plan
handlers emit nothing), so an operator has no signal on how a candidate was
scored. This module configures the ``highlights.decide`` namespace from the
``DECIDE_LOG_LEVEL`` env var at app startup: the default ``INFO`` logs a
decision summary per /highlight and /plan call, while ``DEBUG`` adds the
per-candidate and full gemma invocation/result detail.
"""

from __future__ import annotations

import logging
import os

NAMESPACE = "highlights.decide"


def configure_logging(default_level: str = "INFO") -> logging.Logger:
    """Configure the decide namespace logger from ``DECIDE_LOG_LEVEL``.

    Sets the namespace root logger's level (default ``INFO``) and attaches a
    console ``StreamHandler`` so the app loggers actually emit. Child loggers
    (``highlights.decide`` handlers / ``.gemma`` / ``.decider``) propagate to
    this parent, so a single knob controls the whole namespace. Idempotent:
    re-running only re-sets the level and never stacks handlers.
    """
    raw = os.environ.get("DECIDE_LOG_LEVEL", default_level).strip().upper()
    level = getattr(logging, raw, logging.INFO)
    if not isinstance(level, int):
        level = logging.INFO
    lg = logging.getLogger(NAMESPACE)
    lg.setLevel(level)
    if not lg.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)-7s %(name)s %(message)s")
        )
        lg.addHandler(handler)
    return lg

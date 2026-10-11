"""App logging configuration for highlights-perceive.

The perceive app loggers (``highlights.perceive.*``) have no log-level wiring,
so they run at the Python root default and emit effectively nothing at runtime.
This module configures the ``highlights.perceive`` namespace from the
``PERCEIVE_LOG_LEVEL`` env var at app startup, so an operator can flip the
runtime detail (default lifecycle-only vs DEBUG per-frame) without a rebuild.
"""

from __future__ import annotations

import logging
import os

NAMESPACE = "highlights.perceive"


def configure_logging(default_level: str = "INFO") -> logging.Logger:
    """Configure the perceive namespace logger from ``PERCEIVE_LOG_LEVEL``.

    Sets the namespace root logger's level (default ``INFO``) and attaches a
    console ``StreamHandler`` so the app loggers actually emit. Child loggers
    (``highlights.perceive.trickle`` / ``.florence`` / ``.preload``) propagate
    to this parent, so a single knob controls the whole namespace. Idempotent:
    re-running only re-sets the level and never stacks handlers.
    """
    raw = os.environ.get("PERCEIVE_LOG_LEVEL", default_level).strip().upper()
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

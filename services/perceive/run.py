import os

import uvicorn

from app import create_app

app = create_app()

# Drive uvicorn's own log level from the same env knob that configures the
# highlights.perceive.* app loggers (ADAAAA-6525), so an operator can set the
# whole service to DEBUG for per-frame detail without a rebuild.
_UV_LOG = os.environ.get("PERCEIVE_LOG_LEVEL", "info").strip().lower()
_UV_LOG = _UV_LOG if _UV_LOG in ("debug", "info", "warning", "error", "critical") else "info"

if __name__ == "__main__":
    uvicorn.run("run:app", host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), log_level=_UV_LOG)

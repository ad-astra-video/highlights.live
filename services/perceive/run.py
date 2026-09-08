import os

import uvicorn

from app import create_app

app = create_app()

if __name__ == "__main__":
    uvicorn.run("run:app", host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), log_level="info")

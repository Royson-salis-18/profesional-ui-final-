from .service import app  # noqa: F401
import uvicorn

if __name__ == "__main__":
    uvicorn.run("core.service:app", host="127.0.0.1", port=8000)

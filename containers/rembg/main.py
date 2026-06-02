"""Single-endpoint bg-removal HTTP service.

Receives image bytes, returns image bytes with the subject composited
onto solid black. The cast portrait flow on the Worker side pipes every
uploaded or generated portrait through this before storing it in R2,
so the vivijure-serverless regional render path's IP-Adapter always
sees a clean isolated-subject conditioning input (no busy bg to confuse
the CLIP encoder, no specific bg color to leak into the keyframe).

Why solid black: SDXL treats black plates as "the prompt and LoRA are
what matter here" rather than as a color signal. Other neutral colors
(white, gray) DO bias the rendered backdrop. Tested on smoke v26.

The container instance stays warm between calls (sleepAfter set in the
Worker's wrangler.toml). u2net.onnx is baked into the image at build
time and the rembg session is initialized once at module-load so per-
request latency is ~200-500 ms for a 1024 x 1024 portrait on a basic
container instance.
"""
import io
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, Response
from PIL import Image
from rembg import new_session, remove

# Module-level singleton: the rembg ONNX session. Built once at process
# start; reused across requests. Saves the ~50 ms session-init on every
# call after the first.
_SESSION = new_session("u2net")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Health check log on startup so the container logs make it obvious
    # the model loaded cleanly.
    print("[rembg] u2net session ready, ready to clean", flush=True)
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)


@app.get("/")
def health() -> dict:
    """Trivial health probe. Returns 200 once the rembg session is loaded."""
    return {"ok": True, "model": "u2net"}


@app.post("/clean")
async def clean(request: Request) -> Response:
    """Remove the background from the posted image and composite onto
    solid black. Body in: raw image bytes (png/jpeg/webp). Body out:
    png bytes (always png so the alpha mask roundtrips through Pillow
    losslessly even though the final image is RGB).
    """
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="empty body")
    if len(body) > 16 * 1024 * 1024:
        # Match the Worker side cast image cap so a misrouted huge body
        # surfaces clearly rather than OOMing the container.
        raise HTTPException(status_code=413, detail="image too large (16 MB cap)")

    try:
        src = Image.open(io.BytesIO(body)).convert("RGBA")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"could not decode image: {e}")

    # rembg returns the same-size image with an alpha channel set from
    # the predicted subject mask.
    cut = remove(src, session=_SESSION)

    # Composite onto a solid black plate. Use the alpha channel as the
    # mask so subject pixels stay pixel-exact (rembg never modifies the
    # subject RGB; only alpha).
    black = Image.new("RGB", cut.size, (0, 0, 0))
    black.paste(cut, (0, 0), mask=cut.split()[3])

    buf = io.BytesIO()
    black.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")

# Single-purpose background-removal service for the cast portrait flow.
#
# The Phase R regional render path on vivijure-serverless feeds each
# cast member's saved portrait into the SDXL IP-Adapter as the visual
# conditioning input for that slot's mask region. If the portrait
# contains a backdrop (studio gray, environmental forest, anything),
# the IP-Adapter projects that backdrop into the rendered keyframe.
# The fix proven in smoke v26: subject-on-pure-black portraits. This
# container is the thing that makes that subject-on-black step
# transparent to users.
#
# Single endpoint: POST /clean
#   request body: image bytes (png/jpeg/webp)
#   response body: png bytes, subject composited onto solid black
#
# u2net.onnx is baked into the image at build time so cold-start
# does not include the 176 MB model download. Container instance
# stays warm for sleepAfter (see wrangler.toml) so warm hits are
# sub-second.

FROM python:3.12-slim

# System deps for PIL/Pillow image decoding (libjpeg, zlib, etc) +
# minimal C toolchain for any onnxruntime native bits.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libjpeg62-turbo \
        libpng16-16 \
        zlib1g \
        ca-certificates \
        wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# pip-install rembg + onnxruntime + fastapi/uvicorn. Pinned versions
# match what was validated locally (rembg 2.0.75, onnxruntime 1.26).
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Bake the u2net.onnx model into the image so first-request latency
# does not include the 176 MB GitHub-releases download. rembg looks
# for the model under $HOME/.u2net/u2net.onnx by default, so we put
# it there. /root is HOME inside the container.
RUN mkdir -p /root/.u2net && \
    wget -qO /root/.u2net/u2net.onnx \
        https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx && \
    test -s /root/.u2net/u2net.onnx

# Warm the rembg session at build time so the first request after a
# cold start does not include the (small) ONNX session init.
RUN python -c "from rembg import new_session; s = new_session('u2net'); print('session warm')"

COPY main.py /app/main.py

ENV PORT=8080
EXPOSE 8080

# uvicorn directly; one worker is fine for the request profile (one
# rembg pass at a time per container instance).
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]

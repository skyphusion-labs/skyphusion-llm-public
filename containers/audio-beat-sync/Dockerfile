# syntax=docker/dockerfile:1
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    NUMBA_CACHE_DIR=/tmp/numba-cache \
    MPLCONFIGDIR=/tmp/mpl-cache \
    LIBROSA_CACHE_DIR=/tmp/librosa-cache \
    HF_HUB_OFFLINE=1 \
    PORT=8000

# libsndfile backs soundfile (librosa's IO); ffmpeg covers MP3/AAC/OGG decode;
# libgomp1 is the OpenMP runtime numpy/numba link against.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg libsndfile1 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app.py .

# Eager-load librosa + JIT the beat tracker at build time so the first request
# does not pay the numba compile cost. Caches land under /tmp (writable in the
# CF runtime); never rely on /dev/shm.
RUN python -c "import librosa, numpy; librosa.beat.beat_track(y=numpy.zeros(22050, dtype='float32'), sr=22050); print('warm OK')"

EXPOSE 8000
CMD ["python", "app.py"]

// Conversational STT client (v0.104.0).
//
// Streams mic audio to /api/stt/stream (a WebSocket proxy to
// @cf/deepgram/flux) as linear16 PCM @ 16 kHz mono, and renders the Deepgram
// turn/transcript events that come back. CF Access auth rides the WS upgrade
// via the same-origin cookie, so no token handling is needed here.
//
// Phase 1: standalone widget, no history persistence. The raw-events panel is
// intentionally verbose so the first real mic test confirms the actual event
// field names (Deepgram's docs list type, transcript, words[],
// end_of_turn_confidence, but the live shapes are what matter).

(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const startBtn = $("#stt-start");
  const statusEl = $("#stt-status");
  const liveEl = $("#stt-live");
  const turnsEl = $("#stt-turns");
  const debugEl = $("#stt-debug");

  let ws = null;
  let audioCtx = null;
  let source = null;
  let processor = null;
  let stream = null;
  let running = false;
  let interim = "";

  function setStatus(s) { statusEl.textContent = s; }

  function debug(obj) {
    const row = document.createElement("div");
    row.className = "stt-debug-row";
    row.textContent = typeof obj === "string" ? obj : JSON.stringify(obj);
    debugEl.prepend(row);
    while (debugEl.childElementCount > 200) debugEl.removeChild(debugEl.lastChild);
  }

  function renderLive() {
    liveEl.innerHTML = "";
    if (interim) {
      const span = document.createElement("span");
      span.className = "stt-live-interim";
      span.textContent = interim;
      liveEl.appendChild(span);
    } else {
      liveEl.innerHTML = '<span class="stt-status">(listening…)</span>';
    }
  }

  function commitTurn(text, meta) {
    if (!text) return;
    const div = document.createElement("div");
    div.className = "stt-turn";
    div.textContent = text;
    if (meta) {
      const m = document.createElement("div");
      m.className = "stt-meta";
      m.textContent = meta;
      div.appendChild(m);
    }
    turnsEl.prepend(div);
  }

  // Pull a transcript string out of whatever event shape arrives. Deepgram
  // Flux puts it on `transcript`; fall back to a few likely spots.
  function transcriptOf(ev) {
    if (typeof ev.transcript === "string") return ev.transcript;
    if (Array.isArray(ev.words)) return ev.words.map((w) => w.word ?? w.text ?? "").join(" ").trim();
    if (typeof ev.text === "string") return ev.text;
    return "";
  }

  function handleEvent(ev) {
    debug(ev);
    const type = ev.type || ev.event || "";
    const text = transcriptOf(ev);
    switch (type) {
      case "StartOfTurn":
        interim = ""; renderLive(); break;
      case "Update":
        interim = text; renderLive(); break;
      case "EagerEndOfTurn":
        interim = text; renderLive(); break;
      case "TurnResumed":
        renderLive(); break;
      case "EndOfTurn": {
        const conf = ev.end_of_turn_confidence;
        commitTurn(text || interim, conf != null ? `end of turn · confidence ${conf}` : "end of turn");
        interim = ""; renderLive(); break;
      }
      default:
        // Unknown/initial events (e.g. a connected/metadata frame): if it
        // carries text, show it as interim so nothing is silently dropped.
        if (text) { interim = text; renderLive(); }
        break;
    }
  }

  function beginCapture() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    // Ask for a 16 kHz context so the browser resamples mic audio for us.
    audioCtx = new Ctx({ sampleRate: 16000 });
    source = audioCtx.createMediaStreamSource(stream);
    // ScriptProcessor is deprecated but dependency-free and universally
    // supported; fine for a Phase-1 playground widget.
    processor = audioCtx.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(audioCtx.destination);
    processor.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const f32 = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      ws.send(i16.buffer);
    };
  }

  function teardownAudio() {
    try { if (processor) { processor.disconnect(); processor.onaudioprocess = null; } } catch (_) {}
    try { if (source) source.disconnect(); } catch (_) {}
    try { if (audioCtx) audioCtx.close(); } catch (_) {}
    try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    processor = source = audioCtx = stream = null;
  }

  async function start() {
    if (running) return;
    running = true;
    startBtn.textContent = "Stop";
    startBtn.classList.add("is-live");
    setStatus("requesting microphone…");
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      setStatus("microphone denied: " + (err && err.message ? err.message : err));
      return stop();
    }

    setStatus("connecting…");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/api/stt/stream`);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => { setStatus("listening, speak now"); interim = ""; renderLive(); beginCapture(); };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return; // events are JSON text; ignore any binary
      let ev;
      try { ev = JSON.parse(e.data); } catch { debug("non-JSON frame: " + e.data); return; }
      handleEvent(ev);
    };
    ws.onerror = () => setStatus("socket error (see console)");
    ws.onclose = (e) => { setStatus(`closed (code ${e.code}${e.reason ? ", " + e.reason : ""})`); teardownAudio(); };
  }

  function stop() {
    running = false;
    startBtn.textContent = "Start listening";
    startBtn.classList.remove("is-live");
    teardownAudio();
    try { if (ws && ws.readyState <= 1) ws.close(1000, "client stop"); } catch (_) {}
    ws = null;
    if (statusEl.textContent.startsWith("listening")) setStatus("stopped");
  }

  startBtn.addEventListener("click", () => (running ? stop() : start()));
  window.addEventListener("beforeunload", stop);
})();

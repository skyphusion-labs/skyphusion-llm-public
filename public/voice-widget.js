// Voice/STT building blocks (v0.108.0; createMicStreamer added v0.118.0).
//
// createMicStreamer: low-level mic capture -> linear16 PCM @ 16 kHz -> the
// /api/stt/stream WebSocket (SttSession DO -> @cf/deepgram/flux), parsing the
// Deepgram turn/event JSON frames. Returns { stop, setMuted }. Shared by the
// standalone STT panel (/stt.html) and the hands-free voice-chat loop in app.js.
//
// createVoiceWidget: the standalone STT panel UI (live captions + committed
// turns), built on createMicStreamer.
(function () {
  "use strict";

  window.createMicStreamer = function createMicStreamer(opts) {
    const onEvent = (opts && opts.onEvent) || function () {};
    const onStatus = (opts && opts.onStatus) || function () {};
    const onClose = (opts && opts.onClose) || function () {};
    let ws = null, audioCtx = null, source = null, processor = null, stream = null;
    let muted = false, stopped = false;

    function beginCapture() {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx({ sampleRate: 16000 });
      source = audioCtx.createMediaStreamSource(stream);
      // ScriptProcessor: deprecated but dependency-free + universal.
      processor = audioCtx.createScriptProcessor(4096, 1, 1);
      source.connect(processor);
      processor.connect(audioCtx.destination);
      processor.onaudioprocess = (e) => {
        if (muted || !ws || ws.readyState !== WebSocket.OPEN) return;
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
      onStatus("requesting microphone…");
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
      } catch (err) {
        onStatus("microphone denied: " + (err && err.message ? err.message : err));
        stop();
        return;
      }
      onStatus("connecting…");
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/api/stt/stream`);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => { onStatus("listening"); beginCapture(); };
      ws.onmessage = (e) => {
        if (typeof e.data !== "string") return; // events are JSON text; ignore binary
        let ev;
        try { ev = JSON.parse(e.data); } catch { return; }
        onEvent(ev);
      };
      ws.onerror = () => onStatus("socket error");
      ws.onclose = (e) => { teardownAudio(); if (!stopped) onClose(e); };
    }

    function stop() {
      stopped = true;
      teardownAudio();
      try { if (ws && ws.readyState <= 1) ws.close(1000, "client stop"); } catch (_) {}
      ws = null;
    }

    start();
    // setMuted pauses sending PCM (e.g. while the assistant is speaking) without
    // tearing down the socket, so the session/turn context stays intact.
    return { stop, setMuted: (m) => { muted = !!m; } };
  };

  window.createVoiceWidget = function createVoiceWidget(els) {
    const { startBtn, statusEl, liveEl, turnsEl, debugEl } = els;
    let streamer = null;
    let running = false;
    let interim = "";

    function setStatus(s) { if (statusEl) statusEl.textContent = s; }

    function debug(obj) {
      if (!debugEl) return;
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
          if (text) { interim = text; renderLive(); }
          break;
      }
    }

    function start() {
      if (running) return;
      running = true;
      startBtn.textContent = "Stop";
      startBtn.classList.add("is-live");
      interim = ""; renderLive();
      streamer = window.createMicStreamer({
        onEvent: handleEvent,
        onStatus: (s) => setStatus(s === "listening" ? "listening, speak now" : s),
        onClose: (e) => { setStatus(`closed (code ${e.code}${e.reason ? ", " + e.reason : ""}) · saved to history`); stop(); },
      });
    }

    function stop() {
      running = false;
      startBtn.textContent = "Start listening";
      startBtn.classList.remove("is-live");
      if (streamer) { streamer.stop(); streamer = null; }
      if (statusEl && statusEl.textContent.startsWith("listening")) setStatus("stopped");
    }

    startBtn.addEventListener("click", () => (running ? stop() : start()));
    window.addEventListener("beforeunload", stop);

    return { stop, isRunning: () => running };
  };
})();

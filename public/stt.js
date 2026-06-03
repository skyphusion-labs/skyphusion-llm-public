// Standalone /stt.html init (v0.108.0): mount the shared voice widget on the
// page's elements. The widget logic lives in voice-widget.js (also used by the
// main chat composer's "voice" affordance). Sessions persist to /history via
// the SttSession Durable Object behind /api/stt/stream.
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  if (typeof window.createVoiceWidget !== "function") return;
  window.createVoiceWidget({
    startBtn: $("#stt-start"),
    statusEl: $("#stt-status"),
    liveEl: $("#stt-live"),
    turnsEl: $("#stt-turns"),
    debugEl: $("#stt-debug"),
  });
})();

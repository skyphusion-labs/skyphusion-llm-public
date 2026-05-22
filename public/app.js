// skyphusion-llm-public frontend. Model-type aware:
//   - chat: text + optional image/audio/video attachments, output is text
//   - image: text prompt (system_prompt becomes negative prompt), output is image
//   - tts: text only, output is audio
//
// Input artifacts are sent as data URLs and stored server-side in R2. Output
// artifacts (generated images, generated audio) are returned as R2 keys and
// rendered via /api/artifact/{key}.

const $ = (sel) => document.querySelector(sel);

const modelSelect       = $("#model");
const systemPromptLabel = $("#system-prompt-label");
const systemPrompt      = $("#system-prompt");
const userInputLabel    = $("#user-input-label");
const userInput         = $("#user-input");
const runBtn            = $("#run");
const output            = $("#output");
const outputMeta        = $("#output-meta");
const historyList       = $("#history-list");
const userBadge         = $("#user-badge");
const newChatBtn        = $("#new-chat");
const fileInput         = $("#file-input");
const attachBtn         = $("#attach-btn");
const attachHint        = $("#attach-hint");
const attachments       = $("#attachments");
const loadedAttachments = $("#loaded-attachments");
const outputArtifactEl  = $("#output-artifact");
const attachRow         = $("#attach-row");
const sidebarToggle     = $("#sidebar-toggle");
const sidebarBackdrop   = $("#sidebar-backdrop");
const layout            = document.querySelector(".layout");

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const IMAGE_MAX_DIM   = 1280;
const VIDEO_FRAMES    = 8;
const VIDEO_FRAME_MAX_DIM = 1024;

const state = {
  user: null,
  currentChatId: null,
  modelsById: {},
  pendingAttachments: [],
  pollTimer: null,
  pollChatId: null,
  pollStartedAt: 0,
  pollElapsedTimer: null,
};

// ---------- API helpers ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function artifactUrl(key) {
  return `/api/artifact/${encodeURI(key)}`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtMeta(chat) {
  const parts = [];
  if (chat.tokens_in  != null) parts.push(`in: ${chat.tokens_in}`);
  if (chat.tokens_out != null) parts.push(`out: ${chat.tokens_out}`);
  if (chat.latency_ms != null) parts.push(`${chat.latency_ms}ms`);
  return parts.join(" \u00b7 ");
}

// ---------- Models ----------

async function loadModels() {
  const { models, user } = await api("/api/models");
  state.user = user;
  userBadge.textContent = user;

  state.modelsById = {};
  const grouped = {};
  for (const m of models) {
    state.modelsById[m.id] = m;
    const g = m.group || "Other";
    (grouped[g] ||= []).push(m);
  }

  modelSelect.innerHTML = Object.entries(grouped)
    .map(([group, items]) => {
      const opts = items
        .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}</option>`)
        .join("");
      return `<optgroup label="${escapeHtml(group)}">${opts}</optgroup>`;
    })
    .join("");

  updateAffordance();
}

function currentModel() {
  return state.modelsById[modelSelect.value];
}

function modelSupports(cap) {
  const m = currentModel();
  return !!m && (m.capabilities || []).includes(cap);
}

function updateAffordance() {
  const m = currentModel();
  if (!m) return;

  if (m.type === "image") {
    systemPromptLabel.textContent = "negative prompt";
    systemPrompt.placeholder = "things to avoid in the image (optional)";
    userInputLabel.textContent = "image prompt";
    userInput.placeholder = "describe the image";
    attachRow.style.display = "none";
    state.pendingAttachments = [];
    renderAttachments();
  } else if (m.type === "tts") {
    systemPromptLabel.textContent = "system prompt";
    systemPrompt.placeholder = "(unused for TTS)";
    userInputLabel.textContent = "text to speak";
    userInput.placeholder = "text to synthesize as speech";
    attachRow.style.display = "none";
    state.pendingAttachments = [];
    renderAttachments();
  } else if (m.type === "video") {
    systemPromptLabel.textContent = "system prompt";
    systemPrompt.placeholder = "(unused for video gen)";
    userInputLabel.textContent = "video prompt";
    userInput.placeholder = "describe the video (8s at 16:9, takes 1-3 min)";
    attachRow.style.display = "none";
    state.pendingAttachments = [];
    renderAttachments();
  } else if (m.type === "stt") {
    systemPromptLabel.textContent = "system prompt";
    systemPrompt.placeholder = "(unused for STT)";
    userInputLabel.textContent = "optional context";
    userInput.placeholder = "optional context for the transcriber (e.g. domain-specific terms)";
    attachRow.style.display = "flex";
    fileInput.accept = "audio/*";
    attachHint.textContent = "attach an audio file to transcribe (required)";
    attachHint.classList.remove("warn");
  } else if (m.type === "music") {
    systemPromptLabel.textContent = "lyrics (optional)";
    systemPrompt.placeholder = "song lyrics, optional. use [Verse] [Chorus] [Bridge] [Outro] tags for structure";
    userInputLabel.textContent = "song description";
    userInput.placeholder = "style/mood/genre, e.g. 'indie folk, melancholic, longing, solitary walk'";
    attachRow.style.display = "none";
    state.pendingAttachments = [];
    renderAttachments();
  } else {
    // chat
    systemPromptLabel.textContent = "system prompt";
    systemPrompt.placeholder = "optional";
    userInputLabel.textContent = "your input";
    userInput.placeholder = "type here, enter to send, shift+enter for newline";
    attachRow.style.display = "flex";
    const vision = (m.capabilities || []).includes("vision");
    if (vision) {
      fileInput.accept = "image/*,audio/*,video/*";
      attachHint.textContent = "image, audio (auto-transcribed), or video (sampled to frames)";
      attachHint.classList.remove("warn");
    } else {
      fileInput.accept = "audio/*";
      attachHint.textContent = "audio only (pick a vision-capable chat model for image/video)";
      attachHint.classList.add("warn");
    }
  }
}

// ---------- File handling ----------

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

async function downscaleImage(dataUrl, maxDim) {
  const img = await loadImage(dataUrl);
  if (img.width <= maxDim && img.height <= maxDim) return dataUrl;
  const scale = maxDim / Math.max(img.width, img.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image decode failed"));
    img.src = src;
  });
}

async function extractVideoFrames(file, n, maxDim) {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = url;

    await new Promise((resolve, reject) => {
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("Video load failed")), { once: true });
    });

    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0) {
      throw new Error("Video duration unavailable (file may be malformed)");
    }

    const w = video.videoWidth, h = video.videoHeight;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");

    const frames = [];
    for (let i = 1; i <= n; i++) {
      const t = (duration * i) / (n + 1);
      video.currentTime = Math.min(t, Math.max(0, duration - 0.05));
      await new Promise((resolve, reject) => {
        const onSeeked = () => { video.removeEventListener("error", onError); resolve(); };
        const onError = () => { video.removeEventListener("seeked", onSeeked); reject(new Error("Video seek failed")); };
        video.addEventListener("seeked", onSeeked, { once: true });
        video.addEventListener("error", onError, { once: true });
      });
      ctx.drawImage(video, 0, 0, cw, ch);
      frames.push(canvas.toDataURL("image/jpeg", 0.85));
    }
    return { frames, duration, width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function handleFiles(files) {
  const m = currentModel();
  if (m.type !== "chat") return;

  for (const file of files) {
    try {
      if (file.type.startsWith("image/")) {
        if (!modelSupports("vision")) throw new Error("Current model doesn't support vision");
        if (file.size > MAX_IMAGE_BYTES) throw new Error(`Image too large (${fmtBytes(file.size)} > ${fmtBytes(MAX_IMAGE_BYTES)})`);
        const raw = await readAsDataUrl(file);
        const data = await downscaleImage(raw, IMAGE_MAX_DIM);
        state.pendingAttachments.push({ type: "image", mime: file.type, filename: file.name, data });
      } else if (file.type.startsWith("audio/")) {
        if (file.size > MAX_AUDIO_BYTES) throw new Error(`Audio too large (${fmtBytes(file.size)} > ${fmtBytes(MAX_AUDIO_BYTES)})`);
        const data = await readAsDataUrl(file);
        state.pendingAttachments.push({ type: "audio", mime: file.type, filename: file.name, data });
      } else if (file.type.startsWith("video/")) {
        if (!modelSupports("vision")) throw new Error("Current model doesn't support vision (required for video frames)");
        if (file.size > MAX_VIDEO_BYTES) throw new Error(`Video too large (${fmtBytes(file.size)} > ${fmtBytes(MAX_VIDEO_BYTES)})`);
        const { frames, duration } = await extractVideoFrames(file, VIDEO_FRAMES, VIDEO_FRAME_MAX_DIM);
        state.pendingAttachments.push({ type: "video_frames", filename: file.name, duration, frames });
      } else {
        throw new Error(`Unsupported file type: ${file.type || "(unknown)"}`);
      }
    } catch (err) {
      alert(`${file.name}: ${err.message}`);
    }
  }
  renderAttachments();
}

function renderAttachments() {
  attachments.innerHTML = state.pendingAttachments
    .map((att, idx) => renderPendingPreview(att, idx))
    .join("");
}

function renderPendingPreview(att, idx) {
  const remove = `<button class="remove" data-remove="${idx}" type="button" title="remove">\u00d7</button>`;
  if (att.type === "image") {
    return `
      <div class="attachment">
        <img class="thumb" src="${escapeHtml(att.data)}" alt="">
        <div>
          <div class="name">${escapeHtml(att.filename || "image")}</div>
          <div class="size">${escapeHtml(att.mime || "image")}</div>
        </div>
        ${remove}
      </div>`;
  }
  if (att.type === "audio") {
    return `
      <div class="attachment">
        <div class="audio-icon">\u266B</div>
        <div>
          <div class="name">${escapeHtml(att.filename || "audio")}</div>
          <div class="size">will transcribe</div>
        </div>
        ${remove}
      </div>`;
  }
  if (att.type === "video_frames") {
    const strip = (att.frames || []).slice(0, 4)
      .map((f) => `<img src="${escapeHtml(f)}" alt="">`)
      .join("");
    const dur = att.duration ? `${att.duration.toFixed(1)}s` : "video";
    return `
      <div class="attachment">
        <div class="video-strip">${strip}</div>
        <div>
          <div class="name">${escapeHtml(att.filename || "video")}</div>
          <div class="size">${(att.frames || []).length} frames \u00b7 ${dur}</div>
        </div>
        ${remove}
      </div>`;
  }
  return "";
}

function renderStoredAttachment(att) {
  if (att.type === "image") {
    return `
      <div class="attachment">
        <img class="thumb" src="${escapeHtml(artifactUrl(att.key))}" alt="">
        <div>
          <div class="name">${escapeHtml(att.filename || "image")}</div>
          <div class="size">${escapeHtml(att.mime || "image")}</div>
        </div>
      </div>`;
  }
  if (att.type === "audio") {
    return `
      <div class="attachment audio-transcript">
        <div class="audio-icon">\u266B</div>
        <div>
          <div class="name">${escapeHtml(att.filename || "audio")}</div>
          <div class="size">transcript stored</div>
        </div>
      </div>`;
  }
  if (att.type === "video_frames") {
    const keys = att.keys || [];
    const strip = keys.slice(0, 4)
      .map((k) => `<img src="${escapeHtml(artifactUrl(k))}" alt="">`)
      .join("");
    const dur = att.duration ? `${att.duration.toFixed(1)}s` : "video";
    return `
      <div class="attachment">
        <div class="video-strip">${strip}</div>
        <div>
          <div class="name">${escapeHtml(att.filename || "video")}</div>
          <div class="size">${keys.length} frames \u00b7 ${dur}</div>
        </div>
      </div>`;
  }
  return "";
}

function renderOutputArtifact(oa) {
  if (!oa) {
    outputArtifactEl.innerHTML = "";
    outputArtifactEl.style.display = "none";
    return;
  }
  outputArtifactEl.style.display = "block";
  const url = artifactUrl(oa.key);
  if (oa.type === "image") {
    outputArtifactEl.innerHTML = `
      <img class="output-image" src="${escapeHtml(url)}" alt="generated image">
      <div class="output-actions"><a href="${escapeHtml(url)}" download>download</a></div>`;
  } else if (oa.type === "audio") {
    outputArtifactEl.innerHTML = `
      <audio class="output-audio" controls src="${escapeHtml(url)}"></audio>
      <div class="output-actions"><a href="${escapeHtml(url)}" download>download</a></div>`;
  } else if (oa.type === "video") {
    outputArtifactEl.innerHTML = `
      <video class="output-video" controls preload="metadata" src="${escapeHtml(url)}"></video>
      <div class="output-actions"><a href="${escapeHtml(url)}" download>download</a></div>`;
  } else {
    outputArtifactEl.innerHTML = "";
  }
}

// ---------- Video job polling ----------
//
// When the worker returns status: "pending" from /api/chat (video models),
// we poll /api/job/:id every 5s until status is "done" or "failed".
// The pendingArea displays elapsed time and progress while polling.

function fmtElapsed(ms) {
  const total = Math.floor(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

function renderPendingOutput(progress) {
  const elapsed = fmtElapsed(Date.now() - state.pollStartedAt);
  const pct = (typeof progress === "number" && progress > 0) ? ` (${progress}%)` : "";
  output.classList.remove("error");
  output.textContent = `Generating, this can take 1-3 minutes\u2026\n\nElapsed: ${elapsed}${pct}`;
}

function stopPolling() {
  if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
  if (state.pollElapsedTimer) { clearInterval(state.pollElapsedTimer); state.pollElapsedTimer = null; }
  state.pollChatId = null;
}

async function pollOnce() {
  if (!state.pollChatId) return;
  const id = state.pollChatId;
  try {
    const result = await api(`/api/job/${id}`);
    // If the user navigated away during the request, drop the result.
    if (state.pollChatId !== id) return;

    if (result.status === "pending") {
      renderPendingOutput(result.progress);
      state.pollTimer = setTimeout(pollOnce, 5000);
      return;
    }

    if (result.status === "done") {
      stopPolling();
      output.textContent = "";
      renderOutputArtifact(result.output_artifact || null);
      outputMeta.textContent = result.latency_ms ? `${result.latency_ms}ms` : "";
      await loadHistory();
      return;
    }

    if (result.status === "failed") {
      stopPolling();
      output.classList.add("error");
      output.textContent = `Video generation failed: ${result.job_error || "unknown error"}`;
      await loadHistory();
      return;
    }
  } catch (err) {
    // Transient network error; keep polling.
    state.pollTimer = setTimeout(pollOnce, 5000);
  }
}

function startPolling(id, startedAtIso) {
  stopPolling();
  state.pollChatId = id;
  state.pollStartedAt = startedAtIso ? Date.parse(startedAtIso) : Date.now();
  renderPendingOutput();
  // Tick the elapsed-time display every second so the user sees progress
  // even between 5s polls.
  state.pollElapsedTimer = setInterval(() => renderPendingOutput(), 1000);
  // First poll immediately, then every 5s on success.
  state.pollTimer = setTimeout(pollOnce, 500);
}

attachments.addEventListener("click", (e) => {
  const rm = e.target.closest("[data-remove]");
  if (rm) {
    const idx = Number(rm.dataset.remove);
    state.pendingAttachments.splice(idx, 1);
    renderAttachments();
  }
});

attachBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async (e) => {
  await handleFiles(Array.from(e.target.files || []));
  fileInput.value = "";
});

modelSelect.addEventListener("change", updateAffordance);

// ---------- History ----------

async function loadHistory() {
  const { chats } = await api("/api/history");
  historyList.innerHTML = chats
    .map((c) => {
      const preview = (c.user_input || "").slice(0, 60).replace(/\s+/g, " ");
      const date = new Date(c.created_at.includes("Z") ? c.created_at : c.created_at + "Z");
      const dateStr = date.toLocaleString(undefined, {
        month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit",
      });
      const icons = [];
      if (c.has_attachments)     icons.push(`<span title="has input attachments">\u{1F4CE}</span>`);
      if (c.status === "pending") icons.push(`<span title="generating, in progress">\u23F3</span>`);
      if (c.status === "failed")  icons.push(`<span title="generation failed" class="status-failed">\u26A0</span>`);
      if (c.has_output_artifact) {
        if (c.model_type === "image") icons.push(`<span title="image output">\u{1F5BC}</span>`);
        else if (c.model_type === "tts") icons.push(`<span title="audio output">\u{1F50A}</span>`);
        else if (c.model_type === "video") icons.push(`<span title="video output">\u{1F3AC}</span>`);
        else if (c.model_type === "music") icons.push(`<span title="music output">\u{1F3B5}</span>`);
        else if (c.model_type === "stt")   icons.push(`<span title="transcript">\u{1F4DD}</span>`);
        else icons.push(`<span title="artifact output">\u{1F4E6}</span>`);
      }
      const iconBlock = icons.length ? `<span class="attach-icon">${icons.join(" ")}</span>` : `<span></span>`;
      return `
        <li data-id="${c.id}">
          <span class="preview" title="${escapeHtml(c.user_input)}">${escapeHtml(preview)}</span>
          ${iconBlock}
          <span class="meta">${dateStr}</span>
          <button class="delete" data-id="${c.id}" type="button" title="delete">\u00d7</button>
        </li>`;
    })
    .join("");
}

async function loadChat(id) {
  stopPolling();
  const chat = await api(`/api/history/${id}`);
  state.currentChatId = id;
  modelSelect.value = chat.model;
  updateAffordance();
  systemPrompt.value = chat.system_prompt || "";
  userInput.value = chat.user_input;
  output.textContent = chat.output || "";
  output.classList.remove("error");
  outputMeta.textContent = fmtMeta(chat);
  state.pendingAttachments = [];
  renderAttachments();
  loadedAttachments.innerHTML = (chat.attachments || [])
    .map((att) => renderStoredAttachment(att))
    .join("");
  renderOutputArtifact(chat.output_artifact);

  // Resume polling if this chat is a still-pending async job (video or music).
  if (chat.status === "pending" && (chat.model_type === "video" || chat.model_type === "music")) {
    startPolling(id, chat.job_started_at);
  } else if (chat.status === "failed") {
    output.classList.add("error");
    output.textContent = `Failed: ${chat.job_error || "unknown error"}`;
  }
}

async function deleteChat(id) {
  await api(`/api/history/${id}`, { method: "DELETE" });
  if (state.currentChatId === id) newChat();
  await loadHistory();
}

function newChat() {
  stopPolling();
  state.currentChatId = null;
  userInput.value = "";
  output.textContent = "";
  output.classList.remove("error");
  outputMeta.textContent = "";
  state.pendingAttachments = [];
  renderAttachments();
  loadedAttachments.innerHTML = "";
  renderOutputArtifact(null);
  userInput.focus();
}

// ---------- Run ----------

async function run() {
  const m = currentModel();
  const model = modelSelect.value;
  const system_prompt = systemPrompt.value;
  const user_input = userInput.value.trim();
  if (!user_input && state.pendingAttachments.length === 0) return;

  stopPolling();
  runBtn.disabled = true;
  attachBtn.disabled = true;
  const runningMsg = m.type === "chat" ? "\u2026"
    : m.type === "video" ? "submitting video job\u2026"
    : m.type === "music" ? "submitting music job\u2026"
    : m.type === "stt" ? "transcribing\u2026"
    : `running ${m.type}\u2026`;
  output.textContent = runningMsg;
  output.classList.remove("error");
  outputMeta.textContent = "";
  renderOutputArtifact(null);

  try {
    const result = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        model,
        system_prompt,
        user_input: user_input || "(no text, attachments only)",
        attachments: (m.type === "chat" || m.type === "stt") ? state.pendingAttachments : [],
      }),
    });
    state.currentChatId = result.id;
    state.pendingAttachments = [];
    renderAttachments();
    await loadHistory();

    if (result.status === "pending") {
      // Async video job; start polling.
      startPolling(result.id, result.job_started_at);
    } else {
      output.textContent = result.output || "";
      outputMeta.textContent = fmtMeta(result);
      renderOutputArtifact(result.output_artifact || null);
    }
  } catch (err) {
    output.classList.add("error");
    output.textContent = err.message;
  } finally {
    runBtn.disabled = false;
    attachBtn.disabled = false;
  }
}

function closeSidebar() {
  layout.classList.remove("sidebar-open");
}

function toggleSidebar() {
  layout.classList.toggle("sidebar-open");
}

sidebarToggle.addEventListener("click", toggleSidebar);
sidebarBackdrop.addEventListener("click", closeSidebar);

historyList.addEventListener("click", (e) => {
  const del = e.target.closest(".delete");
  if (del) {
    e.stopPropagation();
    deleteChat(Number(del.dataset.id));
    return;
  }
  const li = e.target.closest("li[data-id]");
  if (li) {
    loadChat(Number(li.dataset.id));
    closeSidebar();
  }
});

runBtn.addEventListener("click", run);
newChatBtn.addEventListener("click", () => {
  newChat();
  closeSidebar();
});

userInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    run();
  }
});

(async () => {
  try {
    await loadModels();
    await loadHistory();
  } catch (err) {
    output.classList.add("error");
    output.textContent = "Failed to initialize: " + err.message;
  }
})();

// skyphusion-llm-public frontend. Multi-turn conversations:
//   - Each "conversation" is a sequence of turns sharing a conversation_id.
//   - The output area renders a transcript: user turn, assistant turn, etc.
//   - Submitting continues the current conversation; the "+ new" button
//     starts a fresh one.
//
// For non-chat model types (image gen, TTS, video, etc), each row still
// shows in the sidebar as a single-turn conversation - the transcript
// view degrades to one user + one assistant turn, which is fine.
//
// Input artifacts are sent as data URLs and stored server-side in R2. Output
// artifacts (generated images, generated audio) are returned as R2 keys and
// rendered via /api/artifact/{key}.

const $ = (sel) => document.querySelector(sel);

// Collapsible model picker (v0.14.x+). Replaces the v0.1.0 flat <select>
// with a trigger button + popover panel containing <details> accordion
// groups per catalog `group` field. Items show the model label plus
// capability badges (vision, streaming) where relevant.
//
// Built as a shim so the rest of app.js doesn't change: `.value` getter
// and setter, plus addEventListener("change", fn), match the native
// <select> surface. Setting .value programmatically does NOT fire
// `change` (mirrors native behavior); user-driven clicks do.
const modelSelect = (function buildModelPicker() {
  const root = document.getElementById("model");
  if (!root) throw new Error("Model picker root #model not found");

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "model-picker-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.innerHTML =
    '<span class="model-picker-label">choose a model</span>' +
    '<span class="model-picker-chevron" aria-hidden="true">\u25BE</span>';

  const panel = document.createElement("div");
  panel.className = "model-picker-panel";
  panel.setAttribute("role", "listbox");
  panel.hidden = true;

  root.appendChild(trigger);
  root.appendChild(panel);

  const labelEl = trigger.querySelector(".model-picker-label");
  let currentValue = null;
  const changeListeners = [];

  function setOpen(open) {
    panel.hidden = !open;
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function updateTriggerLabel() {
    const m = currentValue ? state.modelsById[currentValue] : null;
    labelEl.textContent = m ? m.label : "choose a model";
  }

  function setValue(id, fireChange) {
    if (currentValue === id) return;
    currentValue = id;
    updateTriggerLabel();
    panel.querySelectorAll(".model-item").forEach((el) => {
      el.classList.toggle("selected", el.dataset.modelId === id);
    });
    if (fireChange) {
      const evt = { target: shim };
      changeListeners.forEach((fn) => fn(evt));
    }
  }

  function escAttr(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function renderBadges(m) {
    const badges = [];
    if ((m.capabilities || []).includes("vision")) {
      badges.push('<span class="model-badge badge-vision" title="accepts images">vision</span>');
    }
    if (m.streaming) {
      badges.push('<span class="model-badge badge-stream" title="supports SSE streaming">stream</span>');
    }
    return badges.length ? '<span class="model-item-badges">' + badges.join("") + '</span>' : '';
  }

  function populate(grouped) {
    const groupNames = Object.keys(grouped);
    panel.innerHTML = groupNames.map((group, idx) => {
      const items = grouped[group];
      const openAttr = idx === 0 ? " open" : "";
      const itemsHtml = items.map((m) =>
        '<li><button type="button" class="model-item" role="option" data-model-id="' +
        escAttr(m.id) + '"><span class="model-item-label">' + escAttr(m.label) +
        '</span>' + renderBadges(m) + '</button></li>'
      ).join("");
      return '<details class="model-group"' + openAttr +
        '><summary class="model-group-header">' + escAttr(group) +
        ' <span class="model-group-count">' + items.length + '</span></summary>' +
        '<ul class="model-group-list">' + itemsHtml + '</ul></details>';
    }).join("");

    // Re-apply highlight if currentValue is still in the catalog; otherwise
    // pick the first model so .value is never null after populate completes.
    if (currentValue && state.modelsById[currentValue]) {
      const sel = panel.querySelector('.model-item[data-model-id="' + CSS.escape(currentValue) + '"]');
      if (sel) sel.classList.add("selected");
    } else if (groupNames.length && grouped[groupNames[0]].length) {
      setValue(grouped[groupNames[0]][0].id, false);
    }
    updateTriggerLabel();
  }

  trigger.addEventListener("click", () => setOpen(panel.hidden));
  panel.addEventListener("click", (e) => {
    const item = e.target.closest(".model-item");
    if (item) {
      setValue(item.dataset.modelId, true);
      setOpen(false);
    }
  });
  document.addEventListener("click", (e) => {
    if (!root.contains(e.target)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) {
      setOpen(false);
      trigger.focus();
    }
  });

  const shim = {
    get value() { return currentValue; },
    set value(v) { setValue(v, false); },
    addEventListener(event, fn) {
      if (event === "change") changeListeners.push(fn);
    },
    populate,
  };
  return shim;
})();

const systemPromptLabel = $("#system-prompt-label");
const systemPrompt      = $("#system-prompt");
const userInputLabel    = $("#user-input-label");
const userInput         = $("#user-input");
const runBtn            = $("#run");
const transcriptEl      = $("#transcript");
const convTitleEl       = $("#conv-title");
const outputMeta        = $("#output-meta");
const historyList       = $("#history-list");
const userBadge         = $("#user-badge");
const newChatBtn        = $("#new-chat");
const fileInput         = $("#file-input");
const attachBtn         = $("#attach-btn");
const attachHint        = $("#attach-hint");
const attachments       = $("#attachments");
const attachRow         = $("#attach-row");
const inputArea         = document.querySelector(".input-area");
const useDocsRow        = $("#use-docs-row");
const useDocsCheckbox   = $("#use-docs");
const useWebSearchRow      = $("#use-web-search-row");
const useWebSearchCheckbox = $("#use-web-search");
const sidebarToggle     = $("#sidebar-toggle");
const sidebarBackdrop   = $("#sidebar-backdrop");
const layout            = document.querySelector(".layout");

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const IMAGE_MAX_DIM   = 1280;
const VIDEO_FRAMES    = 8;
const VIDEO_FRAME_MAX_DIM = 1024;
// FLUX.2 reference image input (v0.16.0): each reference image must be
// <=512x512 per the Cloudflare model spec; the form takes up to 4 of them
// via input_image_0..input_image_3.
const FLUX2_REF_IMAGE_MAX_DIM = 512;
const MAX_FLUX2_REF_IMAGES    = 4;

// Inline SVG icons for per-turn action buttons (v0.12.0+). Kept as raw strings
// rather than fetched assets to avoid an extra request and to inherit the
// surrounding text color via stroke="currentColor". Sized via CSS, not the
// width/height attributes.
const ICON_COPY = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1"/><path d="M11 5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2"/></svg>`;
const ICON_EDIT = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.5 1.5l3 3-8.5 8.5H3v-3z"/><path d="M9.5 3.5l3 3"/></svg>`;
const ICON_RETRY = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><polyline points="13.5 1.5 13.5 4.5 10.5 4.5"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 8 7 12 13 4"/></svg>`;

const state = {
  user: null,
  currentConversationId: null,
  currentTurns: [],
  modelsById: {},
  pendingAttachments: [],
  pollTimer: null,
  pollChatId: null,
  pollStartedAt: 0,
  pollElapsedTimer: null,
  documentCount: 0,
  // v0.20.1: projects state.
  // projects is the list as returned by GET /api/projects (each row has
  // id, name, slug, description, system_prompt, created_at, updated_at,
  // document_count). activeProjectId is the currently-selected project (or
  // null), persisted across reloads in localStorage.
  projects: [],
  activeProjectId: null,
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

  modelSelect.populate(grouped);

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

  // Default: hide the use-docs toggle. The chat branch turns it on when
  // the user has uploaded at least one document.
  // v0.17.0: also default-hide the web-search toggle; chat branch shows it.
  useDocsRow.hidden = true;
  useWebSearchRow.hidden = true;

  if (m.type === "image") {
    systemPromptLabel.textContent = "negative prompt";
    systemPrompt.placeholder = "things to avoid in the image (optional)";
    userInputLabel.textContent = "image prompt";
    userInput.placeholder = "describe the image";

    // FLUX.2 (v0.16.0) accepts up to 4 reference images via input_image_0..3.
    // For the rest of the image models, no attach UI.
    const isFlux2 = m.id.startsWith("@cf/black-forest-labs/flux-2-");
    if (isFlux2) {
      attachRow.style.display = "flex";
      fileInput.accept = "image/*";
      attachHint.textContent = `optional: up to ${MAX_FLUX2_REF_IMAGES} reference images (downscaled to ${FLUX2_REF_IMAGE_MAX_DIM}px)`;
      attachHint.classList.remove("warn");
    } else {
      attachRow.style.display = "none";
      state.pendingAttachments = [];
      renderAttachments();
    }
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
    // RAG: show the toggle only when chat is selected AND the user has
    // uploaded at least one document. Without docs there's nothing to retrieve.
    useDocsRow.hidden = state.documentCount === 0;
    // v0.17.0: web search is always available on chat (no docs dependency).
    useWebSearchRow.hidden = false;
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
  // The attach UI is shown for chat, STT, and FLUX-2 image gen (which accepts
  // reference images). Other model types (TTS, video gen, music gen, non-FLUX-2
  // image gen) hide the attach UI and don't reach this path. Prior to v0.19.5
  // this guard was `m.type !== "chat"`, which silently dropped attachments on
  // STT and FLUX-2 despite the affordance UI being shown.
  const isFlux2 = m.id.startsWith("@cf/black-forest-labs/flux-2-");
  if (m.type !== "chat" && m.type !== "stt" && !isFlux2) return;
  // Pegasus 1.2 (Bedrock) is a chat-type model but needs the FULL video file,
  // not frame extraction. The model id starts with "bedrock/twelvelabs.pegasus".
  const isPegasus = m.id.startsWith("bedrock/twelvelabs.pegasus");

  for (const file of files) {
    try {
      if (file.type.startsWith("image/")) {
        // FLUX.2 image-mode accepts reference images even though its catalog
        // entry doesn't list the "vision" capability (the capability flag is
        // for analyzing input, not for using images as gen references). For
        // FLUX.2 specifically: cap at 4 attachments and downscale harder.
        const m2 = currentModel();
        const isFlux2 = !!m2 && m2.id.startsWith("@cf/black-forest-labs/flux-2-");
        if (isFlux2) {
          const existing = state.pendingAttachments.filter((a) => a.type === "image").length;
          if (existing >= MAX_FLUX2_REF_IMAGES) {
            throw new Error(`FLUX.2 accepts up to ${MAX_FLUX2_REF_IMAGES} reference images; skipping the rest`);
          }
          if (file.size > MAX_IMAGE_BYTES) throw new Error(`Image too large (${fmtBytes(file.size)} > ${fmtBytes(MAX_IMAGE_BYTES)})`);
          const raw = await readAsDataUrl(file);
          const data = await downscaleImage(raw, FLUX2_REF_IMAGE_MAX_DIM);
          state.pendingAttachments.push({ type: "image", mime: file.type, filename: file.name, data });
        } else {
          if (!modelSupports("vision")) throw new Error("Current model doesn't support vision");
          if (file.size > MAX_IMAGE_BYTES) throw new Error(`Image too large (${fmtBytes(file.size)} > ${fmtBytes(MAX_IMAGE_BYTES)})`);
          const raw = await readAsDataUrl(file);
          const data = await downscaleImage(raw, IMAGE_MAX_DIM);
          state.pendingAttachments.push({ type: "image", mime: file.type, filename: file.name, data });
        }
      } else if (file.type.startsWith("audio/")) {
        if (file.size > MAX_AUDIO_BYTES) throw new Error(`Audio too large (${fmtBytes(file.size)} > ${fmtBytes(MAX_AUDIO_BYTES)})`);
        const data = await readAsDataUrl(file);
        state.pendingAttachments.push({ type: "audio", mime: file.type, filename: file.name, data });
      } else if (file.type.startsWith("video/")) {
        if (isPegasus) {
          // Pegasus: upload the full video file. Bedrock InvokeModel has a 25MB
          // request limit (about 18MB binary after base64), so we cap here too.
          const PEGASUS_MAX_VIDEO_BYTES = 18 * 1024 * 1024;
          if (file.size > PEGASUS_MAX_VIDEO_BYTES) {
            throw new Error(`Video too large for Pegasus (${fmtBytes(file.size)} > ${fmtBytes(PEGASUS_MAX_VIDEO_BYTES)}). Bedrock's request limit forces this. For larger videos, S3 integration would be needed.`);
          }
          const data = await readAsDataUrl(file);
          state.pendingAttachments.push({ type: "video_full", mime: file.type, filename: file.name, data });
        } else {
          if (!modelSupports("vision")) throw new Error("Current model doesn't support vision (required for video frames)");
          if (file.size > MAX_VIDEO_BYTES) throw new Error(`Video too large (${fmtBytes(file.size)} > ${fmtBytes(MAX_VIDEO_BYTES)})`);
          const { frames, duration } = await extractVideoFrames(file, VIDEO_FRAMES, VIDEO_FRAME_MAX_DIM);
          state.pendingAttachments.push({ type: "video_frames", filename: file.name, duration, frames });
        }
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
  if (att.type === "video_full") {
    return `
      <div class="attachment">
        <div class="audio-icon">\u{1F3AC}</div>
        <div>
          <div class="name">${escapeHtml(att.filename || "video")}</div>
          <div class="size">full video \u00b7 ${escapeHtml(att.mime || "video")}</div>
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
  if (att.type === "video_full") {
    return `
      <div class="attachment">
        <video class="thumb" src="${escapeHtml(artifactUrl(att.key))}" controls preload="metadata"></video>
        <div>
          <div class="name">${escapeHtml(att.filename || "video")}</div>
          <div class="size">full video \u00b7 ${escapeHtml(att.mime || "video")}</div>
        </div>
      </div>`;
  }
  return "";
}

// Render an output artifact (image / audio / video) as an HTML fragment.
// Used inside an assistant turn block in the transcript.
function renderOutputArtifactHTML(oa) {
  if (!oa) return "";
  const url = artifactUrl(oa.key);
  if (oa.type === "image") {
    return `
      <img class="output-image" src="${escapeHtml(url)}" alt="generated image">
      <div class="output-actions"><a href="${escapeHtml(url)}" download>download</a></div>`;
  } else if (oa.type === "audio") {
    return `
      <audio class="output-audio" controls src="${escapeHtml(url)}"></audio>
      <div class="output-actions"><a href="${escapeHtml(url)}" download>download</a></div>`;
  } else if (oa.type === "video") {
    return `
      <video class="output-video" controls preload="metadata" src="${escapeHtml(url)}"></video>
      <div class="output-actions"><a href="${escapeHtml(url)}" download>download</a></div>`;
  }
  return "";
}

// Render retrieved chunks as an HTML fragment. Embedded inside a user turn
// when RAG and/or web search were used for that turn. Pass null/[] to get "".
// v0.17.0: items can be either RAG chunks (no source_type, or source_type:"rag")
// or web results (source_type:"web"). Renderer branches on source_type.
function renderRetrievedChunksHTML(chunks) {
  if (!chunks || chunks.length === 0) return "";
  const items = chunks
    .map((c, i) => {
      if (c.source_type === "web") {
        const score = (typeof c.score === "number") ? ` \u00b7 score ${c.score.toFixed(3)}` : "";
        const sourceLabel = c.source === "tavily" ? "tavily" : c.source === "wikipedia" ? "wikipedia" : "web";
        return `
        <details class="retrieved-chunk retrieved-web">
          <summary>
            <span class="rc-num">${i + 1}.</span>
            <span class="rc-file">${escapeHtml(c.title || "?")}</span>
            <span class="rc-meta">${escapeHtml(sourceLabel)}${score}</span>
          </summary>
          <pre class="rc-text"><a href="${escapeHtml(c.url || "#")}" target="_blank" rel="noopener noreferrer">${escapeHtml(c.url || "")}</a>

${escapeHtml(c.snippet || "")}</pre>
        </details>`;
      }
      // RAG chunk (the default for missing source_type, for back-compat with
      // rows written before v0.17.0).
      const score = (typeof c.score === "number") ? c.score.toFixed(3) : "?";
      const loc =
        (c.page !== undefined && c.page !== null) ? ` \u00b7 page ${c.page}` :
        c.sheet ? ` \u00b7 sheet "${escapeHtml(c.sheet)}"` :
        "";
      return `
        <details class="retrieved-chunk">
          <summary>
            <span class="rc-num">${i + 1}.</span>
            <span class="rc-file">${escapeHtml(c.filename || "?")}</span>
            <span class="rc-meta">chunk ${c.chunk_index}${loc} \u00b7 score ${score}</span>
          </summary>
          <pre class="rc-text">${escapeHtml(c.text || "")}</pre>
        </details>`;
    })
    .join("");
  // Mixed-source label: when both RAG and web are present, count each.
  const ragCount = chunks.filter((c) => c.source_type !== "web").length;
  const webCount = chunks.filter((c) => c.source_type === "web").length;
  let label;
  if (ragCount && webCount) {
    label = `retrieved context (${ragCount} doc${ragCount === 1 ? "" : "s"} + ${webCount} web)`;
  } else if (webCount) {
    label = `retrieved context (${webCount} web result${webCount === 1 ? "" : "s"})`;
  } else {
    label = `retrieved context (${ragCount} chunk${ragCount === 1 ? "" : "s"})`;
  }
  return `
    <div class="retrieved-chunks">
      <div class="rc-header">${escapeHtml(label)}</div>
      ${items}
    </div>`;
}

function renderStoredAttachmentsHTML(atts) {
  if (!atts || atts.length === 0) return "";
  return `<div class="loaded-attachments">${atts.map(renderStoredAttachment).join("")}</div>`;
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

// While an async job is running, update the last assistant turn in place
// to show elapsed time. The turn's status stays "pending" until the poll
// resolves with done or failed.
function renderPendingOutput(progress) {
  const elapsed = fmtElapsed(Date.now() - state.pollStartedAt);
  const pct = (typeof progress === "number" && progress > 0) ? ` (${progress}%)` : "";
  const last = state.currentTurns[state.currentTurns.length - 1];
  if (last && last.status === "pending") {
    last.output = `Generating, this can take 1-3 minutes\u2026\n\nElapsed: ${elapsed}${pct}`;
    renderTranscript(state.currentTurns);
  }
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
      // Refetch the full conversation for the canonical resolved state.
      if (state.currentConversationId) await loadConversation(state.currentConversationId);
      await loadConversations();
      return;
    }

    if (result.status === "failed") {
      stopPolling();
      // Update the last turn in place to a failed state.
      const last = state.currentTurns[state.currentTurns.length - 1];
      if (last) {
        last.status = "failed";
        last.job_error = result.job_error || "unknown error";
        renderTranscript(state.currentTurns);
      }
      await loadConversations();
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

// ---------- Drag-and-drop + paste (v0.19.5) ----------
//
// Drag files onto the input area or paste an image from the clipboard
// (Cmd/Ctrl-V). Both paths funnel into handleFiles(), which already owns
// validation, size limits, image downscaling, video frame extraction,
// Pegasus full-video routing, and FLUX-2 reference image caps. So
// drag-drop and paste inherit all those behaviors without duplicating
// any of the logic.
//
// dragenter/dragleave fire for every child element under the cursor, not
// just the outer container. We use a counter to keep the visual state
// stable across child-element traversal (textarea, attach button, etc.).

let dragCounter = 0;

// The drop zone is only active when the current model supports attachments
// (attach button is shown). This mirrors the click-to-attach affordance:
// drop targeting for TTS / video gen / music gen would just throw a
// silent no-op, so we don't show the affordance.
function dropZoneActive() {
  return attachRow.style.display !== "none";
}

inputArea.addEventListener("dragenter", (e) => {
  if (!dropZoneActive()) return;
  // Only handle drags that include files. dataTransfer.types includes
  // "Files" when the dragged data is files (vs. text selection from a page).
  if (!e.dataTransfer.types.includes("Files")) return;
  e.preventDefault();
  dragCounter++;
  inputArea.classList.add("drop-active");
});

inputArea.addEventListener("dragover", (e) => {
  if (!dropZoneActive()) return;
  if (!e.dataTransfer.types.includes("Files")) return;
  // preventDefault on dragover is required to tell the browser this
  // element is a valid drop target.
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});

inputArea.addEventListener("dragleave", () => {
  if (!dropZoneActive()) return;
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) inputArea.classList.remove("drop-active");
});

inputArea.addEventListener("drop", async (e) => {
  if (!dropZoneActive()) return;
  e.preventDefault();
  dragCounter = 0;
  inputArea.classList.remove("drop-active");
  const files = Array.from(e.dataTransfer.files || []);
  if (files.length) await handleFiles(files);
});

// Paste handler on the textarea: clipboard images (most common case:
// Cmd/Ctrl-Shift-4 screenshots, "Copy image" from a browser) become
// attachments. Pure-text pastes pass through to the textarea normally.
userInput.addEventListener("paste", async (e) => {
  if (!dropZoneActive()) return;
  const items = Array.from(e.clipboardData?.items || []);
  const files = [];
  for (const item of items) {
    if (item.kind === "file") {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length === 0) return;  // pure text paste; fall through to default behavior
  e.preventDefault();  // suppress default paste so filename text doesn't land in the textarea
  await handleFiles(files);
});

modelSelect.addEventListener("change", updateAffordance);

// ---------- Conversations ----------

async function loadConversations() {
  const { conversations } = await api("/api/conversations");
  historyList.innerHTML = (conversations || [])
    .map((c) => {
      const preview = (c.first_input || "").slice(0, 60).replace(/\s+/g, " ");
      const date = new Date((c.last_created_at || "").includes("Z") ? c.last_created_at : c.last_created_at + "Z");
      const dateStr = date.toLocaleString(undefined, {
        month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit",
      });

      // Icons summarize the conversation: model type, turn count, artifacts.
      const icons = [];
      if (c.first_model_type === "image") icons.push(`<span title="image gen">\u{1F5BC}</span>`);
      else if (c.first_model_type === "tts") icons.push(`<span title="TTS">\u{1F50A}</span>`);
      else if (c.first_model_type === "video") icons.push(`<span title="video gen">\u{1F3AC}</span>`);
      else if (c.first_model_type === "music") icons.push(`<span title="music gen">\u{1F3B5}</span>`);
      else if (c.first_model_type === "stt")   icons.push(`<span title="transcript">\u{1F4DD}</span>`);
      if (c.turn_count > 1) icons.push(`<span class="turn-count" title="${c.turn_count} turns">${c.turn_count}\u00b7</span>`);
      const iconBlock = icons.length ? `<span class="attach-icon">${icons.join(" ")}</span>` : `<span></span>`;

      // v0.20.2: project chip on conversation rows. Shows the project name
      // when the conversation has been assigned (or auto-tagged on creation).
      // Resolves project_id -> name via state.projects so we don't need an
      // extra API call per row. Stale ids (project deleted) render as a
      // muted placeholder rather than blowing up.
      let projChip = "";
      if (c.project_id) {
        const p = state.projects.find((x) => x.id === c.project_id);
        if (p) {
          projChip = `<span class="conv-proj-chip" title="project: ${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>`;
        } else {
          projChip = `<span class="conv-proj-chip conv-proj-chip-stale" title="project (deleted)">project</span>`;
        }
      }

      return `
        <li data-conv-id="${escapeHtml(c.conversation_id)}">
          <span class="preview" title="${escapeHtml(c.first_input || "")}">${escapeHtml(preview)}</span>
          ${projChip}
          ${iconBlock}
          <span class="meta">${dateStr}</span>
          <button class="conv-move" data-conv-move="${escapeHtml(c.conversation_id)}" type="button" title="move to project">\u2197</button>
          <button class="delete" data-conv-delete="${escapeHtml(c.conversation_id)}" type="button" title="delete conversation">\u00d7</button>
        </li>`;
    })
    .join("");
}

async function loadConversation(id) {
  stopPolling();
  const { turns } = await api(`/api/conversations/${encodeURIComponent(id)}`);
  state.currentConversationId = id;
  state.currentTurns = turns || [];

  // Set the model picker to the most-recent turn's model so the user can
  // continue with the same model by default (they can switch before submitting).
  if (state.currentTurns.length) {
    const lastTurn = state.currentTurns[state.currentTurns.length - 1];
    if (state.modelsById[lastTurn.model]) {
      modelSelect.value = lastTurn.model;
      updateAffordance();
    }
    // Populate system_prompt from the first turn (it's typically conversation-wide intent).
    systemPrompt.value = state.currentTurns[0].system_prompt || "";
  }

  renderTranscript(state.currentTurns);
  updateConvTitle();

  // If the latest turn is still pending (async video/music job), resume polling.
  const last = state.currentTurns[state.currentTurns.length - 1];
  if (last && last.status === "pending" && (last.model_type === "video" || last.model_type === "music")) {
    startPolling(last.id, last.job_started_at);
  }
}

async function deleteConversation(id) {
  await api(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (state.currentConversationId === id) newChat();
  await loadConversations();
}

function newChat() {
  stopPolling();
  state.currentConversationId = null;
  state.currentTurns = [];
  userInput.value = "";
  state.pendingAttachments = [];
  renderAttachments();
  renderTranscript([]);
  outputMeta.textContent = "";
  updateConvTitle();
  userInput.focus();
}

function updateConvTitle() {
  if (!state.currentConversationId || state.currentTurns.length === 0) {
    convTitleEl.textContent = "new conversation";
  } else {
    const first = state.currentTurns[0]?.user_input || "";
    const preview = first.slice(0, 60).replace(/\s+/g, " ");
    const n = state.currentTurns.length;
    convTitleEl.textContent = `${preview || "conversation"} \u00b7 ${n} turn${n === 1 ? "" : "s"}`;
  }
}

// ---------- Transcript rendering ----------

function renderTranscript(turns) {
  if (!turns || turns.length === 0) {
    transcriptEl.innerHTML = "";
    transcriptEl.classList.add("empty");
    return;
  }
  transcriptEl.classList.remove("empty");
  transcriptEl.innerHTML = turns.map((t, i) => renderTurnHTML(t, i)).join("");
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function renderTurnHTML(turn, index) {
  // User side: prompt + attachments + retrieved chunks (if RAG was used this turn)
  const userBlock = `
    <div class="turn turn-user" data-turn="${index}">
      <div class="turn-role">you</div>
      <div class="turn-body">
        <div class="turn-text">${escapeHtml(turn.user_input || "")}</div>
        ${renderStoredAttachmentsHTML(turn.attachments)}
        ${renderRetrievedChunksHTML(turn.retrieved_context)}
      </div>
    </div>`;

  // Assistant side: output text (chat/stt) and/or output artifact (image/audio/video/music)
  const isPending = turn.status === "pending";
  const isFailed  = turn.status === "failed";
  let assistantContent = "";
  if (isPending) {
    assistantContent = `<div class="turn-text pending">generating\u2026</div>`;
  } else if (isFailed) {
    assistantContent = `<div class="turn-text error">failed: ${escapeHtml(turn.job_error || "unknown error")}</div>`;
  } else {
    if (turn.output) assistantContent += `<div class="turn-text">${escapeHtml(turn.output)}</div>`;
    if (turn.output_artifact) assistantContent += `<div class="turn-artifact">${renderOutputArtifactHTML(turn.output_artifact)}</div>`;
  }

  // Per-turn action buttons (v0.12.0+):
  //   - Copy: shown when there is output text to copy. Pure-artifact turns
  //     (image/audio/video without a text output) hide it.
  //   - Edit: populates the input textarea with this turn's user_input (and
  //     switches the model picker and system prompt to match) so the user
  //     can tweak before re-running. Does NOT submit.
  //   - Retry: one-click resubmit. Switches model picker, system prompt,
  //     and input to match this turn, then fires run() immediately.
  // Buttons are hidden while a turn is pending.
  let actionsBlock = "";
  if (!isPending) {
    const buttons = [];
    if (turn.output) {
      buttons.push(`<button class="turn-action" data-action="copy" data-turn="${index}" type="button" aria-label="Copy response" title="Copy">${ICON_COPY}</button>`);
    }
    if (turn.user_input) {
      buttons.push(`<button class="turn-action" data-action="edit" data-turn="${index}" type="button" aria-label="Edit this prompt and rerun" title="Edit">${ICON_EDIT}</button>`);
      buttons.push(`<button class="turn-action" data-action="retry" data-turn="${index}" type="button" aria-label="Retry: resubmit this prompt unchanged" title="Retry">${ICON_RETRY}</button>`);
    }
    if (buttons.length) {
      actionsBlock = `<div class="turn-actions">${buttons.join("")}</div>`;
    }
  }

  const assistantBlock = `
    <div class="turn turn-assistant" data-turn="${index}">
      <div class="turn-role">${escapeHtml(turn.model || "?")}</div>
      <div class="turn-body">
        ${assistantContent}
        ${actionsBlock}
        <div class="turn-meta">${escapeHtml(fmtMeta(turn) || "")}</div>
      </div>
    </div>`;

  return userBlock + assistantBlock;
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

  // Optimistic: append a user turn + a placeholder assistant turn to the
  // transcript immediately so the UI feels responsive. After the response
  // comes back we refetch the full conversation to get the canonical state.
  const placeholderText =
    m.type === "chat"  ? "\u2026"
  : m.type === "video" ? "submitting video job\u2026"
  : m.type === "music" ? "submitting music job\u2026"
  : m.type === "stt"   ? "transcribing\u2026"
  : `running ${m.type}\u2026`;

  // Snapshot pending attachments for the optimistic user turn (re-render
  // after success uses persisted server data).
  const optimisticAttachments = (m.type === "chat" || m.type === "stt")
    ? state.pendingAttachments.map((a) => ({
        type: a.type,
        filename: a.filename,
        mime: a.mime,
        transcript: null,
      }))
    : [];
  const optimisticUserTurn = {
    user_input: user_input || "(no text, attachments only)",
    attachments: optimisticAttachments,
    retrieved_context: null,
  };
  const optimisticAssistantTurn = {
    model, model_type: m.type, output: "",
    status: "pending",
    output_artifact: null,
  };
  state.currentTurns.push(optimisticUserTurn, optimisticAssistantTurn);
  renderTranscript(state.currentTurns);
  outputMeta.textContent = "";

  try {
    const requestBody = {
      model,
      system_prompt,
      user_input: user_input || "(no text, attachments only)",
      attachments: (m.type === "chat" || m.type === "stt") ? state.pendingAttachments : [],
      conversation_id: state.currentConversationId || undefined,
    };
    // RAG: only send the flag for chat models when the user has it toggled on
    // AND has documents to retrieve from.
    if (m.type === "chat" && useDocsCheckbox.checked && state.documentCount > 0) {
      requestBody.use_docs = true;
    }
    // v0.17.0: web search. Chat models only; no doc-count gate (Tavily +
    // Wikipedia are always reachable from the worker).
    if (m.type === "chat" && useWebSearchCheckbox.checked) {
      requestBody.use_web_search = true;
    }
    // v0.20.1: project scoping. Chat models only. When a project is active,
    // include its id; the worker applies the project's system_prompt as
    // default (overridden by a per-turn system_prompt) and scopes RAG
    // retrieval to the project's attached documents.
    if (m.type === "chat" && state.activeProjectId) {
      requestBody.project_id = state.activeProjectId;
    }

    const result = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify(requestBody),
    });

    // Pop the optimistic pair we appended above.
    state.currentTurns.pop();
    state.currentTurns.pop();

    // Update conversation id from the response (may have been server-generated).
    state.currentConversationId = result.conversation_id;
    state.pendingAttachments = [];
    renderAttachments();

    // Clear the input so the next prompt can be typed immediately.
    // The system prompt stays.
    userInput.value = "";
    userInput.focus();

    // Refetch the full conversation from the server for canonical state
    // (correct attachment records, retrieved_context, etc).
    await loadConversation(state.currentConversationId);
    await loadConversations();

    // If the assistant turn is pending (async video/music job), start polling.
    const last = state.currentTurns[state.currentTurns.length - 1];
    if (last && last.status === "pending" && (last.model_type === "video" || last.model_type === "music")) {
      startPolling(last.id, last.job_started_at);
    }
  } catch (err) {
    // Roll back optimistic turns; surface the error in a fresh assistant turn.
    state.currentTurns.pop();
    state.currentTurns.pop();
    state.currentTurns.push(optimisticUserTurn, {
      model, model_type: m.type, output: "",
      status: "failed",
      job_error: err.message,
    });
    renderTranscript(state.currentTurns);
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
  const del = e.target.closest("[data-conv-delete]");
  if (del) {
    e.stopPropagation();
    if (confirm("Delete this entire conversation? All turns and artifacts will be removed.")) {
      deleteConversation(del.dataset.convDelete);
    }
    return;
  }
  const move = e.target.closest("[data-conv-move]");
  if (move) {
    e.stopPropagation();
    openMoveToProjectMenu(move, move.dataset.convMove);
    return;
  }
  const li = e.target.closest("li[data-conv-id]");
  if (li) {
    loadConversation(li.dataset.convId);
    closeSidebar();
  }
});

runBtn.addEventListener("click", run);
newChatBtn.addEventListener("click", () => {
  newChat();
  closeSidebar();
});

// Per-turn action buttons (copy / retry). Delegated on transcriptEl because
// the transcript is re-rendered via innerHTML on each turn change, which would
// detach any directly-bound listeners.
transcriptEl.addEventListener("click", handleTurnAction);

async function handleTurnAction(e) {
  const btn = e.target.closest(".turn-action");
  if (!btn) return;
  const action = btn.dataset.action;
  const turnIdx = Number(btn.dataset.turn);
  const turn = state.currentTurns[turnIdx];
  if (!turn) return;

  if (action === "copy") {
    const text = turn.output || "";
    let ok = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        // Fall through to legacy path.
      }
    }
    if (!ok) {
      // Legacy clipboard fallback for non-secure contexts (rare; e.g. plain
      // HTTP local dev). Uses execCommand which is deprecated but still
      // universally supported.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); ok = true; } catch { /* swallow */ }
      document.body.removeChild(ta);
    }
    if (ok) {
      // Brief visual confirmation.
      const orig = btn.innerHTML;
      btn.innerHTML = ICON_CHECK;
      btn.classList.add("turn-action-success");
      btn.disabled = true;
      setTimeout(() => {
        btn.innerHTML = orig;
        btn.classList.remove("turn-action-success");
        btn.disabled = false;
      }, 1200);
    }
    return;
  }

  if (action === "edit") {
    loadTurnIntoComposer(turn);
    userInput.focus();
    // Move cursor to end so a quick edit is natural.
    const end = userInput.value.length;
    userInput.setSelectionRange(end, end);
    userInput.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  if (action === "retry") {
    // One-click resubmit: load this turn's settings into the composer, then
    // fire run() immediately. The new generation appends as a new turn in
    // the conversation. Attachments from the original turn are NOT carried
    // forward (multi-turn continuation is text-only across all paths), so
    // an attached-image retry will re-submit text only.
    loadTurnIntoComposer(turn);
    if (runBtn.disabled) return; // Already in-flight; don't double-fire.
    run();
    return;
  }
}

// Shared by edit and retry. Restores the model picker, system prompt, and
// user input to match the historical turn. Updates the affordance so the
// composer's labels and visible fields (negative_prompt vs system, etc)
// reflect the model type.
function loadTurnIntoComposer(turn) {
  if (turn.model && state.modelsById[turn.model]) {
    modelSelect.value = turn.model;
    updateAffordance();
  }
  if (typeof turn.system_prompt === "string") {
    systemPrompt.value = turn.system_prompt;
  }
  userInput.value = turn.user_input || "";
}

userInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    run();
  }
});

(async () => {
  try {
    await loadModels();
    await loadConversations();
    await loadDocuments();
    updateConvTitle();
  } catch (err) {
    transcriptEl.innerHTML = `<div class="turn turn-assistant"><div class="turn-role">error</div><div class="turn-body"><div class="turn-text error">Failed to initialize: ${escapeHtml(err.message)}</div></div></div>`;
  }
})();

// ---------- Documents (RAG Pass 1) ----------

const documentsList = $("#documents-list");
const docUploadBtn  = $("#doc-upload-btn");
const docFileInput  = $("#doc-file-input");
const docStatus     = $("#doc-status");

function fmtDocSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

async function loadDocuments() {
  try {
    const { documents } = await api("/api/documents");
    state.documentCount = (documents || []).length;
    documentsList.innerHTML = (documents || [])
      .map((d) => {
        const date = new Date(d.created_at.includes("Z") ? d.created_at : d.created_at + "Z");
        const dateStr = date.toLocaleString(undefined, { month: "numeric", day: "numeric" });
        return `
          <li data-id="${d.id}">
            <span class="doc-name" title="${escapeHtml(d.filename)}">${escapeHtml(d.filename)}</span>
            <span class="doc-meta">${d.chunk_count} chunks \u00b7 ${fmtDocSize(d.size_bytes)} \u00b7 ${dateStr}</span>
            <button class="delete" data-doc-delete="${d.id}" type="button" title="delete document">\u00d7</button>
          </li>`;
      })
      .join("");
    // Re-evaluate whether the "use my docs" toggle should be visible.
    updateAffordance();
    // If the user has zero docs, force the checkbox off so a stale check
    // from a previous session doesn't get sent on the next submit.
    if (state.documentCount === 0) useDocsCheckbox.checked = false;
  } catch (err) {
    docStatus.textContent = "Failed to load documents: " + err.message;
    docStatus.classList.add("error");
  }
}

async function uploadDocument(file) {
  if (!file) return;
  const allowedExt = /\.(txt|md|markdown|pdf|xlsx|xls)$/i;
  if (!allowedExt.test(file.name)) {
    docStatus.textContent = "Allowed: .txt, .md, .pdf, .xlsx, .xls";
    docStatus.classList.add("error");
    return;
  }

  docStatus.classList.remove("error");
  docStatus.textContent = `Uploading ${file.name}\u2026`;

  try {
    const dataUrl = await readAsDataUrl(file);
    const result = await api("/api/documents", {
      method: "POST",
      body: JSON.stringify({
        filename: file.name,
        mime: file.type || "text/plain",
        data: dataUrl,
      }),
    });
    docStatus.textContent = `Uploaded ${result.filename}: ${result.chunk_count} chunks embedded`;
    await loadDocuments();
    // Clear status after a few seconds.
    setTimeout(() => { if (docStatus.textContent.startsWith("Uploaded ")) docStatus.textContent = ""; }, 4000);
  } catch (err) {
    docStatus.classList.add("error");
    docStatus.textContent = `Upload failed: ${err.message}`;
  }
}

async function deleteDocument(id) {
  try {
    await api(`/api/documents/${id}`, { method: "DELETE" });
    await loadDocuments();
  } catch (err) {
    docStatus.classList.add("error");
    docStatus.textContent = `Delete failed: ${err.message}`;
  }
}

docUploadBtn.addEventListener("click", () => docFileInput.click());
docFileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (file) await uploadDocument(file);
  docFileInput.value = "";  // allow re-uploading the same filename
});

documentsList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-doc-delete]");
  if (btn) {
    const id = Number(btn.dataset.docDelete);
    if (confirm("Delete this document and all its chunks? This cannot be undone.")) {
      deleteDocument(id);
    }
  }
});

// ---------- Projects (v0.20.1) ----------
//
// Projects group documents (and conversations, in v0.20.2+) under a shared
// system prompt and retrieval scope. Frontend state:
//
//   state.projects        - cached array from GET /api/projects
//   state.activeProjectId - currently-selected project's id, or null
//
// Active project persists across reloads via localStorage. When active:
//   - The project chip appears next to the model picker
//   - Chat requests include project_id in the body (handled in run())
//   - The project row in the sidebar is visually highlighted
//
// Project CRUD goes through a single shared modal (project-modal); the
// modal's title and Delete-button visibility differentiate create vs edit.
// Document attachment uses a separate picker modal that shows all the user's
// docs with checkboxes for project membership.

const projectsList         = $("#projects-list");
const projNewBtn           = $("#proj-new-btn");
const projStatus           = $("#proj-status");
const activeProjectChip    = $("#active-project-chip");
const activeProjectName    = $("#active-project-name");
const activeProjectClear   = $("#active-project-clear");

const projectModal         = $("#project-modal");
const projectModalTitle    = $("#project-modal-title");
const projectModalName     = $("#project-modal-name");
const projectModalDesc     = $("#project-modal-desc");
const projectModalPrompt   = $("#project-modal-prompt");
const projectModalError    = $("#project-modal-error");
const projectModalSave     = $("#project-modal-save");
const projectModalCancel   = $("#project-modal-cancel");
const projectModalDelete   = $("#project-modal-delete");

const projectDocsModal     = $("#project-docs-modal");
const projectDocsModalList = $("#project-docs-modal-list");
const projectDocsModalEmpty= $("#project-docs-modal-empty");
const projectDocsModalClose= $("#project-docs-modal-close");

const ACTIVE_PROJECT_LS_KEY = "skyphusion.activeProjectId";

// Editing state for the project modal. null = create mode; a project row =
// edit mode (Delete button visible, fields prefilled).
let editingProjectId = null;
// Document picker context: which project is being managed.
let docsPickerProjectId = null;

// ---------- API helpers ----------

async function fetchProjects() {
  const { projects } = await api("/api/projects");
  state.projects = projects || [];
  return state.projects;
}

async function fetchProject(id) {
  return await api(`/api/projects/${id}`);
}

async function createProject(body) {
  return await api("/api/projects", { method: "POST", body: JSON.stringify(body) });
}

async function patchProject(id, body) {
  return await api(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

async function deleteProjectApi(id) {
  return await api(`/api/projects/${id}`, { method: "DELETE" });
}

async function attachDocumentToProject(projectId, docId) {
  return await api(`/api/projects/${projectId}/documents/${docId}`, { method: "POST" });
}

async function detachDocumentFromProject(projectId, docId) {
  return await api(`/api/projects/${projectId}/documents/${docId}`, { method: "DELETE" });
}

// ---------- Active-project persistence ----------

function loadActiveProjectFromStorage() {
  try {
    const raw = localStorage.getItem(ACTIVE_PROJECT_LS_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function saveActiveProjectToStorage(id) {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_PROJECT_LS_KEY);
    else localStorage.setItem(ACTIVE_PROJECT_LS_KEY, String(id));
  } catch {
    /* private mode etc; non-fatal */
  }
}

function setActiveProject(id) {
  // Validate: id must point to a project we know about. Stale ids (project
  // deleted in another tab) silently clear.
  if (id !== null && !state.projects.some((p) => p.id === id)) {
    id = null;
  }
  state.activeProjectId = id;
  saveActiveProjectToStorage(id);
  renderActiveProjectChip();
  renderProjectsList();
}

// ---------- Renderers ----------

function renderActiveProjectChip() {
  if (!state.activeProjectId) {
    activeProjectChip.hidden = true;
    return;
  }
  const p = state.projects.find((x) => x.id === state.activeProjectId);
  if (!p) {
    // Stale id; treat as inactive.
    state.activeProjectId = null;
    saveActiveProjectToStorage(null);
    activeProjectChip.hidden = true;
    return;
  }
  activeProjectName.textContent = p.name;
  activeProjectChip.hidden = false;
}

function renderProjectsList() {
  if (state.projects.length === 0) {
    projectsList.innerHTML = `<li class="proj-empty">no projects yet. click "+ new" to create one.</li>`;
    return;
  }
  projectsList.innerHTML = state.projects.map((p) => {
    const active = p.id === state.activeProjectId ? " active" : "";
    const docCount = p.document_count != null ? p.document_count : 0;
    const docLabel = docCount === 1 ? "1 doc" : `${docCount} docs`;
    return `
      <li class="${active.trim()}" data-proj-id="${p.id}" title="${escapeHtml(p.description || p.name)}">
        <span class="proj-name">${escapeHtml(p.name)}</span>
        <span class="proj-meta">${docLabel}</span>
        <span class="proj-actions">
          <button class="proj-action" data-proj-action="docs" data-proj-id="${p.id}" type="button" title="manage documents">docs</button>
          <button class="proj-action" data-proj-action="edit" data-proj-id="${p.id}" type="button" title="edit project">edit</button>
        </span>
      </li>`;
  }).join("");
}

// ---------- Modal helpers ----------

function openProjectModal(project) {
  // project: null = create mode; a project row = edit mode.
  editingProjectId = project ? project.id : null;
  projectModalTitle.textContent = project ? `edit project: ${project.name}` : "new project";
  projectModalName.value   = project ? project.name : "";
  projectModalDesc.value   = project ? (project.description || "") : "";
  projectModalPrompt.value = project ? (project.system_prompt || "") : "";
  projectModalDelete.hidden = !project;
  projectModalError.hidden = true;
  projectModalError.textContent = "";
  projectModal.hidden = false;
  projectModalName.focus();
}

function closeProjectModal() {
  projectModal.hidden = true;
  editingProjectId = null;
}

function showProjectModalError(msg) {
  projectModalError.textContent = msg;
  projectModalError.hidden = false;
}

async function saveProjectModal() {
  const name = projectModalName.value.trim();
  if (!name) {
    showProjectModalError("name is required");
    return;
  }
  if (name.length > 200) {
    showProjectModalError("name too long (max 200 chars)");
    return;
  }
  const description = projectModalDesc.value.trim();
  const system_prompt = projectModalPrompt.value.trim();

  projectModalSave.disabled = true;
  try {
    if (editingProjectId) {
      await patchProject(editingProjectId, { name, description, system_prompt });
    } else {
      const result = await createProject({ name, description, system_prompt });
      // Auto-activate the newly-created project so the user sees the chip and
      // can start using it immediately.
      if (result.project) setActiveProject(result.project.id);
    }
    await fetchProjects();
    renderProjectsList();
    renderActiveProjectChip();
    closeProjectModal();
  } catch (err) {
    showProjectModalError(err.message || "save failed");
  } finally {
    projectModalSave.disabled = false;
  }
}

async function deleteProjectFromModal() {
  if (!editingProjectId) return;
  const p = state.projects.find((x) => x.id === editingProjectId);
  if (!p) return;
  if (!confirm(`Delete project "${p.name}"? Its documents will stay; only the project and its memberships are removed.`)) {
    return;
  }
  projectModalDelete.disabled = true;
  try {
    await deleteProjectApi(editingProjectId);
    if (state.activeProjectId === editingProjectId) {
      setActiveProject(null);
    }
    await fetchProjects();
    renderProjectsList();
    renderActiveProjectChip();
    closeProjectModal();
  } catch (err) {
    showProjectModalError(err.message || "delete failed");
  } finally {
    projectModalDelete.disabled = false;
  }
}

// ---------- Document picker modal ----------

async function openDocsPicker(projectId) {
  docsPickerProjectId = projectId;
  // Load the project's currently-attached docs alongside the full user doc list.
  const [{ documents: allDocs }, { documents: projDocs }] = await Promise.all([
    api("/api/documents"),
    api(`/api/documents?project_id=${projectId}`),
  ]);
  const attachedIds = new Set((projDocs || []).map((d) => d.id));

  if (!allDocs || allDocs.length === 0) {
    projectDocsModalList.innerHTML = "";
    projectDocsModalEmpty.hidden = false;
  } else {
    projectDocsModalEmpty.hidden = true;
    projectDocsModalList.innerHTML = allDocs.map((d) => {
      const checked = attachedIds.has(d.id) ? "checked" : "";
      return `
        <li data-doc-id="${d.id}">
          <input type="checkbox" data-doc-toggle="${d.id}" ${checked} />
          <span class="pd-name">${escapeHtml(d.filename)}</span>
          <span class="pd-meta">${d.chunk_count} chunks</span>
        </li>`;
    }).join("");
  }
  projectDocsModal.hidden = false;
}

function closeDocsPicker() {
  projectDocsModal.hidden = true;
  docsPickerProjectId = null;
}

async function handleDocsPickerToggle(docId, checked) {
  if (!docsPickerProjectId) return;
  try {
    if (checked) {
      await attachDocumentToProject(docsPickerProjectId, docId);
    } else {
      await detachDocumentFromProject(docsPickerProjectId, docId);
    }
    // Refresh the project list so the doc count updates without closing the modal.
    await fetchProjects();
    renderProjectsList();
  } catch (err) {
    // Surface the error and revert the checkbox to its previous state.
    alert(`Failed to ${checked ? "attach" : "detach"} document: ${err.message}`);
    const cb = projectDocsModalList.querySelector(`[data-doc-toggle="${docId}"]`);
    if (cb) cb.checked = !checked;
  }
}

// ---------- Event wiring ----------

projNewBtn.addEventListener("click", () => openProjectModal(null));

projectsList.addEventListener("click", (e) => {
  const actionBtn = e.target.closest("[data-proj-action]");
  if (actionBtn) {
    e.stopPropagation();
    const id = Number(actionBtn.dataset.projId);
    const action = actionBtn.dataset.projAction;
    if (action === "edit") {
      const p = state.projects.find((x) => x.id === id);
      if (p) openProjectModal(p);
    } else if (action === "docs") {
      openDocsPicker(id);
    }
    return;
  }
  const li = e.target.closest("li[data-proj-id]");
  if (li) {
    const id = Number(li.dataset.projId);
    // Toggle: clicking the active project deactivates it; otherwise activate.
    setActiveProject(state.activeProjectId === id ? null : id);
  }
});

activeProjectClear.addEventListener("click", () => setActiveProject(null));

projectModalSave.addEventListener("click", saveProjectModal);
projectModalCancel.addEventListener("click", closeProjectModal);
projectModalDelete.addEventListener("click", deleteProjectFromModal);

projectDocsModalClose.addEventListener("click", closeDocsPicker);

projectDocsModalList.addEventListener("change", (e) => {
  const cb = e.target.closest("[data-doc-toggle]");
  if (cb) handleDocsPickerToggle(Number(cb.dataset.docToggle), cb.checked);
});

// Click-outside-modal close (handled via modal-backdrop element).
document.addEventListener("click", (e) => {
  const closer = e.target.closest("[data-modal-close]");
  if (!closer) return;
  const modalId = closer.dataset.modalClose;
  if (modalId === "project-modal") closeProjectModal();
  else if (modalId === "project-docs-modal") closeDocsPicker();
});

// Escape key closes any open modal.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!projectModal.hidden) closeProjectModal();
  else if (!projectDocsModal.hidden) closeDocsPicker();
});

// Submit project modal on Cmd/Ctrl+Enter inside any of its text inputs.
[projectModalName, projectModalDesc, projectModalPrompt].forEach((el) => {
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      saveProjectModal();
    }
  });
});

// Initial load: fetch projects, restore active selection from localStorage.
// Wrapped in an IIFE so it doesn't block the existing init flow if it errors.
(async () => {
  try {
    await fetchProjects();
    const savedId = loadActiveProjectFromStorage();
    if (savedId && state.projects.some((p) => p.id === savedId)) {
      state.activeProjectId = savedId;
    } else if (savedId) {
      // Saved id doesn't match any current project; clear stale storage.
      saveActiveProjectToStorage(null);
    }
    renderProjectsList();
    renderActiveProjectChip();
  } catch (err) {
    projStatus.textContent = `Failed to load projects: ${err.message}`;
    projStatus.classList.add("error");
  }
})();

// ---------- Move conversation to project (v0.20.2) ----------
//
// Per-conversation dropdown menu. Hover/click reveals the arrow button on a
// conversation row; clicking opens a small dropdown listing all projects +
// "(no project)" + the current project highlighted. Picking an option
// PATCHes /api/conversations/:id/project and refreshes the conversation list.
//
// The dropdown is appended to <body> with absolute positioning so it isn't
// clipped by the sidebar's overflow. Closes on outside click or Escape.

let moveMenuEl = null;

function closeMoveToProjectMenu() {
  if (moveMenuEl) {
    moveMenuEl.remove();
    moveMenuEl = null;
  }
}

async function moveConversationToProject(convId, projectId) {
  try {
    await api(`/api/conversations/${encodeURIComponent(convId)}/project`, {
      method: "PATCH",
      body: JSON.stringify({ project_id: projectId }),
    });
    await loadConversations();
  } catch (err) {
    alert(`Failed to move conversation: ${err.message}`);
  }
}

function openMoveToProjectMenu(anchorEl, convId) {
  closeMoveToProjectMenu();

  // Resolve the conversation's current project id from the existing list
  // markup so we can highlight the current selection. The cheapest read is
  // the chip element rendered on the row; otherwise null (no current).
  const li = anchorEl.closest("li[data-conv-id]");
  const chip = li?.querySelector(".conv-proj-chip");
  const currentProjectName = chip && !chip.classList.contains("conv-proj-chip-stale")
    ? chip.textContent.trim()
    : null;

  moveMenuEl = document.createElement("div");
  moveMenuEl.className = "move-menu";
  moveMenuEl.setAttribute("role", "menu");

  const rect = anchorEl.getBoundingClientRect();
  // Position below the button by default; flip up if there's not enough room.
  const spaceBelow = window.innerHeight - rect.bottom;
  const isFlipped = spaceBelow < 240 && rect.top > 240;
  moveMenuEl.style.position = "fixed";
  moveMenuEl.style.left = `${Math.min(rect.left, window.innerWidth - 220)}px`;
  if (isFlipped) {
    moveMenuEl.style.bottom = `${window.innerHeight - rect.top + 4}px`;
  } else {
    moveMenuEl.style.top = `${rect.bottom + 4}px`;
  }

  const items = [
    { value: null, label: "(no project)", isCurrent: !currentProjectName },
    ...state.projects.map((p) => ({
      value: p.id,
      label: p.name,
      isCurrent: p.name === currentProjectName,
    })),
  ];

  moveMenuEl.innerHTML = items.map((it) => {
    const cls = "move-menu-item" + (it.isCurrent ? " current" : "");
    const id = it.value === null ? "" : String(it.value);
    return `<button type="button" class="${cls}" data-move-target="${id}">${escapeHtml(it.label)}</button>`;
  }).join("");

  moveMenuEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-move-target]");
    if (!btn) return;
    const raw = btn.dataset.moveTarget;
    const target = raw === "" ? null : Number(raw);
    closeMoveToProjectMenu();
    await moveConversationToProject(convId, target);
  });

  document.body.appendChild(moveMenuEl);

  // Defer the outside-click listener registration to the next tick so the
  // click that opened the menu doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener("click", onMoveMenuOutsideClick, { once: true });
    document.addEventListener("keydown", onMoveMenuKeydown, { once: true });
  }, 0);
}

function onMoveMenuOutsideClick(e) {
  if (moveMenuEl && !moveMenuEl.contains(e.target)) {
    closeMoveToProjectMenu();
  } else if (moveMenuEl) {
    // Inside-menu click; the menu's own handler runs first and closes it,
    // but we may also re-register the listener for nested clicks.
    document.addEventListener("click", onMoveMenuOutsideClick, { once: true });
  }
}

function onMoveMenuKeydown(e) {
  if (e.key === "Escape") closeMoveToProjectMenu();
}

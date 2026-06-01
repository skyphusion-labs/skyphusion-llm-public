// /cast page (v0.46.0). Persisted cast manager: list, create, edit name +
// bible, upload portrait, manage training-ref set, delete. All routes
// scoped per Cloudflare Access user_email server-side; this file owns no
// auth state.
//
// Vanilla JS, no framework, no bundler, matching the existing planner.js
// and app.js idiom. DOM-glue only; the pure helpers (encodeRefKey, etc.)
// are exported via window for vitest.

(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  const state = {
    cast: [],
    selectedId: null,
    dirty: false,
  };

  // The ref key path-segment can contain "/" (cast/<id>/refs/<uuid>.<ext>);
  // encodeURIComponent passes through "/", which the delete route's regex
  // catches via /^\/api\/cast\/(\d+)\/refs\/(.+)$/ on the server. We still
  // double-encode reserved chars defensively.
  function encodeRefKey(key) {
    return encodeURIComponent(key);
  }

  function artifactUrl(key) {
    if (!key) return "";
    return "/api/artifact/" + key;
  }

  function setListStatus(text, isError) {
    const el = $("#cast-list-status");
    el.textContent = text || "";
    el.classList.toggle("is-error", !!isError);
  }

  function setEditorVisible(visible) {
    $("#cast-editor").hidden = !visible;
    $("#cast-editor-empty").hidden = !!visible;
  }

  function markDirty(dirty) {
    state.dirty = !!dirty;
    $("#cast-save-btn").disabled = !dirty;
  }

  async function api(path, init) {
    const resp = await fetch(path, init);
    let data = null;
    try { data = await resp.json(); } catch { /* non-JSON */ }
    if (!resp.ok) {
      const msg = (data && data.error) || `HTTP ${resp.status}`;
      throw new Error(msg);
    }
    return data;
  }

  async function loadCastList() {
    setListStatus("loading...");
    try {
      const data = await api("/api/cast");
      state.cast = Array.isArray(data.cast) ? data.cast : [];
      renderCastList();
      setListStatus(
        state.cast.length === 0
          ? "no characters yet. click + new character to start."
          : ""
      );
    } catch (e) {
      setListStatus("could not load cast: " + e.message, true);
    }
  }

  function renderCastList() {
    const ul = $("#cast-list");
    ul.innerHTML = "";
    for (const c of state.cast) {
      const li = document.createElement("li");
      li.className = "cast-list-item";
      if (c.id === state.selectedId) li.classList.add("is-selected");
      li.dataset.castId = String(c.id);

      const thumb = document.createElement("div");
      thumb.className = "cast-list-thumb";
      if (c.portrait_key) {
        const img = document.createElement("img");
        img.src = artifactUrl(c.portrait_key);
        img.alt = c.name;
        img.loading = "lazy";
        thumb.appendChild(img);
      } else {
        thumb.textContent = c.name.slice(0, 2).toUpperCase();
        thumb.classList.add("is-placeholder");
      }
      li.appendChild(thumb);

      const meta = document.createElement("div");
      meta.className = "cast-list-meta";
      const name = document.createElement("div");
      name.className = "cast-list-name";
      name.textContent = c.name;
      meta.appendChild(name);
      const sub = document.createElement("div");
      sub.className = "cast-list-sub";
      const parts = [];
      if (c.ref_keys.length > 0) parts.push(c.ref_keys.length + " refs");
      if (!c.portrait_key) parts.push("no portrait");
      sub.textContent = parts.join(" · ") || "ready";
      meta.appendChild(sub);
      li.appendChild(meta);

      li.addEventListener("click", () => selectCast(c.id));
      ul.appendChild(li);
    }
  }

  function findCast(id) {
    return state.cast.find((c) => c.id === id) || null;
  }

  function populateEditor(c) {
    $("#cast-name").value = c.name;
    $("#cast-bible").value = c.bible || "";
    $("#cast-slug").textContent = "/" + c.slug;

    const img = $("#cast-portrait-img");
    const empty = $("#cast-portrait-empty");
    if (c.portrait_key) {
      img.src = artifactUrl(c.portrait_key);
      img.alt = c.name;
      img.hidden = false;
      empty.hidden = true;
      $("#cast-portrait-clear").disabled = false;
    } else {
      img.src = "";
      img.hidden = true;
      empty.hidden = false;
      $("#cast-portrait-clear").disabled = true;
    }

    const refs = $("#cast-refs-list");
    refs.innerHTML = "";
    for (const r of c.ref_keys) {
      const li = document.createElement("li");
      li.className = "cast-ref-item";
      const a = document.createElement("a");
      a.href = artifactUrl(r.key);
      a.target = "_blank";
      a.rel = "noopener";
      const img2 = document.createElement("img");
      img2.src = artifactUrl(r.key);
      img2.alt = "ref";
      img2.loading = "lazy";
      a.appendChild(img2);
      li.appendChild(a);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "cast-ref-delete";
      del.textContent = "remove";
      del.dataset.refKey = r.key;
      del.addEventListener("click", () => removeRef(r.key));
      li.appendChild(del);
      refs.appendChild(li);
    }

    markDirty(false);

    // v0.47.0: keep generation UI in sync with the freshly-populated row.
    // Clears any stale preview / progress from the previously-selected
    // character; the training-set button is gated on portrait_key.
    if (typeof updateTrainingGate === "function") {
      updateTrainingGate(c);
      hidePortraitGenPreview();
      setPortraitGenStatus("");
      setTrainingStatus("");
      const prog = document.getElementById("cast-training-progress");
      if (prog) prog.innerHTML = "";
    }

    // v0.57.0: render the LoRA training pane state.
    renderLoraPane(c);
    if (c.lora_status === "training") {
      schedulePollLoraStatus(c.id);
    }
  }

  function selectCast(id) {
    if (state.dirty) {
      if (!window.confirm("you have unsaved changes. discard?")) return;
    }
    state.selectedId = id;
    const c = findCast(id);
    if (!c) {
      setEditorVisible(false);
      renderCastList();
      return;
    }
    setEditorVisible(true);
    populateEditor(c);
    renderCastList();
  }

  async function newCast() {
    const name = window.prompt("character name?");
    if (!name || !name.trim()) return;
    try {
      const data = await api("/api/cast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      state.cast.unshift(data.cast);
      selectCast(data.cast.id);
    } catch (e) {
      window.alert("create failed: " + e.message);
    }
  }

  async function saveCast() {
    const id = state.selectedId;
    if (!id) return;
    const name = $("#cast-name").value.trim();
    const bible = $("#cast-bible").value;
    if (!name) {
      window.alert("name cannot be empty");
      return;
    }
    try {
      const data = await api("/api/cast/" + id, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, bible }),
      });
      const idx = state.cast.findIndex((c) => c.id === id);
      if (idx >= 0) state.cast[idx] = data.cast;
      markDirty(false);
      renderCastList();
      $("#cast-slug").textContent = "/" + data.cast.slug;
    } catch (e) {
      window.alert("save failed: " + e.message);
    }
  }

  async function deleteSelected() {
    const id = state.selectedId;
    if (!id) return;
    const c = findCast(id);
    if (!c) return;
    if (!window.confirm("delete " + c.name + "? this removes the portrait and all reference images.")) return;
    try {
      await api("/api/cast/" + id, { method: "DELETE" });
      state.cast = state.cast.filter((x) => x.id !== id);
      state.selectedId = null;
      setEditorVisible(false);
      renderCastList();
    } catch (e) {
      window.alert("delete failed: " + e.message);
    }
  }

  async function uploadPortraitFile(file) {
    const id = state.selectedId;
    if (!id || !file) return;
    try {
      const data = await api("/api/cast/" + id + "/portrait", {
        method: "POST",
        headers: { "content-type": file.type || "image/png" },
        body: file,
      });
      const idx = state.cast.findIndex((c) => c.id === id);
      if (idx >= 0) state.cast[idx] = data.cast;
      populateEditor(data.cast);
      renderCastList();
    } catch (e) {
      window.alert("portrait upload failed: " + e.message);
    }
  }

  async function clearPortrait() {
    const id = state.selectedId;
    if (!id) return;
    if (!window.confirm("clear the portrait?")) return;
    try {
      const data = await api("/api/cast/" + id + "/portrait", { method: "DELETE" });
      const idx = state.cast.findIndex((c) => c.id === id);
      if (idx >= 0) state.cast[idx] = data.cast;
      populateEditor(data.cast);
      renderCastList();
    } catch (e) {
      window.alert("clear failed: " + e.message);
    }
  }

  async function uploadRefFile(file) {
    const id = state.selectedId;
    if (!id || !file) return;
    try {
      const data = await api("/api/cast/" + id + "/refs", {
        method: "POST",
        headers: { "content-type": file.type || "image/png" },
        body: file,
      });
      const idx = state.cast.findIndex((c) => c.id === id);
      if (idx >= 0) state.cast[idx] = data.cast;
      populateEditor(data.cast);
      renderCastList();
    } catch (e) {
      window.alert("ref upload failed: " + e.message);
    }
  }

  async function removeRef(key) {
    const id = state.selectedId;
    if (!id) return;
    if (!window.confirm("remove this reference image?")) return;
    try {
      const data = await api("/api/cast/" + id + "/refs/" + encodeRefKey(key), {
        method: "DELETE",
      });
      const idx = state.cast.findIndex((c) => c.id === id);
      if (idx >= 0) state.cast[idx] = data.cast;
      populateEditor(data.cast);
      renderCastList();
    } catch (e) {
      window.alert("remove failed: " + e.message);
    }
  }

  // ---------- v0.47.0: portrait + training-set generation via /api/chat ----------

  // FLUX 2 Dev is the only @cf multi-reference model in our catalog; the
  // training-set generator hardcodes it because the reference-conditioning
  // path is what keeps the 10 outputs consistent with the saved portrait.
  // The portrait generator accepts any image-gen model.
  const TRAINING_MODEL_ID = "@cf/black-forest-labs/flux-2-dev";
  const FLUX2_REF_MAX_DIM = 512;

  // 10 training templates spanning orthogonal axes: framing (close-up,
  // medium, three-quarter, full-body, profile), camera angle (eye-level,
  // low, high, slight tilt), lighting (studio neutral, golden hour, side
  // window, dramatic side, harsh midday, warm interior), expression
  // (neutral, slight smile, serious, contemplative), pose (standing,
  // sitting, mid-action), and background (clean grey, blurred outdoor,
  // neutral indoor, plain wall, soft bokeh).
  //
  // v0.64.0: the pre-v0.64 set was 8/10 "portrait, ... clean background"
  // with tiny expression/lighting tweaks, producing near-duplicate
  // training images. The LoRA overfit on the clean-background-portrait
  // distribution rather than identity, so the GPU-side LoRA quality gate
  // ssim scored ~0 on the smoke-test cast. Diversifying the prompts
  // forces the LoRA to learn the subject's identity independent of any
  // single framing or lighting choice.
  const TRAINING_PROMPTS = [
    "close-up portrait, neutral expression, eye level, soft studio lighting, clean grey background",
    "medium shot, three-quarter angle, looking forward, golden-hour outdoor lighting, blurred natural background",
    "full-body shot, standing pose, hands at sides, even daylight, plain neutral indoor space",
    "profile shot looking left, shoulders-up framing, soft window light from the side, plain wall background",
    "three-quarter shot from slightly above, looking down, warm interior lighting, soft bokeh background",
    "medium close-up, slight smile, looking off to the right, overcast natural daylight, outdoor blurred treeline",
    "close-up portrait, serious expression, looking at camera, dramatic side lighting from the right, dark backdrop",
    "medium shot, dynamic mid-action pose, looking forward, harsh midday sunlight, plain background",
    "three-quarter shot, sitting on a stool, looking thoughtfully to the side, warm indoor lamp lighting, plain dark background",
    "close-up portrait, slight head tilt, looking up at the camera, soft natural window light, plain background",
  ];

  // Build the prompt sent to /api/chat: pose template, then a separator,
  // then the bible (capped so the upstream prompt limit holds). Pure for
  // vitest.
  function composeTrainingPrompt(template, bible) {
    const safeBible = String(bible || "").trim();
    if (!safeBible) return template;
    // Cap bible at ~600 chars so the joined prompt stays comfortably
    // under the typical 1500-char gateway limit even with overhead.
    const trimmed = safeBible.length > 600 ? safeBible.slice(0, 600) : safeBible;
    return template + ". " + trimmed;
  }

  // Downscale an image to fit within FLUX2_REF_MAX_DIM on the long edge,
  // preserving aspect. Returns a data URL (image/png). FLUX 2's schema
  // caps inputs at 512x512; sending bigger gets rejected upstream.
  async function downscaleToDataUrl(blob, maxDim) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = (e) => reject(new Error("image decode failed"));
        el.src = url;
      });
      const longest = Math.max(img.naturalWidth, img.naturalHeight);
      const scale = longest > maxDim ? maxDim / longest : 1;
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      return canvas.toDataURL("image/png");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function fetchPortraitAsDataUrl(portraitKey) {
    const resp = await fetch(artifactUrl(portraitKey));
    if (!resp.ok) throw new Error("could not fetch portrait: HTTP " + resp.status);
    const blob = await resp.blob();
    return downscaleToDataUrl(blob, FLUX2_REF_MAX_DIM);
  }

  let imageModelsCache = null;

  async function loadImageModels() {
    if (imageModelsCache) return imageModelsCache;
    const data = await api("/api/models");
    imageModelsCache = (data.models || []).filter((m) => m.type === "image");
    return imageModelsCache;
  }

  async function ensurePortraitGenModelOptions() {
    const sel = $("#cast-portrait-gen-model");
    if (sel.options.length > 0) return;
    try {
      const models = await loadImageModels();
      for (const m of models) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.label || m.id;
        sel.appendChild(opt);
      }
    } catch (e) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(could not load models: " + e.message + ")";
      sel.appendChild(opt);
    }
  }

  // Portrait gen state (one in-flight at a time per character).
  const portraitGen = {
    pendingKey: null,
    busy: false,
  };

  function setPortraitGenStatus(text, isError) {
    const el = $("#cast-portrait-gen-status");
    el.textContent = text || "";
    el.classList.toggle("is-error", !!isError);
  }

  function showPortraitGenPreview(key) {
    portraitGen.pendingKey = key;
    const img = $("#cast-portrait-gen-img");
    img.src = artifactUrl(key);
    $("#cast-portrait-gen-preview").hidden = false;
  }

  function hidePortraitGenPreview() {
    portraitGen.pendingKey = null;
    $("#cast-portrait-gen-img").src = "";
    $("#cast-portrait-gen-preview").hidden = true;
  }

  async function generatePortrait() {
    const id = state.selectedId;
    if (!id) return;
    if (portraitGen.busy) return;
    const c = findCast(id);
    if (!c) return;
    const modelId = $("#cast-portrait-gen-model").value;
    if (!modelId) {
      setPortraitGenStatus("pick an image-gen model first", true);
      return;
    }
    const promptInput = $("#cast-portrait-gen-prompt").value.trim();
    const prompt = promptInput || c.bible || c.name;
    if (!prompt) {
      setPortraitGenStatus("write a prompt or a bible first", true);
      return;
    }
    portraitGen.busy = true;
    $("#cast-portrait-gen-btn").disabled = true;
    setPortraitGenStatus("generating (10-40s depending on model)...");
    hidePortraitGenPreview();
    try {
      const result = await api("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: modelId, user_input: prompt }),
      });
      const oa = result && result.output_artifact;
      if (!oa || oa.type !== "image" || !oa.key) {
        throw new Error("model did not return an image artifact");
      }
      showPortraitGenPreview(oa.key);
      setPortraitGenStatus("preview ready. accept to save as the portrait.");
    } catch (e) {
      setPortraitGenStatus("generation failed: " + e.message, true);
    } finally {
      portraitGen.busy = false;
      $("#cast-portrait-gen-btn").disabled = false;
    }
  }

  async function acceptGeneratedPortrait() {
    const id = state.selectedId;
    const key = portraitGen.pendingKey;
    if (!id || !key) return;
    try {
      const data = await api("/api/cast/" + id + "/portrait", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from_chat_artifact: key }),
      });
      const idx = state.cast.findIndex((x) => x.id === id);
      if (idx >= 0) state.cast[idx] = data.cast;
      populateEditor(data.cast);
      renderCastList();
      hidePortraitGenPreview();
      setPortraitGenStatus("");
    } catch (e) {
      setPortraitGenStatus("could not save: " + e.message, true);
    }
  }

  // Training-set state.
  const training = {
    busy: false,
    abort: false,
  };

  function setTrainingStatus(text, isError) {
    const el = $("#cast-training-status");
    el.textContent = text || "";
    el.classList.toggle("is-error", !!isError);
  }

  function renderTrainingProgress(rows) {
    const ul = $("#cast-training-progress");
    ul.innerHTML = "";
    for (const r of rows) {
      const li = document.createElement("li");
      li.className = "cast-training-row cast-training-row-" + r.status;
      const label = document.createElement("span");
      label.className = "cast-training-row-label";
      label.textContent = (r.index + 1) + "/" + rows.length;
      li.appendChild(label);
      const status = document.createElement("span");
      status.className = "cast-training-row-status";
      status.textContent = r.status === "done" ? "done" : r.status === "fail" ? ("fail: " + (r.error || "?")) : r.status;
      li.appendChild(status);
      ul.appendChild(li);
    }
  }

  function updateTrainingGate(c) {
    const disabled = !c || !c.portrait_key;
    $("#cast-training-btn").disabled = disabled || training.busy;
    $("#cast-training-disabled").hidden = !disabled;
  }

  async function generateTrainingSet() {
    const id = state.selectedId;
    if (!id) return;
    const c = findCast(id);
    if (!c) return;
    if (!c.portrait_key) {
      setTrainingStatus("save a portrait first", true);
      return;
    }
    if (training.busy) return;
    if (!window.confirm("generate 10 training images? this takes about 2-4 minutes. you can navigate away mid-run; the saved refs will appear when you come back to this character.")) return;

    training.busy = true;
    training.abort = false;
    $("#cast-training-btn").disabled = true;
    setTrainingStatus("loading portrait...");

    let portraitDataUrl;
    try {
      portraitDataUrl = await fetchPortraitAsDataUrl(c.portrait_key);
    } catch (e) {
      setTrainingStatus("could not load portrait: " + e.message, true);
      training.busy = false;
      $("#cast-training-btn").disabled = false;
      return;
    }

    const rows = TRAINING_PROMPTS.map((t, i) => ({ index: i, status: "pending" }));
    renderTrainingProgress(rows);

    let okCount = 0;
    let failCount = 0;

    for (let i = 0; i < TRAINING_PROMPTS.length; i++) {
      if (training.abort) break;
      rows[i].status = "running";
      renderTrainingProgress(rows);
      setTrainingStatus("generating " + (i + 1) + "/" + TRAINING_PROMPTS.length + "...");

      const promptText = composeTrainingPrompt(TRAINING_PROMPTS[i], c.bible);
      try {
        const result = await api("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: TRAINING_MODEL_ID,
            user_input: promptText,
            attachments: [{ type: "image", mime: "image/png", filename: "portrait.png", data: portraitDataUrl }],
          }),
        });
        const oa = result && result.output_artifact;
        if (!oa || oa.type !== "image" || !oa.key) throw new Error("no image returned");
        const saved = await api("/api/cast/" + id + "/refs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from_chat_artifact: oa.key }),
        });
        const idx = state.cast.findIndex((x) => x.id === id);
        if (idx >= 0) state.cast[idx] = saved.cast;
        rows[i].status = "done";
        okCount++;
      } catch (e) {
        rows[i].status = "fail";
        rows[i].error = e.message;
        failCount++;
      }
      renderTrainingProgress(rows);
    }

    const cur = findCast(id);
    if (cur) populateEditor(cur);
    renderCastList();

    training.busy = false;
    updateTrainingGate(cur);
    setTrainingStatus(
      training.abort
        ? "stopped. " + okCount + " saved, " + failCount + " failed."
        : okCount + " saved, " + failCount + " failed.",
      failCount > 0 && !training.abort,
    );
  }

  function wire() {
    $("#cast-new-btn").addEventListener("click", newCast);
    $("#cast-save-btn").addEventListener("click", saveCast);
    $("#cast-delete-btn").addEventListener("click", deleteSelected);
    $("#cast-portrait-clear").addEventListener("click", clearPortrait);

    $("#cast-name").addEventListener("input", () => markDirty(true));
    $("#cast-bible").addEventListener("input", () => markDirty(true));

    $("#cast-portrait-file").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) uploadPortraitFile(f);
      e.target.value = "";
    });
    $("#cast-ref-file").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) uploadRefFile(f);
      e.target.value = "";
    });

    // v0.47.0: portrait + training-set generation.
    $("#cast-portrait-gen-btn").addEventListener("click", generatePortrait);
    $("#cast-portrait-gen-accept").addEventListener("click", acceptGeneratedPortrait);
    $("#cast-portrait-gen-discard").addEventListener("click", () => {
      hidePortraitGenPreview();
      setPortraitGenStatus("");
    });
    $("#cast-training-btn").addEventListener("click", generateTrainingSet);
    // v0.57.0: standalone LoRA training.
    const loraBtn = $("#cast-lora-train-btn");
    if (loraBtn) loraBtn.addEventListener("click", trainLora);

    // Populate the image-gen model picker on demand (first time a user
    // opens the "generate via chat" disclosure).
    const portraitDetails = document.querySelector(".cast-portrait-pane .cast-gen-block");
    if (portraitDetails) {
      portraitDetails.addEventListener("toggle", () => {
        if (portraitDetails.open) ensurePortraitGenModelOptions();
      }, { once: false });
    }
  }

  // ---------- v0.57.0: standalone LoRA training ----------

  const LORA_POLL_MS = 5000;
  let loraPollTimer = null;
  let loraPollInflight = false;

  function timeAgoSeconds(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "";
    if (seconds < 60) return Math.floor(seconds) + "s";
    if (seconds < 3600) return Math.floor(seconds / 60) + "m";
    if (seconds < 86400) return Math.floor(seconds / 3600) + "h";
    return Math.floor(seconds / 86400) + "d";
  }

  function setLoraStatusText(text, kind) {
    const el = $("#cast-lora-status-text");
    if (!el) return;
    el.textContent = text || "";
    el.className = "cast-gen-status" + (kind ? " is-" + kind : "");
  }

  function renderLoraPane(c) {
    const badge = $("#cast-lora-badge");
    const meta = $("#cast-lora-meta");
    const btn = $("#cast-lora-train-btn");
    const dl = $("#cast-lora-download");
    if (!badge || !meta || !btn || !dl) return;
    if (!c) {
      badge.textContent = "idle";
      badge.className = "cast-lora-badge cast-lora-badge-idle";
      meta.textContent = "";
      btn.disabled = true;
      dl.hidden = true;
      setLoraStatusText("");
      return;
    }
    const status = c.lora_status || "idle";
    badge.textContent = status;
    badge.className = "cast-lora-badge cast-lora-badge-" + status;
    // Meta text: ready -> "trained Xm ago, N.M MB"; training -> job id
    // tail; failed -> show the error (truncated); idle -> nothing.
    let metaText = "";
    if (status === "ready" && c.lora_trained_at) {
      const trained = new Date(c.lora_trained_at + "Z");
      const ageS = (Date.now() - trained.getTime()) / 1000;
      metaText = "trained " + timeAgoSeconds(ageS) + " ago";
    } else if (status === "training" && c.lora_job_id) {
      metaText = "job " + c.lora_job_id.slice(0, 18) + "…";
    } else if (status === "failed" && c.lora_error) {
      metaText = c.lora_error.slice(0, 120) + (c.lora_error.length > 120 ? "…" : "");
    }
    meta.textContent = metaText;
    // Train button enabled when we have the inputs and no run is in
    // flight. Retraining (status: ready / failed) is allowed.
    const ready = !!c.portrait_key && Array.isArray(c.ref_keys) && c.ref_keys.length >= 4;
    btn.disabled = status === "training" || !ready;
    btn.textContent = status === "ready" || status === "failed" ? "retrain LoRA" : "train LoRA";
    if (status === "ready" && c.lora_key) {
      dl.href = "/api/artifact/" + c.lora_key;
      dl.hidden = false;
    } else {
      dl.hidden = true;
      dl.href = "";
    }
    if (!ready) {
      setLoraStatusText(
        c.portrait_key
          ? "add at least 4 training references before training"
          : "save a portrait first",
        "warn"
      );
    } else if (status === "idle") {
      setLoraStatusText("");
    } else if (status === "training") {
      setLoraStatusText("training in progress, ~8-15 min on the GPU", "loading");
    } else if (status === "ready") {
      setLoraStatusText("LoRA ready to use in future renders", "success");
    } else if (status === "failed") {
      setLoraStatusText("training failed; see meta above", "error");
    }
  }

  async function trainLora() {
    const id = state.selectedId;
    if (!id) return;
    const c = findCast(id);
    if (!c) return;
    if (!window.confirm(
      "Train LoRA for " + c.name + "?\n\n"
      + "This kicks off a standalone training job on the GPU. "
      + "Typical wall-clock: 8-15 minutes. Estimated cost: $0.50-$2 of GPU time.\n\n"
      + (c.lora_status === "ready"
        ? "This will retrain (the existing .safetensors stays in R2 until you delete it).\n\n"
        : "")
      + "Continue?"
    )) return;
    setLoraStatusText("submitting...", "loading");
    try {
      const data = await api("/api/cast/" + id + "/train-lora", { method: "POST" });
      const idx = state.cast.findIndex((x) => x.id === id);
      if (idx >= 0) state.cast[idx] = data.cast;
      renderLoraPane(data.cast);
      schedulePollLoraStatus(id);
    } catch (e) {
      setLoraStatusText("submit failed: " + e.message, "error");
    }
  }

  function schedulePollLoraStatus(id) {
    if (loraPollTimer) clearTimeout(loraPollTimer);
    loraPollTimer = setTimeout(() => pollLoraStatus(id), LORA_POLL_MS);
  }

  async function pollLoraStatus(id) {
    if (loraPollInflight) {
      schedulePollLoraStatus(id);
      return;
    }
    if (state.selectedId !== id) {
      // User switched to another character; let the new selection
      // restart polling if needed.
      loraPollTimer = null;
      return;
    }
    loraPollInflight = true;
    try {
      const data = await api("/api/cast/" + id + "/lora-status");
      const idx = state.cast.findIndex((x) => x.id === id);
      if (idx >= 0) state.cast[idx] = data.cast;
      if (state.selectedId === id) {
        renderLoraPane(data.cast);
      }
      if (data.cast && data.cast.lora_status === "training") {
        schedulePollLoraStatus(id);
      } else {
        loraPollTimer = null;
      }
    } catch (e) {
      setLoraStatusText("poll error: " + e.message + " (retrying)", "error");
      schedulePollLoraStatus(id);
    } finally {
      loraPollInflight = false;
    }
  }

  // Expose pure helpers for vitest.
  window.__castHelpers = { encodeRefKey, artifactUrl, composeTrainingPrompt };

  document.addEventListener("DOMContentLoaded", () => {
    wire();
    loadCastList();
  });
})();

// Storyboard planner UI (v0.33.0).
//
// Hydrates the model picker from GET /api/storyboard/models, takes a brief
// plus up to four character entries (slots A through D), and walks the
// three-stage pipeline:
//
//   1. plan    POST /api/storyboard/plan
//                  -> validated storyboard JSON + bundle-ready YAML, or
//                  -> validator errors + raw model output (re-prompt path).
//   2. bundle  POST /api/storyboard/character-ref (per training image),
//              then POST /api/storyboard/bundle (assemble the .tar.gz).
//   3. render  POST /api/storyboard/render (submit job to RunPod), then
//              GET /api/storyboard/render/<jobId> on an 8-second poll
//              loop until the job hits a terminal status.
//
// Vanilla JS, no framework. Reuses the chat UI's CSS tokens from styles.css.

const SLOT_IDS = ["A", "B", "C", "D"];
const POLL_INTERVAL_MS = 8000;
const HISTORY_LIMIT = 25;

const $ = (sel) => document.querySelector(sel);

// ---------- State (held in module scope across stages) ----------

const planState = {
  storyboard: null,         // StoryboardValidated from POST /api/storyboard/plan
  cast: [],                 // PlannerCharacter[] from the cast form at plan time
};

const bundleState = {
  // perSlotUploads[slot] = [{filename, size, mime, key, status, error}]
  perSlotUploads: {},
  bundleKey: null,
};

const renderState = {
  jobId: null,
  pollTimer: null,
};

// ---------- Cast editor (plan stage) ----------

function renderCast() {
  const root = $("#planner-cast");
  root.innerHTML = "";
  for (const slot of SLOT_IDS) {
    const row = document.createElement("div");
    row.className = "planner-cast-row";
    row.dataset.slot = slot;

    const check = document.createElement("label");
    check.className = "planner-cast-check";
    const checkInput = document.createElement("input");
    checkInput.type = "checkbox";
    checkInput.dataset.castInclude = "";
    check.appendChild(checkInput);
    check.appendChild(document.createTextNode(" slot " + slot));

    const name = document.createElement("input");
    name.type = "text";
    name.className = "planner-cast-name";
    name.placeholder = "name (e.g. Kira)";
    name.disabled = true;

    const bible = document.createElement("textarea");
    bible.className = "planner-cast-bible";
    bible.rows = 2;
    bible.placeholder = "bible: condensed appearance description";
    bible.disabled = true;

    checkInput.addEventListener("change", () => {
      const enabled = checkInput.checked;
      name.disabled = !enabled;
      bible.disabled = !enabled;
      if (enabled) name.focus();
    });

    row.appendChild(check);
    row.appendChild(name);
    row.appendChild(bible);
    root.appendChild(row);
  }
}

function collectCast() {
  const characters = [];
  for (const row of document.querySelectorAll(".planner-cast-row")) {
    const include = row.querySelector("[data-cast-include]").checked;
    if (!include) continue;
    const slot = row.dataset.slot;
    const name = row.querySelector(".planner-cast-name").value.trim();
    const bible = row.querySelector(".planner-cast-bible").value.trim();
    if (!name) continue;
    characters.push({ slot, name, bible });
  }
  return characters;
}

// ---------- Model picker hydration ----------

async function loadModels() {
  const select = $("#planner-model");
  select.disabled = true;
  select.innerHTML = '<option>loading models...</option>';
  try {
    const resp = await fetch("/api/storyboard/models");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    select.innerHTML = "";
    if (!Array.isArray(data.models) || data.models.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "no planning models available";
      select.appendChild(opt);
      return;
    }
    for (const model of data.models) {
      const opt = document.createElement("option");
      opt.value = model.id;
      opt.textContent = model.label || model.id;
      select.appendChild(opt);
    }
    select.disabled = false;
  } catch (err) {
    select.innerHTML = "";
    const opt = document.createElement("option");
    opt.textContent = "failed to load models: " + err.message;
    select.appendChild(opt);
  }
}

// ---------- Plan stage dispatcher ----------

async function plan() {
  const briefEl = $("#planner-brief");
  const model = $("#planner-model").value;
  const brief = briefEl.value.trim();

  if (!brief) {
    setStatus("brief is required", "error");
    briefEl.focus();
    return;
  }
  if (!model) {
    setStatus("select a model first", "error");
    return;
  }

  const characters = collectCast();

  // Reset any prior bundle / render state when re-planning.
  resetBundleStage();
  resetRenderStage();

  setStatus("planning, this can take 5 to 30 seconds...", "loading");
  $("#planner-plan").disabled = true;

  let httpStatus = 0;
  let data = null;
  try {
    const resp = await fetch("/api/storyboard/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief, characters, model }),
    });
    httpStatus = resp.status;
    try {
      data = await resp.json();
    } catch {
      data = { error: "non-JSON response from server" };
    }
  } catch (err) {
    setStatus("network error: " + err.message, "error");
    $("#planner-plan").disabled = false;
    return;
  } finally {
    $("#planner-plan").disabled = false;
  }

  renderPlanResult(httpStatus, data, model, characters);
}

function renderPlanResult(httpStatus, data, model, characters) {
  $("#planner-output").hidden = false;
  $("#planner-output-meta").textContent =
    "model: " + model + " · HTTP " + httpStatus;
  const state = $("#planner-output-state");
  const errorsPanel = $("#planner-errors");
  const resultPanel = $("#planner-result");
  const rawPanel = $("#planner-raw");

  if (httpStatus === 400) {
    state.textContent = "request rejected";
    state.className = "planner-output-state planner-error";
    errorsPanel.hidden = false;
    resultPanel.hidden = true;
    rawPanel.hidden = true;
    renderErrors([data && data.error ? data.error : "unknown 400 error"]);
    setStatus("400: " + (data && data.error ? data.error : "request rejected"), "error");
    return;
  }

  if (httpStatus === 502 || (data && data.ok === false)) {
    const isUpstream = httpStatus === 502;
    state.textContent = isUpstream ? "upstream error" : "model output invalid";
    state.className = "planner-output-state planner-error";
    errorsPanel.hidden = false;
    renderErrors((data && data.errors) || ["unknown error"]);
    resultPanel.hidden = true;
    if (data && data.raw) {
      rawPanel.hidden = false;
      $("#planner-raw-content").textContent = data.raw;
    } else {
      rawPanel.hidden = true;
    }
    setStatus(
      isUpstream ? "upstream call failed (502)" : "model output did not validate",
      "error",
    );
    return;
  }

  if (data && data.ok === true) {
    state.textContent = "ok";
    state.className = "planner-output-state planner-success";
    errorsPanel.hidden = true;
    rawPanel.hidden = true;
    resultPanel.hidden = false;
    $("#planner-json").textContent = JSON.stringify(data.storyboard, null, 2);
    $("#planner-yaml").textContent = data.yaml || "";
    const sceneCount =
      data.storyboard && data.storyboard.scenes ? data.storyboard.scenes.length : 0;
    setStatus("planned successfully (" + sceneCount + " scenes)", "success");
    showBundleStage(data.storyboard, characters);
    return;
  }

  state.textContent = "unexpected response shape";
  state.className = "planner-output-state planner-error";
  errorsPanel.hidden = false;
  resultPanel.hidden = true;
  rawPanel.hidden = true;
  renderErrors(["unexpected response shape; see network tab"]);
  setStatus("unexpected response shape", "error");
}

function renderErrors(errors) {
  const list = $("#planner-errors-list");
  list.innerHTML = "";
  for (const err of errors) {
    const li = document.createElement("li");
    li.textContent = err;
    list.appendChild(li);
  }
}

function repromptWithErrors() {
  const items = document.querySelectorAll("#planner-errors-list li");
  if (items.length === 0) return;
  const errors = Array.from(items).map((li) => li.textContent);
  const briefEl = $("#planner-brief");
  const current = briefEl.value.trim();
  const block = [
    "",
    "",
    "PREVIOUS ATTEMPT FAILED VALIDATION. Please retry, fixing these issues:",
    ...errors.map((e) => "- " + e),
  ].join("\n");
  briefEl.value = current + block;
  briefEl.focus();
  briefEl.scrollIntoView({ behavior: "smooth", block: "start" });
  setStatus("brief updated with errors; click 'plan' to retry", "loading");
}

// ---------- Bundle stage ----------

function showBundleStage(storyboard, characters) {
  planState.storyboard = storyboard;
  planState.cast = characters;
  bundleState.perSlotUploads = {};
  bundleState.bundleKey = null;

  const useChars =
    Array.isArray(storyboard.use_characters) && storyboard.use_characters.length > 0
      ? storyboard.use_characters
      : [];

  const root = $("#planner-bundle-cast");
  root.innerHTML = "";

  if (useChars.length === 0) {
    // No slots loaded in the storyboard. The bundle is still legal (the
    // GPU side will skip identity-lock for empty-cast renders), but
    // assemble.py needs at least the storyboard.yaml. Show a note and
    // enable the bundle button immediately.
    const note = document.createElement("p");
    note.className = "planner-stage-hint";
    note.textContent =
      "this storyboard has no character slots loaded (use_characters is empty). "
      + "the bundle will ship just the storyboard; the GPU worker renders "
      + "without identity lock.";
    root.appendChild(note);
  } else {
    for (const slot of useChars) {
      bundleState.perSlotUploads[slot] = [];
      const ch = characters.find((c) => c.slot === slot) || {
        name: "Character " + slot,
        bible: "",
      };
      root.appendChild(buildSlotUploadRow(slot, ch));
    }
  }

  const stage = $("#planner-bundle");
  stage.hidden = false;
  stage.scrollIntoView({ behavior: "smooth", block: "start" });
  $("#planner-bundle-result").hidden = true;
  setBundleStatus("", "");
  setBundleMeta("");
}

function buildSlotUploadRow(slot, char) {
  const row = document.createElement("div");
  row.className = "planner-slot-upload";
  row.dataset.slot = slot;

  const head = document.createElement("div");
  head.className = "planner-slot-head";
  const headTitle = document.createElement("strong");
  headTitle.textContent = "slot " + slot + (char.name ? " · " + char.name : "");
  head.appendChild(headTitle);
  if (char.bible) {
    const bible = document.createElement("span");
    bible.className = "planner-slot-bible";
    bible.textContent = char.bible;
    head.appendChild(bible);
  }
  row.appendChild(head);

  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = "image/png,image/jpeg,image/webp";
  input.id = "planner-files-" + slot;
  input.className = "planner-slot-input";

  const label = document.createElement("label");
  label.htmlFor = input.id;
  label.className = "planner-slot-pick";
  label.textContent = "+ select PNG / JPEG / WEBP files (8 or more recommended)";

  row.appendChild(label);
  row.appendChild(input);

  const list = document.createElement("ul");
  list.className = "planner-slot-list";
  list.id = "planner-list-" + slot;
  row.appendChild(list);

  const summary = document.createElement("div");
  summary.className = "planner-slot-summary";
  summary.id = "planner-summary-" + slot;
  row.appendChild(summary);

  input.addEventListener("change", () => {
    handleSlotFiles(slot, input.files);
    // Reset the input so re-selecting the same file fires `change`.
    input.value = "";
  });

  return row;
}

async function handleSlotFiles(slot, fileList) {
  if (!fileList || fileList.length === 0) return;
  for (const file of fileList) {
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
      bundleState.perSlotUploads[slot].push({
        filename: file.name,
        size: file.size,
        mime: file.type || "(unknown)",
        key: null,
        status: "error",
        error: "unsupported type: " + (file.type || "(none)"),
      });
      renderSlotList(slot);
      continue;
    }
    const entry = {
      filename: file.name,
      size: file.size,
      mime: file.type,
      key: null,
      status: "uploading",
      error: null,
    };
    bundleState.perSlotUploads[slot].push(entry);
    renderSlotList(slot);
    try {
      const key = await uploadOneRef(file);
      entry.key = key;
      entry.status = "done";
    } catch (err) {
      entry.status = "error";
      entry.error = err.message || String(err);
    }
    renderSlotList(slot);
  }
}

async function uploadOneRef(file) {
  const resp = await fetch("/api/storyboard/character-ref", {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!resp.ok) {
    let errMsg = "HTTP " + resp.status;
    try {
      const data = await resp.json();
      if (data && data.error) errMsg = data.error;
    } catch {
      // non-JSON error body; keep the HTTP status
    }
    throw new Error(errMsg);
  }
  const data = await resp.json();
  if (!data.key) throw new Error("response missing `key`");
  return data.key;
}

function renderSlotList(slot) {
  const list = $("#planner-list-" + slot);
  list.innerHTML = "";
  for (const entry of bundleState.perSlotUploads[slot]) {
    const li = document.createElement("li");
    li.className = "planner-slot-entry";

    const filename = document.createElement("span");
    filename.className = "planner-slot-filename";
    filename.textContent = entry.filename;
    li.appendChild(filename);

    const size = document.createElement("span");
    size.className = "planner-slot-size";
    size.textContent = formatBytes(entry.size);
    li.appendChild(size);

    const status = document.createElement("span");
    if (entry.status === "uploading") {
      status.className = "planner-slot-uploading";
      status.textContent = "uploading...";
    } else if (entry.status === "done") {
      status.className = "planner-slot-done";
      status.textContent = "staged";
    } else {
      status.className = "planner-slot-error";
      status.textContent = "failed: " + (entry.error || "unknown");
    }
    li.appendChild(status);

    list.appendChild(li);
  }
  const summary = $("#planner-summary-" + slot);
  const total = bundleState.perSlotUploads[slot].reduce((a, e) => a + e.size, 0);
  const staged = bundleState.perSlotUploads[slot].filter((e) => e.status === "done").length;
  const errored = bundleState.perSlotUploads[slot].filter((e) => e.status === "error").length;
  summary.textContent =
    bundleState.perSlotUploads[slot].length
      + " selected, " + staged + " staged"
      + (errored ? ", " + errored + " failed" : "")
      + " · " + formatBytes(total);
}

async function bundleNow() {
  if (!planState.storyboard) {
    setBundleStatus("no validated storyboard; run 'plan' first", "error");
    return;
  }

  const useChars = planState.storyboard.use_characters || [];
  const characterRefs = {};
  const errors = [];

  for (const slot of useChars) {
    const uploads = bundleState.perSlotUploads[slot] || [];
    const stillUploading = uploads.some((e) => e.status === "uploading");
    if (stillUploading) {
      errors.push("slot " + slot + " has uploads still in progress");
      continue;
    }
    const staged = uploads.filter((e) => e.status === "done" && e.key);
    if (staged.length === 0) {
      errors.push("slot " + slot + " has no staged training images");
      continue;
    }
    const ch = planState.cast.find((c) => c.slot === slot) || {
      name: "Character " + slot,
      bible: "",
    };
    characterRefs[slot] = {
      name: ch.name,
      prompt: ch.bible || "",
      trainingImages: staged.map((e) => ({ key: e.key })),
    };
  }

  if (errors.length > 0) {
    setBundleStatus(errors.join(" · "), "error");
    return;
  }

  setBundleStatus("assembling .tar.gz on the worker...", "loading");
  $("#planner-bundle-btn").disabled = true;

  let resp = null;
  let data = null;
  try {
    resp = await fetch("/api/storyboard/bundle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        storyboard: planState.storyboard,
        characterRefs,
      }),
    });
    data = await resp.json();
  } catch (err) {
    setBundleStatus("network error: " + err.message, "error");
    $("#planner-bundle-btn").disabled = false;
    return;
  } finally {
    $("#planner-bundle-btn").disabled = false;
  }

  if (!resp.ok && data && data.error) {
    setBundleStatus("bundle rejected (" + resp.status + ")", "error");
    showBundleResult({ ok: false, errors: [data.error] });
    return;
  }

  if (data && data.ok === false) {
    setBundleStatus("bundle assembly failed", "error");
    showBundleResult(data);
    return;
  }

  if (data && data.ok === true && data.bundleKey) {
    bundleState.bundleKey = data.bundleKey;
    setBundleStatus("staged", "success");
    showBundleResult(data);
    showRenderStage();
    return;
  }

  setBundleStatus("unexpected response shape", "error");
}

function showBundleResult(data) {
  const root = $("#planner-bundle-result");
  root.hidden = false;
  root.innerHTML = "";

  if (data.ok === false) {
    const h = document.createElement("h3");
    h.textContent = "bundle errors";
    root.appendChild(h);
    const ul = document.createElement("ul");
    for (const e of data.errors || []) {
      const li = document.createElement("li");
      li.textContent = e;
      ul.appendChild(li);
    }
    root.appendChild(ul);
    return;
  }

  const h = document.createElement("h3");
  h.textContent = "bundle staged";
  root.appendChild(h);

  const keyLine = document.createElement("div");
  const keyLabel = document.createElement("span");
  keyLabel.className = "planner-render-label";
  keyLabel.textContent = "key:";
  const keyCode = document.createElement("code");
  keyCode.textContent = data.bundleKey || "";
  keyLine.appendChild(keyLabel);
  keyLine.appendChild(document.createTextNode(" "));
  keyLine.appendChild(keyCode);
  root.appendChild(keyLine);

  const sizeLine = document.createElement("div");
  const sizeLabel = document.createElement("span");
  sizeLabel.className = "planner-render-label";
  sizeLabel.textContent = "size:";
  sizeLine.appendChild(sizeLabel);
  sizeLine.appendChild(
    document.createTextNode(
      " " + formatBytes(data.sizeBytes || 0)
        + " gzipped, " + (data.fileCount || 0) + " files inside",
    ),
  );
  root.appendChild(sizeLine);
}

function resetBundleStage() {
  bundleState.perSlotUploads = {};
  bundleState.bundleKey = null;
  $("#planner-bundle").hidden = true;
  $("#planner-bundle-result").hidden = true;
  setBundleStatus("", "");
  setBundleMeta("");
}

// ---------- Render stage ----------

function showRenderStage() {
  const stage = $("#planner-render");
  stage.hidden = false;
  $("#planner-render-result").hidden = true;
  stage.scrollIntoView({ behavior: "smooth", block: "start" });
  setRenderStatus("", "");
}

async function submitRender() {
  if (!bundleState.bundleKey) {
    setRenderStatus("no bundleKey; run 'bundle' first", "error");
    return;
  }
  // Stop any prior poll loop before starting a new render.
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }
  const qualityTier = $("#planner-quality-tier").value;
  setRenderStatus("submitting to RunPod...", "loading");
  $("#planner-render-btn").disabled = true;

  let resp = null;
  let data = null;
  try {
    resp = await fetch("/api/storyboard/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bundleKey: bundleState.bundleKey,
        qualityTier,
      }),
    });
    data = await resp.json();
  } catch (err) {
    setRenderStatus("network error: " + err.message, "error");
    $("#planner-render-btn").disabled = false;
    return;
  }

  if (!resp.ok || (data && data.ok === false)) {
    const errs = (data && data.errors) || [(data && data.error) || "HTTP " + resp.status];
    setRenderStatus("submit failed: " + errs.join("; "), "error");
    $("#planner-render-btn").disabled = false;
    return;
  }

  if (!data || !data.jobId) {
    setRenderStatus("submit returned no jobId", "error");
    $("#planner-render-btn").disabled = false;
    return;
  }

  renderState.jobId = data.jobId;
  $("#planner-render-result").hidden = false;
  $("#planner-render-job-id").textContent = data.jobId;
  setJobStatusBadge(data.status || "IN_QUEUE");
  setRenderStatus("submitted; polling every " + (POLL_INTERVAL_MS / 1000) + "s", "loading");
  pollRender();
  // Refresh the history list so the new render appears at the top
  // without the user needing to click "refresh" manually.
  loadHistory();
}

async function pollRender() {
  if (!renderState.jobId) return;
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }

  let resp = null;
  let data = null;
  try {
    resp = await fetch("/api/storyboard/render/" + encodeURIComponent(renderState.jobId));
    data = await resp.json();
  } catch (err) {
    setRenderStatus("poll network error: " + err.message + " (retrying)", "error");
    renderState.pollTimer = setTimeout(pollRender, POLL_INTERVAL_MS);
    return;
  }

  if (!resp.ok || (data && data.ok === false)) {
    const errs = (data && data.errors) || [(data && data.error) || "HTTP " + resp.status];
    setRenderStatus("poll failed: " + errs.join("; ") + " (retrying)", "error");
    renderState.pollTimer = setTimeout(pollRender, POLL_INTERVAL_MS);
    return;
  }

  updateRenderProgress(data);

  const terminal = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"];
  if (terminal.indexOf(data.status) >= 0) {
    finalizeRender(data);
    $("#planner-render-btn").disabled = false;
    return;
  }

  // Keep polling.
  setRenderStatus(data.status.toLowerCase() + "; polling every " + (POLL_INTERVAL_MS / 1000) + "s", "loading");
  renderState.pollTimer = setTimeout(pollRender, POLL_INTERVAL_MS);
}

function updateRenderProgress(data) {
  setJobStatusBadge(data.status);

  const out = data.output;
  if (out && typeof out === "object") {
    if (typeof out.scene_index === "number" && typeof out.scene_total === "number") {
      const el = $("#planner-render-scene");
      el.hidden = false;
      el.innerHTML = "";
      const lab = document.createElement("span");
      lab.className = "planner-render-label";
      lab.textContent = "scene:";
      el.appendChild(lab);
      el.appendChild(
        document.createTextNode(" " + out.scene_index + "/" + out.scene_total),
      );
    }
    if (typeof out.phase === "string" && out.phase) {
      const el = $("#planner-render-phase");
      el.hidden = false;
      el.innerHTML = "";
      const lab = document.createElement("span");
      lab.className = "planner-render-label";
      lab.textContent = "phase:";
      el.appendChild(lab);
      el.appendChild(document.createTextNode(" " + out.phase));
    }
    if (Array.isArray(out.log) && out.log.length > 0) {
      const wrap = $("#planner-render-log-wrap");
      wrap.hidden = false;
      $("#planner-render-log").textContent = out.log.join("\n");
    }
  }

  if (data.error) {
    const err = $("#planner-render-error");
    err.hidden = false;
    err.textContent = data.error;
  }
}

function finalizeRender(data) {
  const elapsed = data.executionTimeMs
    ? " · ran for " + formatDuration(data.executionTimeMs)
    : "";

  if (data.status === "COMPLETED") {
    setRenderStatus("completed" + elapsed, "success");
    const outpan = $("#planner-render-output");
    outpan.hidden = false;
    $("#planner-render-output-content").textContent = JSON.stringify(
      data.output || {},
      null,
      2,
    );
    // Surface the silent MP4 link if present in the assembler output.
    const out = data.output;
    if (out && typeof out.output_key === "string") {
      const url = "/api/artifact/" + out.output_key;
      const download = $("#planner-render-download");
      download.href = url;
      download.download = (out.project || "silent") + ".mp4";
      const open = $("#planner-render-open");
      open.href = url;
    }
    return;
  }

  // Terminal failure of some flavor.
  setRenderStatus(data.status.toLowerCase() + elapsed, "error");
  const outpan = $("#planner-render-output");
  outpan.hidden = false;
  $("#planner-render-output-content").textContent = JSON.stringify(data.output || {}, null, 2);
}

function setJobStatusBadge(status) {
  const el = $("#planner-render-job-status");
  el.textContent = status;
  let kind = "running";
  if (status === "COMPLETED") kind = "done";
  if (status === "FAILED" || status === "CANCELLED" || status === "TIMED_OUT") kind = "error";
  el.className = "planner-render-job-status planner-render-status-" + kind;
  // Cancel button visible only while the job is still cancellable (queued
  // or running). RunPod accepts cancel on either; terminal states reject.
  const cancelBtn = $("#planner-render-cancel");
  if (status === "IN_QUEUE" || status === "IN_PROGRESS") {
    cancelBtn.hidden = false;
    cancelBtn.disabled = false;
  } else {
    cancelBtn.hidden = true;
  }
}

async function cancelRender() {
  if (!renderState.jobId) return;
  // Optimistic UX: disable the button and pause the poll loop while the
  // cancel call is in flight. Failure restores the button (still
  // cancellable); success lets the next poll pick up the CANCELLED state.
  const cancelBtn = $("#planner-render-cancel");
  cancelBtn.disabled = true;
  setRenderStatus("requesting cancel...", "loading");
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }

  let resp = null;
  let data = null;
  try {
    resp = await fetch(
      "/api/storyboard/render/" + encodeURIComponent(renderState.jobId),
      { method: "DELETE" },
    );
    data = await resp.json();
  } catch (err) {
    setRenderStatus("cancel network error: " + err.message, "error");
    cancelBtn.disabled = false;
    // Resume polling so the UI keeps reflecting reality.
    renderState.pollTimer = setTimeout(pollRender, POLL_INTERVAL_MS);
    return;
  }

  if (!resp.ok || (data && data.ok === false)) {
    const errs = (data && data.errors) || [(data && data.error) || "HTTP " + resp.status];
    setRenderStatus("cancel failed: " + errs.join("; "), "error");
    cancelBtn.disabled = false;
    renderState.pollTimer = setTimeout(pollRender, POLL_INTERVAL_MS);
    return;
  }

  // RunPod accepted the cancel; the next poll will see CANCELLED.
  setRenderStatus("cancel requested; polling for final status", "loading");
  if (data && data.status) setJobStatusBadge(data.status);
  renderState.pollTimer = setTimeout(pollRender, POLL_INTERVAL_MS);
}

function resetRenderStage() {
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }
  renderState.jobId = null;
  $("#planner-render").hidden = true;
  $("#planner-render-result").hidden = true;
  setRenderStatus("", "");
}

// ---------- Render history (v0.34.1) ----------
//
// Loads the user's recent renders from GET /api/storyboard/renders on page
// open and after every successful submit. Each row's "view" action resumes
// the render stage with the row's stored snapshot and re-starts polling
// when the job is still in flight, so a tab close no longer loses access
// to in-progress renders. Past renders that already reached COMPLETED
// surface the silent MP4 directly via a "download" link.

async function loadHistory() {
  try {
    const resp = await fetch("/api/storyboard/renders?limit=" + HISTORY_LIMIT);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    renderHistoryList(data.renders || []);
  } catch (err) {
    // Silent: a history load failure should not block the planning flow.
    // The user can still plan, bundle, render normally; only the history
    // surface is missing.
    console.error("history load failed:", err);
  }
}

function renderHistoryList(rows) {
  const section = $("#planner-history");
  const list = $("#planner-history-list");
  list.innerHTML = "";

  if (!rows || rows.length === 0) {
    section.hidden = true;
    return;
  }

  for (const r of rows) {
    list.appendChild(buildHistoryRow(r));
  }
  section.hidden = false;
}

function buildHistoryRow(r) {
  const li = document.createElement("li");
  li.className = "planner-history-item";
  li.dataset.jobId = r.job_id;

  const meta = document.createElement("div");
  meta.className = "planner-history-meta";

  const project = document.createElement("strong");
  project.textContent = r.project || "(no project)";
  meta.appendChild(project);

  const tier = document.createElement("span");
  tier.className = "planner-history-tier";
  tier.textContent = r.quality_tier || "?";
  meta.appendChild(tier);

  const status = document.createElement("span");
  status.className =
    "planner-history-status planner-history-status-" + historyStatusKind(r.status);
  status.textContent = r.status;
  meta.appendChild(status);

  li.appendChild(meta);

  const sub = document.createElement("div");
  sub.className = "planner-history-sub";
  const parts = [];
  if (r.submitted_at) parts.push("submitted " + formatRelative(r.submitted_at));
  if (r.completed_at) parts.push("finished " + formatRelative(r.completed_at));
  if (r.execution_time_ms) parts.push("ran " + formatDuration(r.execution_time_ms));
  sub.textContent = parts.join(" · ");
  li.appendChild(sub);

  const actions = document.createElement("div");
  actions.className = "planner-history-actions";

  const view = document.createElement("button");
  view.type = "button";
  view.className = "planner-history-action";
  view.textContent = "view";
  view.addEventListener("click", () => resumeRender(r));
  actions.appendChild(view);

  if (r.output_key) {
    const dl = document.createElement("a");
    dl.href = "/api/artifact/" + r.output_key;
    dl.download = (r.project || "silent") + ".mp4";
    dl.className = "planner-history-action";
    dl.textContent = "download";
    actions.appendChild(dl);
  }

  li.appendChild(actions);
  return li;
}

function historyStatusKind(status) {
  if (status === "COMPLETED") return "done";
  if (status === "FAILED" || status === "CANCELLED" || status === "TIMED_OUT") return "error";
  return "running";
}

// Load the render stage with the past render's stored state and resume
// polling when the job is still in flight. Skips the plan + bundle stages
// since the user is jumping straight to "see this render's status".
function resumeRender(row) {
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }
  renderState.jobId = row.job_id;
  bundleState.bundleKey = row.bundle_key;

  const renderSection = $("#planner-render");
  renderSection.hidden = false;
  $("#planner-render-result").hidden = false;
  $("#planner-render-job-id").textContent = row.job_id;
  setJobStatusBadge(row.status);

  // Reset transient panels before populating from the row.
  $("#planner-render-scene").hidden = true;
  $("#planner-render-phase").hidden = true;
  $("#planner-render-error").hidden = true;
  $("#planner-render-log-wrap").hidden = true;
  $("#planner-render-output").hidden = true;

  if (row.output) {
    const outpan = $("#planner-render-output");
    outpan.hidden = false;
    $("#planner-render-output-content").textContent = JSON.stringify(row.output, null, 2);
    if (row.output_key) {
      const url = "/api/artifact/" + row.output_key;
      $("#planner-render-download").href = url;
      $("#planner-render-download").download = (row.project || "silent") + ".mp4";
      $("#planner-render-open").href = url;
    }
    // In-flight rows may carry a render log on the persisted output blob;
    // surface it for visual continuity with a live poll.
    if (row.output && typeof row.output === "object" && Array.isArray(row.output.log)) {
      const wrap = $("#planner-render-log-wrap");
      wrap.hidden = false;
      $("#planner-render-log").textContent = row.output.log.join("\n");
    }
  }

  if (row.error) {
    const err = $("#planner-render-error");
    err.hidden = false;
    err.textContent = row.error;
  }

  const terminal = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"];
  if (terminal.indexOf(row.status) < 0) {
    setRenderStatus("resumed; polling every " + (POLL_INTERVAL_MS / 1000) + "s", "loading");
    pollRender();
  } else {
    const kind = row.status === "COMPLETED" ? "success" : "error";
    setRenderStatus(row.status.toLowerCase() + " (from history)", kind);
  }

  renderSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function formatRelative(unixSeconds) {
  if (!unixSeconds) return "";
  const now = Math.floor(Date.now() / 1000);
  const delta = now - Number(unixSeconds);
  if (delta < 60) return delta + "s ago";
  if (delta < 3600) return Math.floor(delta / 60) + "m ago";
  if (delta < 86400) return Math.floor(delta / 3600) + "h ago";
  return Math.floor(delta / 86400) + "d ago";
}

// ---------- Status / formatting helpers ----------

function setStatus(text, kind) {
  const el = $("#planner-status");
  el.textContent = text;
  el.className = "planner-status planner-status-" + (kind || "");
}

function setBundleStatus(text, kind) {
  const el = $("#planner-bundle-status");
  el.textContent = text;
  el.className = "planner-status planner-status-" + (kind || "");
}

function setBundleMeta(text) {
  $("#planner-bundle-meta").textContent = text;
}

function setRenderStatus(text, kind) {
  const el = $("#planner-render-status");
  el.textContent = text;
  el.className = "planner-status planner-status-" + (kind || "");
}

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function formatDuration(ms) {
  if (ms < 1000) return ms + " ms";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return sec + " s";
  const min = Math.floor(sec / 60);
  const remSec = sec - min * 60;
  return min + "m " + remSec + "s";
}

// ---------- Init ----------

document.addEventListener("DOMContentLoaded", () => {
  renderCast();
  loadModels();
  loadHistory();
  $("#planner-plan").addEventListener("click", plan);
  $("#planner-reprompt").addEventListener("click", repromptWithErrors);
  $("#planner-bundle-btn").addEventListener("click", bundleNow);
  $("#planner-render-btn").addEventListener("click", submitRender);
  $("#planner-render-cancel").addEventListener("click", cancelRender);
  $("#planner-history-refresh").addEventListener("click", loadHistory);

  $("#planner-brief").addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
      ev.preventDefault();
      plan();
    }
  });
});

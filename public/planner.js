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
const HISTORY_AUTO_REFRESH_MS = 30000;
// v0.38.0: localStorage key for the persisted planner state. Bumped when
// the shape changes incompatibly so a stale stash never crashes restore.
const STORAGE_KEY = "skyphusion.planner.state.v1";
// v0.38.0: debounce form-input saves so a typed brief does not write to
// localStorage on every keystroke.
const PERSIST_DEBOUNCE_MS = 500;

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
  eventSource: null,        // v0.35.0: live SSE connection when streaming
  streamFallbackHit: false, // set after one failed stream attempt to skip retries
  currentProject: null,     // v0.37.0: display name for notifications
  currentLabel: null,       // v0.37.0: user-authored label, preferred over project
};

// v0.37.0: browser notification state. `permission` mirrors Notification.
// permission ("default" | "granted" | "denied" | "unsupported");
// `alreadyNotified` dedupes per session so a stream that re-fires a
// terminal event does not double-ping the OS.
const notifyState = {
  permission: "default",
  alreadyNotified: new Set(),
};

// ---------- localStorage persistence (v0.38.0) ----------
//
// Snapshots every meaningful state-changing event (brief edit, cast field
// change, plan success, image upload completion, bundle assembly, render
// submit, filter toggle) to localStorage under STORAGE_KEY. On page load,
// restorePersistedState() rebuilds the plan / bundle / render panels and
// reattaches a live SSE stream when the persisted render is in-flight.
// Corrupted stash silently clears and proceeds with fresh state; quota
// exceeded silently no-ops (the planner still works, persistence just
// stops until next reload).

let persistTimer = null;

function persistSoon() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(savePersistedState, PERSIST_DEBOUNCE_MS);
}

function savePersistedState() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    const snapshot = {
      planForm: collectPlanFormState(),
      planResult: collectPlanResultState(),
      bundleStage: collectBundleStageState(),
      renderStage: collectRenderStageState(),
      historyFilters: { ...historyState.filters },
      // v0.41.1: persist in-flight regen jobs so a page refresh resumes
      // polling instead of stranding the regen + leaving the button
      // disabled. Map serialization is Array.from(entries); the value
      // is already a plain object (jobId, kfKey, shotId, rowId,
      // startedAt) so JSON.stringify round-trips it cleanly.
      regenJobs: collectRegenJobs(),
      savedAt: Math.floor(Date.now() / 1000),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch (err) {
    // QuotaExceededError on private mode, etc. Persistence is best-effort;
    // a save failure does not block the user's planning flow.
    console.warn("savePersistedState failed:", err);
  }
}

// v0.41.1: serialize historyState.regenJobs to an array of [key, value]
// pairs. JSON does not preserve Map identity, so we round-trip via the
// canonical entries representation. Pure for testability.
function collectRegenJobs() {
  return Array.from(historyState.regenJobs.entries());
}

function loadPersistedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn("loadPersistedState failed; clearing:", err);
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    return null;
  }
}

// ---------- State collectors (read DOM + module state) ----------

function collectPlanFormState() {
  const modelEl = $("#planner-model");
  return {
    modelId: modelEl ? modelEl.value : "",
    brief: $("#planner-brief").value,
    cast: SLOT_IDS.map((slot) => {
      const row = document.querySelector('.planner-cast-row[data-slot="' + slot + '"]');
      if (!row) return { slot, checked: false, name: "", bible: "" };
      return {
        slot,
        checked: row.querySelector("[data-cast-include]").checked,
        name: row.querySelector(".planner-cast-name").value,
        bible: row.querySelector(".planner-cast-bible").value,
      };
    }),
  };
}

function collectPlanResultState() {
  if (!planState.storyboard) return null;
  return {
    storyboard: planState.storyboard,
    cast: planState.cast,
    yaml: $("#planner-yaml").textContent,
  };
}

function collectBundleStageState() {
  const stage = $("#planner-bundle");
  if (!stage || stage.hidden) return null;
  return {
    perSlotUploads: { ...bundleState.perSlotUploads },
    bundleKey: bundleState.bundleKey,
  };
}

function collectRenderStageState() {
  const stage = $("#planner-render");
  if (!stage || stage.hidden) return null;
  if (!renderState.jobId && !bundleState.bundleKey) return null;
  const tierEl = $("#planner-quality-tier");
  const overridesEl = $("#planner-render-overrides");
  const kfOnlyEl = $("#planner-keyframes-only");
  return {
    jobId: renderState.jobId,
    bundleKey: bundleState.bundleKey,
    qualityTier: tierEl ? tierEl.value : "final",
    renderOverridesText: overridesEl ? overridesEl.value : "",
    // v0.40.0: persist the checkbox so a refresh-mid-flow does not
    // silently flip an in-progress preview into a full render.
    keyframesOnly: kfOnlyEl ? kfOnlyEl.checked : false,
    currentProject: renderState.currentProject,
    currentLabel: renderState.currentLabel,
    lastKnownStatus: lastKnownStatusFromPanel(),
  };
}

function lastKnownStatusFromPanel() {
  const el = $("#planner-render-job-status");
  return el ? el.textContent || null : null;
}

// ---------- Restorers ----------

function restorePersistedState() {
  const stash = loadPersistedState();
  if (!stash) return null;

  // Filters first so loadHistory's first render uses the restored view.
  if (stash.historyFilters) restoreHistoryFilters(stash.historyFilters);

  // Plan form fields. Model picker value is set later (after loadModels).
  if (stash.planForm) restorePlanForm(stash.planForm);

  // Plan result panel (storyboard JSON + YAML side-by-side view).
  if (stash.planResult) restorePlanResultPanel(stash.planResult);

  // Bundle stage (per-slot upload widgets with already-staged R2 keys).
  if (stash.bundleStage && stash.planResult) {
    restoreBundleStagePanel(stash.bundleStage, stash.planResult);
  }

  // Render stage + reattach an SSE stream for in-flight renders.
  if (stash.renderStage) restoreRenderStagePanel(stash.renderStage);

  // v0.41.1: restore in-flight regen jobs and resume polling. Drop
  // entries older than the cap so a regen abandoned across a long
  // gap (or one whose RunPod job TTL has expired) does not keep
  // polling forever.
  if (Array.isArray(stash.regenJobs)) restoreRegenJobs(stash.regenJobs);

  return stash;
}

// v0.41.1: rebuild historyState.regenJobs from the persisted entries
// array, then kick off polling for each surviving entry. Entries older
// than REGEN_RESTORE_MAX_AGE_MS are dropped (matches the rough upper
// bound on a render's wall-clock duration; RunPod's job TTL is 24h but
// a regen specifically is supposed to be a 30-60s operation, so any
// entry older than ~6h is almost certainly abandoned).
const REGEN_RESTORE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function restoreRegenJobs(saved) {
  const now = Date.now();
  historyState.regenJobs.clear();
  for (const entry of saved) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [key, state] = entry;
    if (typeof key !== "string" || !state || typeof state !== "object") continue;
    if (typeof state.jobId !== "string" || state.jobId.length === 0) continue;
    if (typeof state.kfKey !== "string" || state.kfKey.length === 0) continue;
    if (typeof state.shotId !== "string" || state.shotId.length === 0) continue;
    const startedAt = typeof state.startedAt === "number" ? state.startedAt : 0;
    if (startedAt && now - startedAt > REGEN_RESTORE_MAX_AGE_MS) continue;
    historyState.regenJobs.set(key, {
      jobId: state.jobId,
      kfKey: state.kfKey,
      shotId: state.shotId,
      rowId: state.rowId,
      startedAt: startedAt || now,
    });
    // Resume polling. pollRegenJob reads the latest state from the
    // Map each tick, so a race with a subsequent set / delete is
    // resolved at next poll boundary.
    pollRegenJob(key);
  }
}

function restoreHistoryFilters(saved) {
  historyState.filters.text = typeof saved.text === "string" ? saved.text : "";
  historyState.filters.showInFlight = saved.showInFlight !== false;
  historyState.filters.showDone = saved.showDone !== false;
  historyState.filters.showFailed = saved.showFailed !== false;
  // Mirror to the form controls so the visible state matches the
  // persisted state. applyHistoryFilters runs when loadHistory completes.
  $("#planner-history-search").value = historyState.filters.text;
  $("#planner-filter-inflight").checked = historyState.filters.showInFlight;
  $("#planner-filter-done").checked = historyState.filters.showDone;
  $("#planner-filter-failed").checked = historyState.filters.showFailed;
}

function restorePlanForm(saved) {
  if (typeof saved.brief === "string") $("#planner-brief").value = saved.brief;
  if (Array.isArray(saved.cast)) {
    for (const entry of saved.cast) {
      const row = document.querySelector('.planner-cast-row[data-slot="' + entry.slot + '"]');
      if (!row) continue;
      const check = row.querySelector("[data-cast-include]");
      const name = row.querySelector(".planner-cast-name");
      const bible = row.querySelector(".planner-cast-bible");
      check.checked = !!entry.checked;
      name.disabled = !entry.checked;
      bible.disabled = !entry.checked;
      name.value = entry.name || "";
      bible.value = entry.bible || "";
    }
  }
}

function restorePlanResultPanel(saved) {
  if (!saved.storyboard) return;
  planState.storyboard = saved.storyboard;
  planState.cast = saved.cast || [];

  $("#planner-output").hidden = false;
  $("#planner-output-meta").textContent = "(restored from previous session)";
  $("#planner-output-state").textContent = "ok";
  $("#planner-output-state").className = "planner-output-state planner-success";
  $("#planner-errors").hidden = true;
  $("#planner-result").hidden = false;
  $("#planner-raw").hidden = true;
  $("#planner-json").textContent = JSON.stringify(saved.storyboard, null, 2);
  $("#planner-yaml").textContent = saved.yaml || "";
}

function restoreBundleStagePanel(savedBundle, savedPlanResult) {
  // Filter out "uploading" entries: those were interrupted by the reload
  // and would mislead the user about state. The R2 ingest never finished
  // for them, so they would not be in the bundle anyway.
  const filteredUploads = {};
  for (const slot of Object.keys(savedBundle.perSlotUploads || {})) {
    filteredUploads[slot] = (savedBundle.perSlotUploads[slot] || []).filter(
      (e) => e.status !== "uploading",
    );
  }

  // showBundleStage rebuilds the widgets; pass the filtered uploads so the
  // freshly-built rows hydrate with previously-staged R2 keys.
  showBundleStage(savedPlanResult.storyboard, savedPlanResult.cast || [], filteredUploads);

  // If the bundle was already assembled, restore the result panel + bundle
  // key + open the render stage (without yet activating it).
  if (savedBundle.bundleKey) {
    bundleState.bundleKey = savedBundle.bundleKey;
    showBundleResult({
      ok: true,
      bundleKey: savedBundle.bundleKey,
      sizeBytes: 0, // unknown after reload; UI shows "0 B"; acceptable
      fileCount: 0,
    });
    setBundleStatus("restored from previous session", "loading");
  }
}

function restoreRenderStagePanel(saved) {
  if (!saved.jobId && !saved.bundleKey) return;

  bundleState.bundleKey = saved.bundleKey || bundleState.bundleKey;

  // Restore form fields first so the user sees the chosen tier and any
  // overrides text even if there is no live render to attach to.
  if (saved.qualityTier) $("#planner-quality-tier").value = saved.qualityTier;
  if (typeof saved.renderOverridesText === "string") {
    $("#planner-render-overrides").value = saved.renderOverridesText;
    if (saved.renderOverridesText.trim().length > 0) {
      const details = $(".planner-overrides-details");
      if (details) details.open = true;
    }
  }
  // v0.40.0: restore the keyframes-only checkbox.
  const kfOnlyEl = $("#planner-keyframes-only");
  if (kfOnlyEl) kfOnlyEl.checked = !!saved.keyframesOnly;

  if (!saved.jobId) {
    // Render stage was open but no submit happened. Reveal the stage and
    // let the user click "render" when ready.
    $("#planner-render").hidden = false;
    setRenderStatus("restored from previous session", "loading");
    return;
  }

  // Active render. Reuse resumeRender's wiring by building a synthetic
  // row from the persisted state; the function reattaches the SSE stream
  // when the status is non-terminal.
  resumeRender({
    job_id: saved.jobId,
    project: saved.currentProject || "(restored)",
    label: saved.currentLabel || null,
    bundle_key: saved.bundleKey,
    quality_tier: saved.qualityTier || "final",
    status: saved.lastKnownStatus || "IN_PROGRESS",
    output_key: null,
    output: null,
    error: null,
  });
}

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
      persistSoon();
    });
    // v0.38.0: persist cast field changes so the brief + names + bibles
    // survive a tab close.
    name.addEventListener("input", persistSoon);
    bible.addEventListener("input", persistSoon);

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
    savePersistedState();
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

function showBundleStage(storyboard, characters, initialUploads) {
  planState.storyboard = storyboard;
  planState.cast = characters;
  bundleState.perSlotUploads = initialUploads ? { ...initialUploads } : {};
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
      // v0.38.0: only initialize an empty array when we did not get
      // pre-populated uploads from restoration. Otherwise the existing
      // entries are preserved.
      if (!bundleState.perSlotUploads[slot]) {
        bundleState.perSlotUploads[slot] = [];
      }
      const ch = characters.find((c) => c.slot === slot) || {
        name: "Character " + slot,
        bible: "",
      };
      root.appendChild(buildSlotUploadRow(slot, ch));
      // Hydrate the file list from any pre-existing entries (typically
      // staged-to-R2 keys from before a tab close).
      if (bundleState.perSlotUploads[slot].length > 0) {
        renderSlotList(slot);
      }
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
    // v0.38.0: persist after every status transition so a tab close in the
    // middle of a multi-file upload preserves what already landed on R2.
    savePersistedState();
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
    savePersistedState();
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
  // v0.35.3: parse the renderOverrides textarea before any other state
  // mutation so a malformed JSON does not leave the UI mid-flow. Empty
  // textarea means "no overrides" and is the common path.
  let renderOverrides;
  const overridesText = $("#planner-render-overrides").value.trim();
  if (overridesText) {
    try {
      const parsed = JSON.parse(overridesText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("must be a JSON object, e.g. {\"key\": value}");
      }
      renderOverrides = parsed;
    } catch (err) {
      setRenderStatus("renderOverrides invalid JSON: " + err.message, "error");
      $("#planner-render-overrides").focus();
      return;
    }
  }
  // Stop any prior poll loop before starting a new render.
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }
  const qualityTier = $("#planner-quality-tier").value;
  // v0.40.0: the checkbox is the source of truth for the next submission.
  // The Worker merges this into render_overrides.keyframes_only=true on
  // the wire; the GPU side (vivijure-serverless 0.4.2+) short-circuits
  // the orchestrator after the SDXL pass when it is set.
  const kfOnlyEl = $("#planner-keyframes-only");
  const keyframesOnly = !!(kfOnlyEl && kfOnlyEl.checked);
  setRenderStatus(
    keyframesOnly ? "submitting keyframes-only preview..." : "submitting to RunPod...",
    "loading",
  );
  $("#planner-render-btn").disabled = true;

  const reqBody = {
    bundleKey: bundleState.bundleKey,
    qualityTier,
  };
  if (renderOverrides) reqBody.renderOverrides = renderOverrides;
  if (keyframesOnly) reqBody.keyframesOnly = true;

  let resp = null;
  let data = null;
  try {
    resp = await fetch("/api/storyboard/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
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
  renderState.streamFallbackHit = false;
  // v0.37.0: track display name for notifications. Use the bundle's
  // derived project slug here; resumeRender will overwrite with the
  // history row's label when available.
  renderState.currentProject = deriveProjectFromKey(bundleState.bundleKey || "");
  renderState.currentLabel = null;
  // v0.37.0: ask for notification permission on the first submit when
  // we have not asked before. Done here (not on page load) so the
  // prompt arrives at the moment the value is most obvious: right
  // before a 10-to-30 minute wait.
  if (notifyState.permission === "default") {
    requestNotificationPermission();
  }
  $("#planner-render-result").hidden = false;
  $("#planner-render-job-id").textContent = data.jobId;
  setJobStatusBadge(data.status || "IN_QUEUE");
  setRenderStatus("submitted; opening stream...", "loading");
  startStream();
  // Refresh the history list so the new render appears at the top
  // without the user needing to click "refresh" manually.
  loadHistory();
  // v0.38.0: persist the new jobId so a tab close resumes the stream
  // on the next reload.
  savePersistedState();
}

// v0.35.0: open a server-sent event connection to the worker so render
// status updates arrive as RunPod produces them, instead of on a fixed
// 8-second client poll. The worker proxies RunPod at a 3-second cadence
// and emits each snapshot as an SSE event with the same JSON shape the
// one-shot poll endpoint returns; updateRenderProgress / finalizeRender
// stay unchanged. On any stream error (auth, transient network, or the
// worker's duration cap), fall back to pollRender() so an in-flight job
// is never silently abandoned.
function startStream() {
  if (!renderState.jobId) return;

  // Clean up any prior stream / poll first so we never have two listeners
  // racing on the same panel.
  if (renderState.eventSource) {
    try { renderState.eventSource.close(); } catch {}
    renderState.eventSource = null;
  }
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }

  // EventSource carries the Cloudflare Access cookie automatically (same
  // origin + same auth gate as every other /api/storyboard/* request).
  const url = "/api/storyboard/render/" + encodeURIComponent(renderState.jobId) + "/stream";
  let es;
  try {
    es = new EventSource(url);
  } catch (err) {
    setRenderStatus("could not open stream: " + err.message + "; falling back to polling", "loading");
    pollRender();
    return;
  }
  renderState.eventSource = es;

  es.onmessage = (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      // Skip malformed event; the next one will catch up.
      return;
    }

    if (data && data.ok === false) {
      const errs = (data.errors || ["unknown stream error"]).join("; ");
      setRenderStatus("stream error: " + errs, "error");
      closeStream();
      pollRender();
      return;
    }

    // Sentinel events the worker emits at stream open and duration cap.
    if (data.status === "STREAM_OPENED") {
      setRenderStatus("stream open; awaiting first status update", "loading");
      return;
    }
    if (data.status === "STREAM_DURATION_CAP") {
      // The worker capped this stream's life. Re-open transparently so the
      // user does not see a status interruption.
      closeStream();
      setRenderStatus("stream rotation (duration cap); reconnecting", "loading");
      startStream();
      return;
    }

    updateRenderProgress(data);

    const terminal = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"];
    if (terminal.indexOf(data.status) >= 0) {
      finalizeRender(data);
      maybeNotifyTerminal(data);
      closeStream();
      $("#planner-render-btn").disabled = false;
      // Refresh history so the row's terminal state appears in the list.
      loadHistory();
    }
  };

  es.addEventListener("error", (ev) => {
    // EventSource fires "error" for both transient blips (which it then
    // reconnects from on its own) and permanent close. We can distinguish
    // by readyState: CLOSED means the browser will not retry.
    const closed = es.readyState === EventSource.CLOSED;
    if (closed && !renderState.streamFallbackHit) {
      renderState.streamFallbackHit = true;
      setRenderStatus("stream closed; falling back to 8s polling", "loading");
      closeStream();
      pollRender();
    }
    // Transient errors are silent; EventSource handles the reconnect.
  });
}

function closeStream() {
  if (renderState.eventSource) {
    try { renderState.eventSource.close(); } catch {}
    renderState.eventSource = null;
  }
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
    maybeNotifyTerminal(data);
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
  // Optimistic UX: disable the button and pause the live updates while
  // the cancel call is in flight. Failure restores the button (still
  // cancellable); success lets the next stream / poll event pick up the
  // CANCELLED state.
  const cancelBtn = $("#planner-render-cancel");
  cancelBtn.disabled = true;
  setRenderStatus("requesting cancel...", "loading");
  closeStream();
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
    // Resume the live stream so the user keeps seeing real-time updates.
    startStream();
    return;
  }

  // RunPod accepted the cancel; the next stream event will see CANCELLED.
  setRenderStatus("cancel requested; awaiting final status", "loading");
  if (data && data.status) setJobStatusBadge(data.status);
  startStream();
}

function resetRenderStage() {
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }
  closeStream();
  renderState.jobId = null;
  renderState.streamFallbackHit = false;
  $("#planner-render").hidden = true;
  $("#planner-render-result").hidden = true;
  // v0.35.3: clear the renderOverrides textarea on re-plan so a stale
  // value from a prior re-render does not silently carry forward into
  // the next submit.
  const overridesTextarea = $("#planner-render-overrides");
  if (overridesTextarea) overridesTextarea.value = "";
  const overridesDetails = $(".planner-overrides-details");
  if (overridesDetails) overridesDetails.open = false;
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

// v0.35.2: dedupes concurrent loadHistory calls (refresh button + auto-
// refresh tick + post-submit refresh can all overlap). Cleared in the
// finally block whether the fetch succeeded or threw.
let isLoadingHistory = false;
// v0.35.2: setTimeout handle for the auto-refresh loop. Lives only while
// at least one history row is in a non-terminal status; set in
// maybeScheduleHistoryRefresh, cleared at the start of each loadHistory
// and on tab visibility -> hidden.
let historyRefreshTimer = null;
// v0.37.1: client-side filter state over historyState.rows. text matches
// project + label substring; status flags gate the three buckets. Default
// is "everything visible" so a returning user sees all their renders.
const historyState = {
  rows: [],
  filters: {
    text: "",
    showInFlight: true,
    showDone: true,
    showFailed: true,
  },
  // v0.38.1: per-session set of row ids the user has clicked to expand.
  // Default-collapsed lets the list stay scannable once history grows;
  // clicks toggle individual rows open without leaving the page.
  expandedIds: new Set(),
  // v0.41.0: in-flight regen-shot jobs. Keyed by `<rowId>:<shotId>`.
  // Value: { jobId, kfKey, shotId, rowId, startedAt }. Used to:
  //   1. Re-disable the regen button + show the loading label when
  //      buildHistoryRow re-runs on auto-refresh.
  //   2. Drive the polling loop independently of DOM lifecycle, so a
  //      row re-render mid-poll does not cancel the poll.
  // The polling tick locates the current DOM nodes via querySelector
  // each time, so stale refs from before a re-render are not held.
  regenJobs: new Map(),
};

async function loadHistory() {
  if (isLoadingHistory) return;
  if (historyRefreshTimer) {
    clearTimeout(historyRefreshTimer);
    historyRefreshTimer = null;
  }
  isLoadingHistory = true;
  try {
    const resp = await fetch("/api/storyboard/renders?limit=" + HISTORY_LIMIT);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    historyState.rows = data.renders || [];
    applyHistoryFilters();
    maybeScheduleHistoryRefresh(historyState.rows);
  } catch (err) {
    // Silent: a history load failure should not block the planning flow.
    // The user can still plan, bundle, render normally; only the history
    // surface is missing. Do not auto-reschedule on error; the user can
    // click refresh or wait for the next intentional trigger.
    console.error("history load failed:", err);
  } finally {
    isLoadingHistory = false;
  }
}

// v0.37.1: re-render the list using the current filter state without
// re-fetching. Called from loadHistory on success AND from the filter
// input listeners. No fetch fires when the user types or toggles a
// checkbox; the row data is already in memory.
function applyHistoryFilters() {
  const filtered = filterRows(historyState.rows, historyState.filters);
  renderHistoryList(filtered, historyState.rows.length);
}

// Pure filter over rows + filter state. Status buckets:
//   IN_QUEUE | IN_PROGRESS  -> in-flight
//   COMPLETED               -> done
//   FAILED | CANCELLED | TIMED_OUT  -> failed
// Text matches project name OR label, case-insensitive substring.
function filterRows(rows, filters) {
  const text = (filters.text || "").toLowerCase().trim();
  return rows.filter((r) => {
    if (r.status === "IN_QUEUE" || r.status === "IN_PROGRESS") {
      if (!filters.showInFlight) return false;
    } else if (r.status === "COMPLETED") {
      if (!filters.showDone) return false;
    } else if (
      r.status === "FAILED"
      || r.status === "CANCELLED"
      || r.status === "TIMED_OUT"
    ) {
      if (!filters.showFailed) return false;
    }
    if (text) {
      const project = (r.project || "").toLowerCase();
      const label = (r.label || "").toLowerCase();
      if (!project.includes(text) && !label.includes(text)) return false;
    }
    return true;
  });
}

// v0.35.2: schedule the next refresh whenever the rendered list still
// contains an in-flight row. Goes idle (no timer scheduled) when every
// row has reached a terminal status, so a page left open after a long
// render does not keep hitting the DB. Re-armed on every loadHistory
// success (called from inside renderHistoryList).
function maybeScheduleHistoryRefresh(rows) {
  if (historyRefreshTimer) {
    clearTimeout(historyRefreshTimer);
    historyRefreshTimer = null;
  }
  if (document.hidden) return; // page in background; do not schedule
  if (!Array.isArray(rows) || rows.length === 0) return;
  const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"];
  const hasInFlight = rows.some((r) => TERMINAL.indexOf(r.status) < 0);
  if (!hasInFlight) return;
  historyRefreshTimer = setTimeout(loadHistory, HISTORY_AUTO_REFRESH_MS);
}

// v0.37.1: signature now takes the filtered subset AND the total count
// so the counter can read "showing 3 of 12" vs "12 renders" without
// recomputing. totalRows defaults to rows.length for callers that don't
// filter (kept for compatibility, but in v0.37.1+ the only caller is
// applyHistoryFilters which always provides both).
function renderHistoryList(rows, totalRows) {
  const section = $("#planner-history");
  const list = $("#planner-history-list");
  const counter = $("#planner-history-counter");
  list.innerHTML = "";

  if (totalRows === undefined) totalRows = rows ? rows.length : 0;

  // Section hidden only when the user has zero renders period. Filtered-
  // to-zero still shows the section + filters + "no matches" placeholder
  // so the user can clear filters.
  if (totalRows === 0) {
    section.hidden = true;
    counter.textContent = "";
    return;
  }
  section.hidden = false;

  if (!rows || rows.length === 0) {
    counter.textContent = "showing 0 of " + totalRows;
    const li = document.createElement("li");
    li.className = "planner-history-empty";
    li.textContent = "no renders match the current filters";
    list.appendChild(li);
    return;
  }

  counter.textContent =
    rows.length === totalRows
      ? totalRows + " render" + (totalRows === 1 ? "" : "s")
      : "showing " + rows.length + " of " + totalRows;

  for (const r of rows) {
    list.appendChild(buildHistoryRow(r));
  }
}

function buildHistoryRow(r) {
  const li = document.createElement("li");
  li.className = "planner-history-item";
  li.dataset.jobId = r.job_id;
  li.dataset.id = String(r.id);

  // v0.38.1: collapse / expand state. All rows start collapsed for a
  // scannable list; clicking the meta bar toggles expand. Expanded ids
  // live in historyState.expandedIds (per-session; not persisted).
  const isExpanded = historyState.expandedIds.has(r.id);
  if (!isExpanded) li.classList.add("planner-history-item-collapsed");

  const meta = document.createElement("div");
  meta.className = "planner-history-meta";
  meta.tabIndex = 0;
  meta.setAttribute("role", "button");
  meta.setAttribute(
    "aria-expanded",
    isExpanded ? "true" : "false",
  );

  // Disclosure chevron: right when collapsed, down when expanded.
  const chevron = document.createElement("span");
  chevron.className = "planner-history-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = isExpanded ? "▼" : "▶";
  meta.appendChild(chevron);

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

  // v0.40.0: keyframes-only badge. Marks rows that ran the SDXL preview
  // pass with no Wan I2V or silent-MP4 assembly. The badge sits right
  // after the status so it is visible in both collapsed and expanded
  // views. row.mode is collapsed to 'full' for legacy rows in
  // renders-db.ts so the equality check is safe without a NULL guard.
  if (r.mode === "keyframes-only") {
    const modeBadge = document.createElement("span");
    modeBadge.className = "planner-history-mode planner-history-mode-keyframes-only";
    modeBadge.textContent = "kf only";
    modeBadge.title = "this render produced SDXL keyframes only; no motion / no silent MP4";
    meta.appendChild(modeBadge);
  }

  // v0.38.1: inline label preview, shown only while the row is collapsed
  // (CSS gates this). Read-only here; the editable input below takes over
  // when the user expands the row.
  if (r.label) {
    const labelPreview = document.createElement("span");
    labelPreview.className = "planner-history-label-preview";
    labelPreview.textContent = '"' + r.label + '"';
    meta.appendChild(labelPreview);
  }

  // Click the meta bar to toggle expand. Action buttons sit outside meta
  // so their clicks never bubble here, and the editable label input lives
  // below the meta bar so clicks there do not collapse the row.
  const toggle = () => toggleHistoryRowExpand(r.id, li);
  meta.addEventListener("click", toggle);
  meta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      toggle();
    }
  });

  li.appendChild(meta);

  // v0.36.0: inline-editable label. Empty -> placeholder "+ label". Save
  // on blur or Enter; Escape reverts. Failures alert and restore.
  li.appendChild(buildHistoryLabelInput(r));

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

  // v0.35.1: "re-render" with the same bundle. Skips plan + bundle stages.
  const rerun = document.createElement("button");
  rerun.type = "button";
  rerun.className = "planner-history-action";
  rerun.textContent = "re-render";
  rerun.title = "render this bundle again (skips plan + bundle stages)";
  rerun.addEventListener("click", () => rerunBundle(r));
  actions.appendChild(rerun);

  // v0.35.4: delete the row from history (and the silent MP4 from R2 when
  // no other row references it). Confirmation prompt before any destructive
  // request leaves the page.
  const del = document.createElement("button");
  del.type = "button";
  del.className = "planner-history-action planner-history-action-delete";
  del.textContent = "delete";
  del.title = "remove this row from history and (if not shared) the silent MP4 from R2";
  del.addEventListener("click", () => deleteHistoryRow(r));
  actions.appendChild(del);

  li.appendChild(actions);

  // v0.39.0: SDXL keyframe thumbnails. Hidden when the row is collapsed
  // (CSS gates .planner-history-keyframes the same way it gates sub /
  // actions). Each thumb is an <img loading="lazy"> served by the
  // existing /api/artifact ownership-checked route; the GPU side stamps
  // each keyframe upload with the submitter's user_email so the route
  // authorizes the user back to their own thumbs.
  // v0.41.0: each thumbnail also gets a `regen` button that submits a
  // single-shot SDXL regeneration to the GPU. The button is gated on
  // (a) the originating row being COMPLETED (no point regening an in-
  // flight render's keyframes) and (b) the row having a bundle_key
  // (preserved on every row at submit time). Re-render survival is
  // handled by reading historyState.regenJobs in buildHistoryRow: an
  // already-in-flight regen leaves the button disabled + labeled
  // "regen..." after the row re-builds on the 30s auto-refresh.
  if (Array.isArray(r.keyframes) && r.keyframes.length > 0) {
    const strip = document.createElement("div");
    strip.className = "planner-history-keyframes";
    const regenEligible = r.status === "COMPLETED" && r.bundle_key;
    for (const kf of r.keyframes) {
      if (!kf || typeof kf.key !== "string" || typeof kf.shot_id !== "string") continue;
      const wrap = document.createElement("div");
      wrap.className = "planner-history-keyframe-wrap";
      const a = document.createElement("a");
      a.href = "/api/artifact/" + kf.key;
      a.target = "_blank";
      a.rel = "noopener";
      a.className = "planner-history-keyframe";
      a.title = kf.shot_id;
      const img = document.createElement("img");
      img.src = "/api/artifact/" + kf.key;
      img.alt = kf.shot_id;
      img.loading = "lazy";
      img.dataset.shotId = kf.shot_id;
      img.className = "planner-history-keyframe-img";
      a.appendChild(img);
      const cap = document.createElement("span");
      cap.className = "planner-history-keyframe-cap";
      cap.textContent = kf.shot_id;
      a.appendChild(cap);
      wrap.appendChild(a);

      if (regenEligible) {
        const regenKey = String(r.id) + ":" + kf.shot_id;
        const active = historyState.regenJobs.get(regenKey);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "planner-history-keyframe-regen";
        btn.dataset.shotId = kf.shot_id;
        btn.title = "regenerate this keyframe (SDXL only; about 30-60s)";
        if (active) {
          btn.disabled = true;
          btn.textContent = "regen...";
        } else {
          btn.textContent = "regen";
        }
        btn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          regenShot(r, kf, btn, img);
        });
        wrap.appendChild(btn);

        // v0.42.0: lock pin. Toggles whether this shot is in r.locked_shots
        // (the user's "approved" set). Click PATCHes the row; the new
        // set is reflected immediately in the row's local data + the UI.
        // Locked shots are surfaced to the user as a count next to the
        // finalize button; v0.42.0 does NOT gate finalize on lock state
        // (the GPU runs I2V over every shot regardless).
        const lockedSet = new Set(Array.isArray(r.locked_shots) ? r.locked_shots : []);
        const lockBtn = document.createElement("button");
        lockBtn.type = "button";
        lockBtn.className = "planner-history-keyframe-lock";
        lockBtn.dataset.shotId = kf.shot_id;
        const isLocked = lockedSet.has(kf.shot_id);
        if (isLocked) lockBtn.classList.add("planner-history-keyframe-lock-on");
        lockBtn.textContent = isLocked ? "locked" : "lock";
        lockBtn.title = isLocked
          ? "click to remove this shot from the approved set"
          : "mark this shot as approved (informational; does not gate finalize)";
        lockBtn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          toggleShotLock(r, kf.shot_id, lockBtn);
        });
        wrap.appendChild(lockBtn);
      }

      strip.appendChild(wrap);
    }
    if (strip.children.length > 0) li.appendChild(strip);
  }

  // v0.42.1: inline video player for completed rows that produced a
  // silent MP4. Sits between the keyframe strip (the per-shot stills)
  // and the finalize row, so the visual order is meta -> stills ->
  // motion. preload="metadata" so opening a row does NOT auto-pull
  // the whole MP4; the network fetch starts when the user clicks
  // play. The element is gated by the existing -collapsed class so
  // a collapsed row stays one line.
  if (r.status === "COMPLETED" && r.output_key) {
    const playerWrap = document.createElement("div");
    playerWrap.className = "planner-history-player";
    const video = document.createElement("video");
    video.src = "/api/artifact/" + r.output_key;
    video.controls = true;
    video.preload = "metadata";
    video.playsInline = true;
    video.className = "planner-history-player-video";
    playerWrap.appendChild(video);
    li.appendChild(playerWrap);
  }

  // v0.42.0: finalize button. Shown only on completed keyframes-only
  // previews. Submits a finalize render (Wan I2V + assemble) using the
  // same bundle the preview used; the result lands as a NEW history
  // row, the preview row stays.
  if (
    r.mode === "keyframes-only"
    && r.status === "COMPLETED"
    && r.bundle_key
    && Array.isArray(r.keyframes)
    && r.keyframes.length > 0
  ) {
    const finalizeRow = document.createElement("div");
    finalizeRow.className = "planner-history-finalize-row";
    const lockedCount = Array.isArray(r.locked_shots) ? r.locked_shots.length : 0;
    const summary = document.createElement("span");
    summary.className = "planner-history-finalize-summary";
    summary.textContent = lockedCount > 0
      ? lockedCount + " of " + r.keyframes.length + " shots locked"
      : r.keyframes.length + " keyframes ready; lock the shots you want to keep, then finalize";
    finalizeRow.appendChild(summary);
    const finalizeBtn = document.createElement("button");
    finalizeBtn.type = "button";
    finalizeBtn.className = "planner-history-finalize-btn";
    finalizeBtn.textContent = "finalize (Wan I2V + assemble)";
    finalizeBtn.title = "run Wan I2V on every keyframe + assemble silent MP4 (about 20 to 30 minutes)";
    finalizeBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      finalizeRender(r, finalizeBtn);
    });
    finalizeRow.appendChild(finalizeBtn);
    li.appendChild(finalizeRow);
  }

  return li;
}

// v0.41.0: submit a single-shot SDXL regen + start polling. The button
// and img refs are passed in for the immediate UI flip (disabled +
// "submitting..."); subsequent polls re-query the DOM each tick so
// they survive a parent row re-render on the 30s auto-refresh.
async function regenShot(row, kf, btnEl, imgEl) {
  const confirmMsg =
    "regen keyframe for " + kf.shot_id + "?\n\n"
    + "this runs SDXL only (no motion, no assembly) and overwrites the "
    + "thumbnail above. takes about 30 to 60 seconds.";
  if (!window.confirm(confirmMsg)) return;

  const regenKey = String(row.id) + ":" + kf.shot_id;
  btnEl.disabled = true;
  btnEl.textContent = "submitting...";

  let resp = null;
  let data = null;
  try {
    resp = await fetch(
      "/api/storyboard/renders/" + encodeURIComponent(row.id) + "/regen-shot",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shotId: kf.shot_id }),
      },
    );
    data = await resp.json();
  } catch (err) {
    btnEl.disabled = false;
    btnEl.textContent = "regen";
    window.alert("regen submit failed: " + err.message);
    return;
  }
  if (!resp.ok || !data || !data.ok) {
    btnEl.disabled = false;
    btnEl.textContent = "regen";
    const msg = (data && (data.error
      || (Array.isArray(data.errors) && data.errors.join(", "))))
      || ("HTTP " + (resp ? resp.status : "?"));
    window.alert("regen submit failed: " + msg);
    return;
  }

  // Submitted. Park the state in regenJobs and start polling.
  btnEl.textContent = "regen...";
  imgEl.classList.add("planner-history-keyframe-img-regen-pending");
  historyState.regenJobs.set(regenKey, {
    jobId: data.jobId,
    kfKey: kf.key,
    shotId: kf.shot_id,
    rowId: row.id,
    startedAt: Date.now(),
  });
  // v0.41.1: snapshot the new entry to localStorage immediately so a
  // page refresh between here and the poll's terminal tick resumes
  // polling instead of stranding the regen.
  savePersistedState();
  pollRegenJob(regenKey);
}

// v0.41.0: poll one regen job. Re-queries the DOM each tick so a row
// re-render on auto-refresh does not strand us with detached refs.
// Reuses the existing /api/storyboard/render/<jobId> route (no new
// poll endpoint; the GPU job is just another RunPod job from the
// platform's perspective).
function pollRegenJob(regenKey) {
  const state = historyState.regenJobs.get(regenKey);
  if (!state) return;
  fetch("/api/storyboard/render/" + encodeURIComponent(state.jobId))
    .then((r) => r.json())
    .then((data) => {
      const status = (data && data.status) || "IN_QUEUE";
      const terminal = (
        status === "COMPLETED"
          || status === "FAILED"
          || status === "CANCELLED"
          || status === "TIMED_OUT"
      );
      if (!terminal) {
        setTimeout(() => pollRegenJob(regenKey), 4000);
        return;
      }
      // Locate the current DOM nodes for this row + shot. The row may
      // have been re-rendered since the regen was submitted (auto-
      // refresh on a 30s timer), so the original refs would be stale.
      const li = document.querySelector(
        '.planner-history-item[data-id="' + state.rowId + '"]',
      );
      const img = li && li.querySelector(
        '.planner-history-keyframe-img[data-shot-id="' + cssEscape(state.shotId) + '"]',
      );
      const btn = li && li.querySelector(
        '.planner-history-keyframe-regen[data-shot-id="' + cssEscape(state.shotId) + '"]',
      );
      historyState.regenJobs.delete(regenKey);
      // v0.41.1: clear the stashed entry on terminal status so a
      // subsequent reload does not try to re-poll a finished job.
      savePersistedState();
      if (status === "COMPLETED") {
        if (img) {
          img.src = "/api/artifact/" + state.kfKey + "?v=" + Date.now();
          img.classList.remove("planner-history-keyframe-img-regen-pending");
        }
        if (btn) {
          btn.disabled = false;
          btn.textContent = "regen";
        }
        return;
      }
      // Terminal but not COMPLETED.
      if (img) img.classList.remove("planner-history-keyframe-img-regen-pending");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "regen";
      }
      window.alert(
        "regen " + status.toLowerCase() + " for " + state.shotId + ": "
          + ((data && data.error) || "(no error message)"),
      );
    })
    .catch((err) => {
      console.warn("regen poll failed:", err);
      setTimeout(() => pollRegenJob(regenKey), 4000);
    });
}

// v0.42.0: toggle a single shot's lock state on a row. Optimistic:
// mutates row.locked_shots locally so the next buildHistoryRow shows
// the new state before the PATCH round-trip lands; on PATCH failure
// the toggle is reverted + the button reset. The row's data lives in
// historyState.rows so subsequent renders see the mutation.
async function toggleShotLock(row, shotId, btnEl) {
  const current = new Set(Array.isArray(row.locked_shots) ? row.locked_shots : []);
  const willLock = !current.has(shotId);
  if (willLock) current.add(shotId);
  else current.delete(shotId);
  const next = Array.from(current);
  // Optimistic UI flip first.
  row.locked_shots = next;
  if (willLock) {
    btnEl.classList.add("planner-history-keyframe-lock-on");
    btnEl.textContent = "locked";
  } else {
    btnEl.classList.remove("planner-history-keyframe-lock-on");
    btnEl.textContent = "lock";
  }
  btnEl.disabled = true;
  // PATCH the renders row with the new locked_shots set.
  let resp = null;
  let data = null;
  try {
    resp = await fetch(
      "/api/storyboard/renders/" + encodeURIComponent(row.id),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lockedShots: next }),
      },
    );
    data = await resp.json();
  } catch (err) {
    // Revert.
    if (willLock) current.delete(shotId);
    else current.add(shotId);
    row.locked_shots = Array.from(current);
    btnEl.classList.toggle("planner-history-keyframe-lock-on", current.has(shotId));
    btnEl.textContent = current.has(shotId) ? "locked" : "lock";
    btnEl.disabled = false;
    window.alert("lock toggle failed: " + err.message);
    return;
  }
  if (!resp.ok || !data || !data.ok) {
    if (willLock) current.delete(shotId);
    else current.add(shotId);
    row.locked_shots = Array.from(current);
    btnEl.classList.toggle("planner-history-keyframe-lock-on", current.has(shotId));
    btnEl.textContent = current.has(shotId) ? "locked" : "lock";
    btnEl.disabled = false;
    const msg = (data && (data.error
      || (Array.isArray(data.errors) && data.errors.join(", "))))
      || ("HTTP " + (resp ? resp.status : "?"));
    window.alert("lock toggle failed: " + msg);
    return;
  }
  // Authoritative locked_shots back from the Worker; mirror onto the
  // local row data so subsequent UI logic uses the canonical value.
  if (Array.isArray(data.lockedShots)) {
    row.locked_shots = data.lockedShots;
  }
  btnEl.disabled = false;
  // Refresh the parent row's finalize-row summary if present so the
  // "N of M shots locked" text reflects the new count without waiting
  // for the next auto-refresh.
  const li = btnEl.closest(".planner-history-item");
  if (li) {
    const summary = li.querySelector(".planner-history-finalize-summary");
    if (summary && Array.isArray(row.keyframes)) {
      const lockedCount = Array.isArray(row.locked_shots) ? row.locked_shots.length : 0;
      summary.textContent = lockedCount > 0
        ? lockedCount + " of " + row.keyframes.length + " shots locked"
        : row.keyframes.length + " keyframes ready; lock the shots you want to keep, then finalize";
    }
  }
}

// v0.42.0: submit a finalize render from a completed keyframes-only
// preview. Asks for confirmation since the operation is long (20 to
// 30 min on final tier), then POSTs to the renders/{id}/finalize
// route. On success a fresh history row is reloaded so the user sees
// the in-flight finalize next to the preview it came from.
async function finalizeRender(row, btnEl) {
  const lockedCount = Array.isArray(row.locked_shots) ? row.locked_shots.length : 0;
  const kfCount = Array.isArray(row.keyframes) ? row.keyframes.length : 0;
  const confirmMsg =
    "finalize this preview?\n\n"
    + "this runs Wan I2V over " + kfCount + " keyframe"
    + (kfCount === 1 ? "" : "s")
    + " and assembles the silent MP4. "
    + "approx 20 to 30 minutes on the final tier.\n\n"
    + (lockedCount > 0
      ? "you have " + lockedCount + " locked shots; v0.42.0 still runs I2V "
        + "on every shot regardless of lock state."
      : "no shots are locked; v0.42.0 does not gate finalize on lock state.");
  if (!window.confirm(confirmMsg)) return;

  btnEl.disabled = true;
  btnEl.textContent = "submitting...";

  let resp = null;
  let data = null;
  try {
    resp = await fetch(
      "/api/storyboard/renders/" + encodeURIComponent(row.id) + "/finalize",
      { method: "POST" },
    );
    data = await resp.json();
  } catch (err) {
    btnEl.disabled = false;
    btnEl.textContent = "finalize (Wan I2V + assemble)";
    window.alert("finalize submit failed: " + err.message);
    return;
  }
  if (!resp.ok || !data || !data.ok) {
    btnEl.disabled = false;
    btnEl.textContent = "finalize (Wan I2V + assemble)";
    const msg = (data && (data.error
      || (Array.isArray(data.errors) && data.errors.join(", "))))
      || ("HTTP " + (resp ? resp.status : "?"));
    window.alert("finalize submit failed: " + msg);
    return;
  }
  btnEl.textContent = "finalize submitted";
  // Reload the history list so the new in-flight row appears alongside
  // the preview it came from. loadHistory hydrates rows from the
  // server; the auto-refresh handles further polling.
  loadHistory();
}

// Minimal CSS.escape polyfill. Modern browsers ship it but planner.js
// is loaded by older devices too; this covers the safe subset we need
// for shot ids ("shot_01", "shot_02", ...). For anything outside that
// shape we fall back to the input string, which is fine because the
// shot ids are validated on the GPU side and never contain CSS-meta.
function cssEscape(s) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

// v0.35.4: prompt + delete one history row. The artifact-cleanup query
// flag is sent only when the row has an output_key (no point asking the
// worker to clean nothing). Refreshes the list on success so the row
// disappears immediately.
async function deleteHistoryRow(row) {
  const hasArtifact = !!row.output_key;
  const prompt = hasArtifact
    ? "delete this render from history (and the silent MP4 in R2 if no other row references it)?"
    : "delete this render from history?";
  if (!window.confirm(prompt)) return;

  const url =
    "/api/storyboard/renders/" + encodeURIComponent(row.id)
    + (hasArtifact ? "?artifact=true" : "");
  let resp = null;
  let data = null;
  try {
    resp = await fetch(url, { method: "DELETE" });
    data = await resp.json();
  } catch (err) {
    window.alert("delete failed: " + err.message);
    return;
  }

  if (!resp.ok || !data || data.ok !== true) {
    const errMsg = (data && data.error) || ("HTTP " + resp.status);
    window.alert("delete failed: " + errMsg);
    return;
  }

  if (hasArtifact && data.artifactSkippedReason) {
    // Soft notice: the row is gone but the artifact stayed. Surface so
    // the user is not surprised that the file is still on R2.
    console.info("artifact preserved:", data.artifactSkippedReason);
  }

  // Refresh so the row drops out of the list immediately and the
  // auto-refresh loop re-arms from the new state.
  loadHistory();
}

// v0.35.1: load a bundle key (from a history row or a paste prompt) into
// the render stage and reveal it. The user then picks a quality tier and
// clicks "render"; the existing submitRender flow takes it from there.
// Closes any active stream / poll on a different jobId so the panel does
// not show stale progress from the previous render.
function rerunBundle(row) {
  closeStream();
  if (renderState.pollTimer) {
    clearTimeout(renderState.pollTimer);
    renderState.pollTimer = null;
  }
  renderState.jobId = null;
  renderState.streamFallbackHit = false;
  // v0.37.0: carry the row's label / project forward so the post-submit
  // notification (when the new render lands) reads "cherry-final-take1"
  // rather than the slug. Will be overwritten on the next submit.
  renderState.currentProject = row.project || null;
  renderState.currentLabel = row.label || null;
  bundleState.bundleKey = row.bundle_key;

  const renderSection = $("#planner-render");
  renderSection.hidden = false;
  $("#planner-render-result").hidden = true;
  $("#planner-render-error").hidden = true;
  $("#planner-render-log-wrap").hidden = true;
  $("#planner-render-output").hidden = true;

  // Pre-select the same quality tier the original render used so a single
  // click matches the previous run; the user can still flip it before
  // hitting render.
  const tierSelect = $("#planner-quality-tier");
  if (tierSelect && row.quality_tier) {
    tierSelect.value = row.quality_tier;
  }

  // v0.35.3: pre-fill the renderOverrides textarea from the row so a
  // re-render reproduces the previous run end to end. If overrides were
  // present, open the <details> wrapper so the user sees we are carrying
  // them forward (else they would think "no overrides" by default).
  const overridesTextarea = $("#planner-render-overrides");
  const overridesDetails = $(".planner-overrides-details");
  if (overridesTextarea) {
    if (
      row.render_overrides
      && typeof row.render_overrides === "object"
      && !Array.isArray(row.render_overrides)
      && Object.keys(row.render_overrides).length > 0
    ) {
      overridesTextarea.value = JSON.stringify(row.render_overrides, null, 2);
      if (overridesDetails) overridesDetails.open = true;
    } else {
      overridesTextarea.value = "";
      if (overridesDetails) overridesDetails.open = false;
    }
  }

  setRenderStatus(
    "loaded bundle " + row.bundle_key
      + " (project " + (row.project || "?") + "); pick a quality tier and click render",
    "loading",
  );
  renderSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

// v0.35.1: paste an R2 bundle key directly to render a bundle that does
// not appear in the history (e.g. one staged by curl or one from before
// the v0.34.0 history migration). Reuses rerunBundle with a synthetic
// row whose project + tier come from a slug-derive on the key.
function promptCustomBundle() {
  const key = window.prompt(
    "paste an R2 bundle key (e.g. bundles/cherry.tar.gz) to render it without re-bundling:",
    "bundles/",
  );
  if (!key || !key.trim()) return;
  const trimmed = key.trim();
  rerunBundle({
    job_id: "(custom)",
    project: deriveProjectFromKey(trimmed),
    bundle_key: trimmed,
    quality_tier: "final",
    status: "PENDING",
  });
}

function deriveProjectFromKey(bundleKey) {
  const m = bundleKey.match(/^bundles\/(.+)\.tar\.gz$/);
  if (m) return m[1];
  return bundleKey;
}

// v0.36.0: free-form text input that doubles as the row's label display.
// Reads as italic + dimmed when empty (shows "+ label" placeholder);
// gains a border + normal weight on focus to signal "edit mode". On blur
// or Enter, if the value changed, PATCH the row and update local state.
// On Escape, revert without firing the network call.
function buildHistoryLabelInput(row) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "planner-history-label-input";
  input.value = row.label || "";
  input.placeholder = "+ label";
  input.maxLength = 200;
  input.spellcheck = false;
  input.title = "click to label this render (max 200 chars)";

  // Track the last server-acknowledged value so we never PATCH on a
  // blur that did not actually change anything.
  let lastSaved = row.label || "";

  const save = async () => {
    const next = input.value.trim();
    if (next === lastSaved) return;
    try {
      const resp = await fetch(
        "/api/storyboard/renders/" + encodeURIComponent(row.id),
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: next || null }),
        },
      );
      if (!resp.ok) {
        let msg = "HTTP " + resp.status;
        try {
          const data = await resp.json();
          if (data && data.error) msg = data.error;
        } catch {
          // non-JSON body; keep the HTTP code
        }
        throw new Error(msg);
      }
      const data = await resp.json();
      lastSaved = data.label || "";
      input.value = lastSaved;
      row.label = lastSaved || null;
    } catch (err) {
      console.error("label save failed:", err);
      window.alert("label save failed: " + err.message);
      input.value = lastSaved;
    }
  };

  input.addEventListener("blur", save);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      input.blur();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      input.value = lastSaved;
      input.blur();
    }
  });

  return input;
}

// v0.38.1: flip the collapsed / expanded state of one history row. Updates
// the chevron, the aria-expanded attribute, and the CSS class that hides
// the label input + sub line + actions row when collapsed. State lives in
// historyState.expandedIds; cleared on reload (intentional, since collapsed
// default after refresh keeps the list scannable for the next session).
function toggleHistoryRowExpand(id, liEl) {
  const expanded = historyState.expandedIds.has(id);
  const next = !expanded;
  if (next) {
    historyState.expandedIds.add(id);
    liEl.classList.remove("planner-history-item-collapsed");
  } else {
    historyState.expandedIds.delete(id);
    liEl.classList.add("planner-history-item-collapsed");
  }
  const meta = liEl.querySelector(".planner-history-meta");
  if (meta) meta.setAttribute("aria-expanded", next ? "true" : "false");
  const chevron = liEl.querySelector(".planner-history-chevron");
  if (chevron) chevron.textContent = next ? "▼" : "▶";
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
  // v0.37.0: surface label / project for the notification when this
  // resumed render reaches a terminal status (catches users who walk
  // away after clicking "view" on an in-flight history row).
  renderState.currentProject = row.project || null;
  renderState.currentLabel = row.label || null;
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
    setRenderStatus("resumed; opening stream...", "loading");
    renderState.streamFallbackHit = false;
    startStream();
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

// ---------- Browser notifications (v0.37.0) ----------
//
// Fires an OS-level notification when a render hits a terminal status, so
// the user can walk away from a 10-to-30 minute Wan render and let the
// browser ping them when it lands. Asked-for once at first-submit time
// (delaying the permission prompt until the value is obvious; nothing
// asks on page load); afterwards the per-job dedupe in
// `notifyState.alreadyNotified` keeps a stream-retry from double-firing.
// Silently no-ops on unsupported browsers and on denied permission.

function initNotifications() {
  if (typeof Notification === "undefined") {
    notifyState.permission = "unsupported";
    return;
  }
  notifyState.permission = Notification.permission;
  // Reveal the "enable notifications" header button only when the user
  // has not made a choice yet. Granted + denied both leave it hidden.
  const btn = $("#planner-notify-toggle");
  if (btn) btn.hidden = notifyState.permission !== "default";
}

async function requestNotificationPermission() {
  if (typeof Notification === "undefined") return;
  try {
    const result = await Notification.requestPermission();
    notifyState.permission = result;
    const btn = $("#planner-notify-toggle");
    if (btn) btn.hidden = true;
    if (result === "granted") {
      // Tiny confirmation toast so the user sees the wiring works.
      try {
        const n = new Notification("Notifications enabled", {
          body: "You will be pinged when each render finishes.",
          icon: "/icon-192.png",
        });
        setTimeout(() => n.close(), 4000);
      } catch {
        // ignore: some browsers throw on Notification with no service worker
      }
    }
  } catch (err) {
    console.error("notification permission request failed:", err);
  }
}

// Called from both the SSE message handler and the poll fallback when a
// terminal status arrives. Reads project / label from renderState (set
// at submit / resume / rerun time) so the notification title carries the
// human-readable identity instead of just the jobId.
function maybeNotifyTerminal(payload) {
  if (notifyState.permission !== "granted") return;
  if (!payload || !payload.jobId) return;
  if (notifyState.alreadyNotified.has(payload.jobId)) return;
  notifyState.alreadyNotified.add(payload.jobId);

  const identity =
    renderState.currentLabel
    || renderState.currentProject
    || payload.jobId;
  const status = payload.status || "FINISHED";

  let prefix;
  if (status === "COMPLETED") prefix = "✓";
  else if (status === "FAILED") prefix = "✗";
  else if (status === "CANCELLED") prefix = "○";
  else if (status === "TIMED_OUT") prefix = "⏱";
  else prefix = "·";

  const title = prefix + " " + status.toLowerCase().replace(/_/g, " ") + ": " + identity;
  let body = "job " + payload.jobId;
  if (payload.executionTimeMs) {
    body += " · ran " + formatDuration(payload.executionTimeMs);
  }

  try {
    const n = new Notification(title, {
      body: body,
      icon: "/icon-192.png",
      // `tag` lets the OS dedupe within its notification list so the
      // same jobId never appears twice even if a different code path
      // tries to re-notify.
      tag: payload.jobId,
      requireInteraction: false,
    });
    n.onclick = () => {
      window.focus();
      n.close();
      const sec = document.getElementById("planner-render");
      if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
    };
  } catch (err) {
    console.error("notification fire failed:", err);
  }
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
  // v0.38.0: restore form + result panels + render stream BEFORE async
  // data loaders fire, so the user sees their work immediately on reload.
  // The model picker value is set after loadModels resolves (its options
  // are populated by an async fetch).
  const stash = restorePersistedState();
  loadModels().then(() => {
    if (stash && stash.planForm && stash.planForm.modelId) {
      const select = $("#planner-model");
      if (select) {
        const found = Array.from(select.options).some(
          (o) => o.value === stash.planForm.modelId,
        );
        if (found) select.value = stash.planForm.modelId;
      }
    }
  });
  loadHistory();
  initNotifications();
  // v0.38.0: persist on brief / model picker change so the planner's
  // long-form input survives a tab close. Cast field listeners are
  // wired in renderCast().
  $("#planner-brief").addEventListener("input", persistSoon);
  $("#planner-model").addEventListener("change", persistSoon);
  $("#planner-quality-tier").addEventListener("change", persistSoon);
  $("#planner-render-overrides").addEventListener("input", persistSoon);
  // v0.40.0: persist the keyframes-only checkbox alongside the other
  // render-stage form fields.
  const kfOnlyEl = $("#planner-keyframes-only");
  if (kfOnlyEl) kfOnlyEl.addEventListener("change", persistSoon);
  $("#planner-plan").addEventListener("click", plan);
  $("#planner-reprompt").addEventListener("click", repromptWithErrors);
  $("#planner-bundle-btn").addEventListener("click", bundleNow);
  $("#planner-render-btn").addEventListener("click", submitRender);
  $("#planner-render-cancel").addEventListener("click", cancelRender);
  $("#planner-notify-toggle").addEventListener("click", requestNotificationPermission);
  $("#planner-history-refresh").addEventListener("click", loadHistory);
  $("#planner-history-custom").addEventListener("click", promptCustomBundle);

  // v0.37.1: client-side filter inputs. No fetch on change; just re-render
  // the already-loaded rows through the new filter state. v0.38.0 also
  // persists the filter state so reload restores the user's view.
  $("#planner-history-search").addEventListener("input", (ev) => {
    historyState.filters.text = ev.target.value;
    applyHistoryFilters();
    persistSoon();
  });
  $("#planner-filter-inflight").addEventListener("change", (ev) => {
    historyState.filters.showInFlight = ev.target.checked;
    applyHistoryFilters();
    savePersistedState();
  });
  $("#planner-filter-done").addEventListener("change", (ev) => {
    historyState.filters.showDone = ev.target.checked;
    applyHistoryFilters();
    savePersistedState();
  });
  $("#planner-filter-failed").addEventListener("change", (ev) => {
    historyState.filters.showFailed = ev.target.checked;
    applyHistoryFilters();
    savePersistedState();
  });

  // v0.35.2: pause auto-refresh while the tab is backgrounded; resume on
  // return with an immediate refresh so the list catches up after a long
  // hidden interval (which the auto-refresh loop intentionally skips).
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (historyRefreshTimer) {
        clearTimeout(historyRefreshTimer);
        historyRefreshTimer = null;
      }
    } else {
      loadHistory();
    }
  });

  $("#planner-brief").addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
      ev.preventDefault();
      plan();
    }
  });
});

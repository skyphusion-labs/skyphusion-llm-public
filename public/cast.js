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
  }

  // Expose pure helpers for vitest.
  window.__castHelpers = { encodeRefKey, artifactUrl };

  document.addEventListener("DOMContentLoaded", () => {
    wire();
    loadCastList();
  });
})();

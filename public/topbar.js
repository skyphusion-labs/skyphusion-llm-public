// Shared topbar helper (v0.66.0, modernized v0.120.0).
//
// Loaded on the pages that do NOT pull in app.js (planner.html, cast.html).
// Two jobs, both dependency-free and idempotent on element existence:
//
//   1. Fill the signed-in user's email. Supports both the new playground
//      chrome (#account-email inside the .account-menu popover) and the
//      legacy Vivijure pill (#wv-topbar-user-email). Fetches /api/whoami
//      exactly once per page load; a failure leaves a graceful placeholder.
//   2. Wire the .account-menu popover (open/close on the #account-toggle
//      button, close on outside-click / Escape) for pages that have it but
//      no app.js controller. The chat page (index.html) wires this in app.js
//      and does not load topbar.js, so there is no double-binding.

(function () {
  // --- 1. user email ---
  const emailEl =
    document.getElementById("account-email") ||
    document.getElementById("wv-topbar-user-email");
  if (emailEl) {
    fetch("/api/whoami", { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
      .then((data) => {
        const user = typeof data?.user === "string" ? data.user.trim() : "";
        if (user) {
          emailEl.textContent = user;
          emailEl.classList.remove("wv-topbar-user-empty");
        } else {
          emailEl.textContent = "(unknown)";
        }
      })
      .catch(() => {
        emailEl.textContent = "(offline)";
      });
  }

  // --- 2. account-menu popover ---
  const accountToggle = document.getElementById("account-toggle");
  const accountMenu = document.getElementById("account-menu");
  if (accountToggle && accountMenu) {
    accountToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      accountMenu.hidden = !accountMenu.hidden;
      accountToggle.setAttribute("aria-expanded", accountMenu.hidden ? "false" : "true");
    });
    document.addEventListener("click", (e) => {
      if (
        !accountMenu.hidden &&
        !accountMenu.contains(e.target) &&
        !accountToggle.contains(e.target)
      ) {
        accountMenu.hidden = true;
        accountToggle.setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      accountMenu.hidden = true;
      accountToggle.setAttribute("aria-expanded", "false");
    });
  }
})();

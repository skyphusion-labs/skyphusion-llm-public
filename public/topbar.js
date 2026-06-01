// Shared Vivijure topbar populater (v0.66.0).
//
// Every page that includes .wv-topbar gets the signed-in user pill filled by
// this script. Tiny on purpose - no dependencies, no framework, no event bus.
// Fetches /api/whoami exactly once per page load and writes the email into
// #wv-topbar-user-email. A failure just leaves the pill in its "(unknown)"
// state; the page itself still works because Cloudflare Access already
// gated the request before any of this code ran.
//
// The pill is wrapped in a <button> so a later patch can hang a User Options
// dropdown off it (preferences, sign-out, theme) without revisiting markup.
// For now the button is a no-op except for the hover affordance.

(function () {
  const emailEl = document.getElementById("wv-topbar-user-email");
  if (!emailEl) return;

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
})();

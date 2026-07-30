(() => {
  "use strict";

  if (globalThis.__moodleUtilsGuardianLoaded) {
    return;
  }
  globalThis.__moodleUtilsGuardianLoaded = true;

  const MOODLE_ORIGIN = "https://moodle.telt.unsw.edu.au";
  const OVERLAY_ID = "moodle-utils-recovery-overlay";
  const GUARDIAN_TOAST_ID = "moodle-utils-guardian-status";
  const DEFAULT_SETTINGS = {
    keepalive: true,
    ltiAutoClose: true,
    sessionRecovery: true,
    changedSinceLastVisit: true
  };

  let settings = { ...DEFAULT_SETTINGS };
  let overlayElements = null;

  function isExpiredErrorPage() {
    const errorMessage = document.querySelector(".errormessage");
    if (!errorMessage) {
      return false;
    }

    const text = errorMessage.textContent || "";
    const requireLoginHelp = document.querySelector(
      'a[href*="/error/moodle/requireloginerror"]'
    );
    return (
      text.includes("Course or activity not accessible.") &&
      (Boolean(requireLoginHelp) ||
        document.body.classList.contains("notloggedin") ||
        document.body.classList.contains("isguest"))
    );
  }

  function isLoginPage() {
    return location.pathname === "/login/index.php";
  }

  function hasRecoverableReferrer() {
    try {
      const referrer = new URL(document.referrer);
      return (
        referrer.origin === MOODLE_ORIGIN &&
        !referrer.pathname.startsWith("/login/") &&
        !referrer.pathname.startsWith("/auth/oidc/")
      );
    } catch {
      return false;
    }
  }

  function isAuthenticatedPage() {
    if (isLoginPage() || isExpiredErrorPage()) {
      return false;
    }

    return Boolean(
      document.body.classList.contains("loggedin") ||
        document.querySelector('[data-region="user-menu"]') ||
        document.querySelector(".usermenu .userbutton")
    );
  }

  function currentState() {
    if (isExpiredErrorPage()) {
      return "login_required";
    }
    if (isLoginPage()) {
      return "login_page";
    }
    if (isAuthenticatedPage()) {
      return "authenticated";
    }
    return "unknown";
  }

  function shareSettingsWithMainWorld() {
    window.postMessage(
      {
        source: "moodle-utils",
        type: "SETTINGS_UPDATED",
        settings
      },
      MOODLE_ORIGIN
    );
  }

  function getGuardianToast() {
    let toast = document.getElementById(GUARDIAN_TOAST_ID);
    if (toast) {
      return toast;
    }

    toast = document.createElement("div");
    toast.id = GUARDIAN_TOAST_ID;
    toast.setAttribute("role", "status");
    Object.assign(toast.style, {
      position: "fixed",
      left: "16px",
      bottom: "68px",
      zIndex: "2147483647",
      maxWidth: "340px",
      padding: "10px 13px",
      borderRadius: "9px",
      color: "#fff",
      background: "#0b57d0",
      boxShadow: "0 3px 14px rgba(0, 0, 0, 0.35)",
      font: "600 13px/1.35 system-ui, sans-serif",
      transition: "opacity 250ms ease",
      pointerEvents: "none"
    });
    document.documentElement.appendChild(toast);
    return toast;
  }

  function showGuardianStatus(message, state, persistent = false) {
    const toast = getGuardianToast();
    toast.textContent = message;
    toast.dataset.state = state;
    toast.style.background =
      state === "ok" ? "#0b57d0" : state === "warning" ? "#9a6700" : "#9b1c1c";
    toast.style.opacity = "1";
    window.clearTimeout(showGuardianStatus.hideTimer);
    if (!persistent) {
      showGuardianStatus.hideTimer = window.setTimeout(() => {
        toast.style.opacity = "0";
      }, 7000);
    }
  }

  function reportPageState() {
    if (!settings.sessionRecovery) {
      return Promise.resolve({ managed: false, disabled: true });
    }

    const state = currentState();
    const loginRedirect =
      isLoginPage() &&
      new URLSearchParams(location.search).get("loginredirect") === "1";

    return chrome.runtime
      .sendMessage({
        type: "PAGE_STATE",
        state,
        url: location.href,
        referrer: document.referrer,
        loginRedirect
      })
      .catch(() => null);
  }

  function createOverlay() {
    if (overlayElements) {
      return overlayElements;
    }

    const host = document.createElement("div");
    host.id = OVERLAY_ID;
    host.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "background:#f7f7f5",
      "color:#222"
    ].join(";");

    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .card {
          width: min(440px, calc(100vw - 32px));
          padding: 34px;
          border: 1px solid #deded8;
          border-top: 5px solid #f98012;
          border-radius: 10px;
          background: white;
          box-shadow: 0 12px 40px rgba(0, 0, 0, 0.12);
          font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          text-align: center;
        }
        .mark {
          width: 48px;
          height: 48px;
          margin: 0 auto 16px;
          background: url("${chrome.runtime.getURL("icons/icon-48.png")}") center/contain no-repeat;
        }
        h1 {
          margin: 0 0 8px;
          font-size: 22px;
          line-height: 1.25;
        }
        p {
          margin: 0;
          color: #555;
        }
        button {
          display: none;
          width: 100%;
          margin-top: 22px;
          padding: 11px 18px;
          border: 0;
          border-radius: 6px;
          background: #222;
          color: white;
          font: inherit;
          font-weight: 650;
          cursor: pointer;
        }
        button:hover { background: #000; }
        .spinner {
          width: 18px;
          height: 18px;
          margin: 22px auto 0;
          border: 2px solid #ddd;
          border-top-color: #f98012;
          border-radius: 50%;
          animation: spin .8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
      <section class="card" role="status" aria-live="polite">
        <div class="mark" aria-hidden="true"></div>
        <h1>Restoring Moodle</h1>
        <p>Reconnecting through UNSW…</p>
        <div class="spinner"></div>
        <button type="button">Open UNSW sign-in</button>
      </section>
    `;

    const message = shadow.querySelector("p");
    const button = shadow.querySelector("button");
    const spinner = shadow.querySelector(".spinner");

    button.addEventListener("click", () => {
      void chrome.runtime.sendMessage({ type: "FOCUS_AUTH_TAB" });
    });

    document.documentElement.appendChild(host);
    overlayElements = { host, message, button, spinner };
    return overlayElements;
  }

  function removeOverlay() {
    overlayElements?.host.remove();
    overlayElements = null;
  }

  function updateOverlay(phase, detail) {
    if (!settings.sessionRecovery) {
      removeOverlay();
      return;
    }

    const overlay = createOverlay();
    overlay.message.textContent = detail || "Reconnecting through UNSW…";

    const needsUser = phase === "needs_user" || phase === "failed";
    overlay.button.style.display = needsUser ? "block" : "none";
    overlay.spinner.style.display = needsUser ? "none" : "block";
  }

  async function checkSession({ delayMs = 0, announce = false } = {}) {
    if (!settings.sessionRecovery) {
      return { status: "disabled" };
    }

    if (delayMs > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      if (!settings.sessionRecovery) {
        return { status: "disabled" };
      }
    }

    try {
      const probeUrl = `${MOODLE_ORIGIN}/my/?moodle_utils_probe=${Date.now()}`;
      const response = await fetch(probeUrl, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        redirect: "follow"
      });

      const finalUrl = new URL(response.url);
      if (finalUrl.pathname === "/login/index.php") {
        if (announce) {
          showGuardianStatus(
            "Moodle Guardian: session expired — reconnecting",
            "warning",
            true
          );
        }
        return { status: "logged_out" };
      }

      const html = await response.text();
      const parsed = new DOMParser().parseFromString(html, "text/html");
      const loggedOut =
        parsed.body?.classList.contains("notloggedin") ||
        parsed.body?.classList.contains("isguest") ||
        html.includes("You are currently using guest access") ||
        html.includes("Agree and sign on to Moodle");

      if (!loggedOut) {
        const sesskeyMatch = html.match(/"sesskey"\s*:\s*"([^"]+)"/);
        if (sesskeyMatch?.[1]) {
          window.postMessage(
            {
              source: "moodle-utils",
              type: "SESSION_INFO",
              sesskey: sesskeyMatch[1]
            },
            MOODLE_ORIGIN
          );
        }
      }

      if (announce) {
        showGuardianStatus(
          loggedOut
            ? "Moodle Guardian: session expired — reconnecting"
            : "Moodle Guardian: session check passed",
          loggedOut ? "warning" : "ok",
          loggedOut
        );
      }
      return { status: loggedOut ? "logged_out" : "authenticated" };
    } catch {
      if (announce) {
        showGuardianStatus(
          "Moodle Guardian: check skipped while offline",
          "warning"
        );
      }
      return { status: "unreachable" };
    }
  }

  async function handleKeepaliveFailure(message) {
    if (
      message.source !== window ||
      message.origin !== MOODLE_ORIGIN ||
      message.data?.source !== "moodle-utils-main" ||
      message.data?.type !== "KEEPALIVE_RESULT" ||
      message.data?.ok !== false ||
      !settings.sessionRecovery
    ) {
      return;
    }

    const result = await checkSession({ announce: true });
    if (result.status === "logged_out") {
      await chrome.runtime.sendMessage({
        type: "SESSION_PROBE_RESULT",
        status: "logged_out"
      });
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "RECOVERY_STATUS") {
      updateOverlay(message.phase, message.detail);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "SETTINGS_UPDATED") {
      settings = { ...DEFAULT_SETTINGS, ...(message.settings || {}) };
      shareSettingsWithMainWorld();
      if (!settings.sessionRecovery) {
        removeOverlay();
      }
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "CHECK_SESSION") {
      void checkSession({
        delayMs: Number(message.delayMs) || 0,
        announce: Boolean(message.announce)
      }).then(sendResponse);
      return true;
    }

    if (message?.type === "REPORT_PAGE_STATE") {
      void reportPageState().then(sendResponse);
      return true;
    }
  });

  window.addEventListener("message", (event) => {
    if (
      event.source === window &&
      event.origin === MOODLE_ORIGIN &&
      event.data?.source === "moodle-utils-main" &&
      event.data?.type === "REQUEST_SETTINGS"
    ) {
      shareSettingsWithMainWorld();
      return;
    }

    void handleKeepaliveFailure(event);
  });

  void chrome.runtime
    .sendMessage({ type: "GET_SETTINGS" })
    .then((storedSettings) => {
      settings = { ...DEFAULT_SETTINGS, ...(storedSettings || {}) };
      shareSettingsWithMainWorld();

      if (!settings.sessionRecovery) {
        return null;
      }

      const state = currentState();
      const isRedirectedLogin =
        state === "login_page" &&
        new URLSearchParams(location.search).get("loginredirect") === "1" &&
        hasRecoverableReferrer();

      if (state === "login_required" || isRedirectedLogin) {
        createOverlay();
      }

      return reportPageState();
    })
    .then((response) => {
      if (response?.managed && response.phase) {
        updateOverlay(response.phase, response.detail);
      }
    })
    .catch(() => {
      // Extension reloads can briefly invalidate the message channel.
    });
})();

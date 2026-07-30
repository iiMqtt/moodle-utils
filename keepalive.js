(() => {
  "use strict";

  if (window.__moodleUtilsSessionKeeperLoaded) {
    return;
  }
  window.__moodleUtilsSessionKeeperLoaded = true;

  // This is the proven UNSW Moodle Session Keeper implementation. The only
  // integration changes are its Moodle Utils enable switch and result signal.
  const HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;
  const CHECK_INTERVAL_MS = 60 * 1000;
  const LOCK_LIFETIME_MS = 30 * 1000;
  const LAST_SUCCESS_KEY = "unsw-moodle-session-keeper:last-success:v1";
  const LOCK_KEY = "unsw-moodle-session-keeper:lock:v1";
  const BADGE_ID = "unsw-moodle-session-keeper-status";
  const logPrefix = "[Moodle Utils: Session Keeper]";
  let enabled = true;
  let latestSesskey = null;

  function getBadge() {
    let badge = document.getElementById(BADGE_ID);
    if (badge) {
      return badge;
    }

    badge = document.createElement("div");
    badge.id = BADGE_ID;
    badge.setAttribute("role", "status");
    Object.assign(badge.style, {
      position: "fixed",
      left: "16px",
      bottom: "16px",
      zIndex: "2147483647",
      maxWidth: "320px",
      padding: "10px 13px",
      borderRadius: "9px",
      color: "#fff",
      background: "#146c43",
      boxShadow: "0 3px 14px rgba(0, 0, 0, 0.35)",
      font: "600 13px/1.35 system-ui, sans-serif",
      transition: "opacity 250ms ease",
      pointerEvents: "none"
    });
    document.documentElement.appendChild(badge);
    return badge;
  }

  function showStatus(message, state, persistent = false) {
    const badge = getBadge();
    badge.textContent = message;
    badge.dataset.state = state;
    badge.style.background = state === "ok" ? "#146c43" : "#9b1c1c";
    badge.style.opacity = "1";
    window.clearTimeout(showStatus.hideTimer);
    if (!persistent) {
      showStatus.hideTimer = window.setTimeout(() => {
        badge.style.opacity = "0";
      }, 7000);
    }
  }

  function reportResult(ok, message) {
    window.postMessage(
      {
        source: "moodle-utils-main",
        type: "KEEPALIVE_RESULT",
        ok,
        message
      },
      location.origin
    );
  }

  function readTimestamp(key) {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) ? value : 0;
  }

  function tryAcquireLock(now) {
    let existing;
    try {
      existing = JSON.parse(window.localStorage.getItem(LOCK_KEY) || "null");
    } catch {
      existing = null;
    }
    if (existing?.expiresAt > now) {
      return null;
    }

    const token = `${now}:${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(
      LOCK_KEY,
      JSON.stringify({
        token,
        expiresAt: now + LOCK_LIFETIME_MS
      })
    );

    try {
      const saved = JSON.parse(
        window.localStorage.getItem(LOCK_KEY) || "null"
      );
      return saved?.token === token ? token : null;
    } catch {
      return null;
    }
  }

  function releaseLock(token) {
    try {
      const saved = JSON.parse(
        window.localStorage.getItem(LOCK_KEY) || "null"
      );
      if (saved?.token === token) {
        window.localStorage.removeItem(LOCK_KEY);
      }
    } catch {
      // A stale 30-second lock is harmless and will expire by itself.
    }
  }

  async function touchSession({ force = false } = {}) {
    if (!enabled) {
      return false;
    }

    const moodle = window.M?.cfg;
    const sesskey = latestSesskey || moodle?.sesskey;
    if (!sesskey || !moodle?.wwwroot) {
      console.debug(`${logPrefix} Waiting for a signed-in Moodle page.`);
      return false;
    }

    const now = Date.now();
    const lastSuccess = readTimestamp(LAST_SUCCESS_KEY);
    if (!force && now - lastSuccess < HEARTBEAT_INTERVAL_MS) {
      return true;
    }

    const lockToken = tryAcquireLock(now);
    if (!lockToken) {
      return true;
    }

    try {
      const endpoint = new URL("/lib/ajax/service.php", moodle.wwwroot);
      endpoint.searchParams.set("sesskey", sesskey);
      endpoint.searchParams.set("info", "core_session_touch");

      const response = await window.fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify([
          {
            index: 0,
            methodname: "core_session_touch",
            args: {}
          }
        ])
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = await response.json();
      if (!Array.isArray(result) || result[0]?.error || result[0]?.exception) {
        throw new Error(
          result?.[0]?.message ||
            result?.[0]?.exception?.message ||
            "Unexpected Moodle response"
        );
      }

      window.localStorage.setItem(LAST_SUCCESS_KEY, String(Date.now()));
      const message = `Moodle session keeper: live check passed at ${new Date().toLocaleTimeString()}`;
      console.info(`${logPrefix} ${message}.`);
      showStatus(message, "ok");
      reportResult(true, message);
      return true;
    } catch (error) {
      const message = `Moodle session keeper failed: ${error.message}`;
      console.error(`${logPrefix} Heartbeat failed.`, error);
      showStatus(message, "error", true);
      reportResult(false, message);
      return false;
    } finally {
      releaseLock(lockToken);
    }
  }

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.source !== "moodle-utils"
    ) {
      return;
    }

    if (event.data.type === "SESSION_INFO" && event.data.sesskey) {
      latestSesskey = String(event.data.sesskey);
      return;
    }

    if (event.data.type === "SETTINGS_UPDATED") {
      const nextEnabled = event.data.settings?.keepalive !== false;
      const wasEnabled = enabled;
      enabled = nextEnabled;
      if (enabled && !wasEnabled) {
        window.setTimeout(() => touchSession({ force: true }), 0);
      }
    }
  });

  window.postMessage(
    {
      source: "moodle-utils-main",
      type: "REQUEST_SETTINGS"
    },
    location.origin
  );

  // Run a forced request on load so installation can be verified immediately.
  window.setTimeout(() => touchSession({ force: true }), 1500);
  window.setInterval(() => touchSession(), CHECK_INTERVAL_MS);

  // A wake-up after sleep or heavy background throttling gets an immediate check.
  window.addEventListener("focus", () => touchSession());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      touchSession();
    }
  });
  window.addEventListener("online", () => touchSession());
})();

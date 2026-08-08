(() => {
  "use strict";

  if (globalThis.__moodleUtilsLtiAutoCloseLoaded) {
    return;
  }
  globalThis.__moodleUtilsLtiAutoCloseLoaded = true;

  const CLOSE_DELAY_MS = 1200;
  const REVEAL_FAILSAFE_MS = 10000;
  const CONCEAL_STYLE_ID = "moodle-utils-lti-conceal";

  function concealPage() {
    if (document.getElementById(CONCEAL_STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = CONCEAL_STYLE_ID;
    style.textContent =
      "html { visibility: hidden !important; background: white !important; }";
    document.documentElement.appendChild(style);
  }

  function revealPage() {
    document.getElementById(CONCEAL_STYLE_ID)?.remove();
  }

  function waitForDocument() {
    if (document.readyState !== "loading") {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      document.addEventListener("DOMContentLoaded", resolve, { once: true });
    });
  }

  function looksLikeIntermediateLaunchPage() {
    const path = location.pathname;
    const text = (document.body?.innerText || "").toLowerCase();
    return (
      path.includes("/mod/lti/launch.php") ||
      text.includes("your activity has opened in a new window") ||
      text.includes("this activity has opened in a new window") ||
      Boolean(
        document.querySelector(
          'a[href*="mobius"], a[href*="digitaled"], a[target="_blank"]'
        )
      )
    );
  }

  concealPage();
  const revealFailsafe = window.setTimeout(revealPage, REVEAL_FAILSAFE_MS);

  void (async () => {
    try {
      const settings = await chrome.runtime.sendMessage({
        type: "GET_SETTINGS"
      });
      if (settings?.ltiAutoClose === false) {
        revealPage();
        return;
      }

      const concealment = await chrome.runtime.sendMessage({
        type: "CONCEAL_LTI_LAUNCH_TAB"
      });
      if (!concealment?.concealed) {
        revealPage();
      }

      await waitForDocument();
      if (!looksLikeIntermediateLaunchPage()) {
        revealPage();
        return;
      }

      window.clearTimeout(revealFailsafe);
      window.setTimeout(async () => {
        if (concealment?.concealed) {
          try {
            const result = await chrome.runtime.sendMessage({
              type: "CLOSE_CONCEALED_LTI_TAB"
            });
            if (result?.closed) {
              return;
            }
          } catch {
            // Fall back to the proven standalone close behaviour below.
          }
        }
        window.close();
      }, CLOSE_DELAY_MS);
    } catch {
      revealPage();
      // An extension reload can briefly invalidate the message channel.
    }
  })();
})();

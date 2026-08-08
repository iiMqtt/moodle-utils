(() => {
  "use strict";

  if (globalThis.__moodleUtilsLtiAutoCloseLoaded) {
    return;
  }
  globalThis.__moodleUtilsLtiAutoCloseLoaded = true;

  const CLOSE_DELAY_MS = 1200;
  const REVEAL_FAILSAFE_MS = 5000;
  const CONCEAL_STYLE_ID = "moodle-utils-lti-conceal";

  const shouldConcealImmediately = location.pathname.includes(
    "/mod/lti/launch.php"
  );

  function concealPage() {
    if (!shouldConcealImmediately || document.getElementById(CONCEAL_STYLE_ID)) {
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

  concealPage();
  const revealFailsafe = shouldConcealImmediately
    ? window.setTimeout(revealPage, REVEAL_FAILSAFE_MS)
    : null;

  void chrome.runtime
    .sendMessage({ type: "GET_SETTINGS" })
    .then((settings) => {
      if (settings?.ltiAutoClose === false) {
        revealPage();
        return;
      }

      const path = location.pathname;
      const text = (document.body?.innerText || "").toLowerCase();

      // Detection and timing intentionally match the proven standalone
      // UNSW Moodle LTI Auto-Close extension.
      const looksLikeIntermediateLaunchPage =
        path.includes("/mod/lti/launch.php") ||
        text.includes("your activity has opened in a new window") ||
        text.includes("this activity has opened in a new window") ||
        Boolean(
          document.querySelector(
            'a[href*="mobius"], a[href*="digitaled"], a[target="_blank"]'
          )
        );

      if (!looksLikeIntermediateLaunchPage) {
        revealPage();
        return;
      }

      if (revealFailsafe !== null) {
        window.clearTimeout(revealFailsafe);
      }
      window.setTimeout(() => {
        window.close();
        window.setTimeout(revealPage, REVEAL_FAILSAFE_MS);
      }, CLOSE_DELAY_MS);
    })
    .catch(() => {
      revealPage();
      // An extension reload can briefly invalidate the message channel.
    });
})();

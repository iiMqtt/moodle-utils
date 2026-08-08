(() => {
  "use strict";

  if (globalThis.__moodleUtilsLtiAutoCloseLoaded) {
    return;
  }
  globalThis.__moodleUtilsLtiAutoCloseLoaded = true;

  const CLOSE_DELAY_MS = 1200;

  void chrome.runtime
    .sendMessage({ type: "GET_SETTINGS" })
    .then((settings) => {
      if (settings?.ltiAutoClose === false) {
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
        return;
      }

      window.setTimeout(() => {
        window.close();
      }, CLOSE_DELAY_MS);
    })
    .catch(() => {
      // An extension reload can briefly invalidate the message channel.
    });
})();

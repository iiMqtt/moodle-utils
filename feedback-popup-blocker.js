(() => {
  "use strict";

  if (globalThis.__moodleUtilsFeedbackPopupBlockerLoaded) {
    return;
  }
  globalThis.__moodleUtilsFeedbackPopupBlockerLoaded = true;

  const FEEDBACK_HEADING =
    "Please provide feedback for the following courses:";
  const BLOCKED_ATTRIBUTE = "data-moodle-utils-blocked-feedback-popup";
  const DEFAULT_SETTINGS = {
    blockMyExperiencePopup: true
  };

  let settings = { ...DEFAULT_SETTINGS };
  let observer = null;
  let scanTimer = null;
  let waitingToStart = false;

  function normalise(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function openRoots() {
    const roots = [document];
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot && !roots.includes(element.shadowRoot)) {
          roots.push(element.shadowRoot);
        }
      }
    }
    return roots;
  }

  function findHeading(root) {
    const candidates = root.querySelectorAll(
      "strong, b, h1, h2, h3, h4, p, div, span"
    );
    let partialMatch = null;
    let partialLength = Infinity;
    for (const element of candidates) {
      const text = normalise(element.textContent);
      if (text === FEEDBACK_HEADING) {
        return element;
      }
      if (
        text.includes(FEEDBACK_HEADING) &&
        text.length < partialLength
      ) {
        partialMatch = element;
        partialLength = text.length;
      }
    }
    return partialMatch;
  }

  function looksLikeFeedbackPrompt(element) {
    const text = normalise(element?.textContent);
    if (!text.includes(FEEDBACK_HEADING)) {
      return false;
    }
    if (text.length > 5000) {
      return false;
    }

    const courseLinks = element.querySelectorAll(
      'a[href*="/course/view.php?id="]'
    );
    return (
      courseLinks.length >= 1 ||
      /\bDue\s+(January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(
        text
      )
    );
  }

  function findPopupRoot(heading) {
    const explicit = heading.closest(
      [
        '[role="dialog"]',
        "dialog",
        ".modal",
        '[id*="popup" i]',
        '[class*="popup" i]',
        '[class*="overlay" i]'
      ].join(",")
    );
    if (explicit && looksLikeFeedbackPrompt(explicit)) {
      return explicit;
    }

    let candidate = heading;
    for (let depth = 0; candidate && depth < 9; depth += 1) {
      if (candidate !== document.body && looksLikeFeedbackPrompt(candidate)) {
        const style = getComputedStyle(candidate);
        const courseLinks = candidate.querySelectorAll(
          'a[href*="/course/view.php?id="]'
        );
        if (
          style.position === "fixed" ||
          style.position === "absolute" ||
          courseLinks.length >= 2
        ) {
          return candidate;
        }
      }
      candidate = candidate.parentElement;
    }

    const parentText = normalise(heading.parentElement?.textContent);
    return parentText.length <= 3000 ? heading.parentElement : null;
  }

  function unblockPageAfterModal(root) {
    const wasModal =
      root.matches?.(".modal, [role='dialog'], dialog") ||
      Boolean(root.querySelector?.(".modal-dialog"));
    if (!wasModal) {
      return;
    }

    const visibleOtherModal = [...document.querySelectorAll(".modal.show")].some(
      (modal) => modal !== root && !root.contains(modal)
    );
    if (!visibleOtherModal) {
      document.body?.classList.remove("modal-open");
      document.body?.style.removeProperty("overflow");
      document.body?.style.removeProperty("padding-right");
      for (const backdrop of document.querySelectorAll(
        ".modal-backdrop.show"
      )) {
        backdrop.remove();
      }
    }
  }

  function blockPopup(root) {
    if (
      !root ||
      root === document.body ||
      root === document.documentElement ||
      root.matches?.("main, [role='main'], #page, #page-wrapper, #page-content")
    ) {
      return false;
    }

    root.setAttribute(BLOCKED_ATTRIBUTE, "true");
    root.style.setProperty("display", "none", "important");
    unblockPageAfterModal(root);
    root.remove();
    return true;
  }

  function scan() {
    if (!settings.blockMyExperiencePopup) {
      return false;
    }

    for (const root of openRoots()) {
      const heading = findHeading(root);
      if (!heading) {
        continue;
      }
      const popup = findPopupRoot(heading);
      if (popup && looksLikeFeedbackPrompt(popup)) {
        return blockPopup(popup);
      }
    }
    return false;
  }

  function scheduleScan() {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scan, 40);
  }

  function start() {
    if (!settings.blockMyExperiencePopup || observer) {
      return;
    }
    if (!document.documentElement) {
      if (!waitingToStart) {
        waitingToStart = true;
        document.addEventListener(
          "readystatechange",
          () => {
            waitingToStart = false;
            start();
          },
          { once: true }
        );
      }
      return;
    }
    scan();
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    waitingToStart = false;
    window.clearTimeout(scanTimer);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "SETTINGS_UPDATED") {
      return;
    }
    settings = { ...DEFAULT_SETTINGS, ...(message.settings || {}) };
    if (settings.blockMyExperiencePopup) {
      start();
    } else {
      stop();
    }
    sendResponse({ ok: true });
  });

  void chrome.runtime
    .sendMessage({ type: "GET_SETTINGS" })
    .then((storedSettings) => {
      settings = { ...DEFAULT_SETTINGS, ...(storedSettings || {}) };
      if (settings.blockMyExperiencePopup) {
        start();
      }
    })
    .catch(() => {
      // Extension reloads can briefly invalidate the message channel.
    });
})();

(() => {
  "use strict";

  if (globalThis.__moodleUtilsChangedSinceLastVisitLoaded) {
    return;
  }
  globalThis.__moodleUtilsChangedSinceLastVisitLoaded = true;

  const core = globalThis.MoodleUtilsChangeDetectorCore;
  if (!core) {
    return;
  }

  const SNAPSHOTS_KEY = "moodleUtilsChangeSnapshotsV1";
  const PANEL_ID = "moodle-utils-changes-panel";
  const STYLE_ID = "moodle-utils-changes-style";
  const MAX_SNAPSHOTS = 40;
  const DEFAULT_SETTINGS = {
    keepalive: true,
    ltiAutoClose: true,
    sessionRecovery: true,
    changedSinceLastVisit: true,
    courseTabManager: true,
    blockMyExperiencePopup: true
  };
  const SECTION_TITLE_SELECTORS = [
    ":scope > .content .sectionname",
    ":scope > .section-item .sectionname",
    ":scope > [data-for='section_title']",
    ":scope .sectionname",
    ":scope [data-for='section_title']",
    ":scope h3[id^='coursecontentsection']",
    ":scope > .content > h3"
  ];

  let settings = { ...DEFAULT_SETTINGS };
  let observer = null;
  let scanTimer = null;
  let currentSnapshot = null;
  let baselineSnapshot = null;
  let itemElements = new Map();
  let reviewElements = [];
  let reviewIndex = -1;

  function getCourseContext() {
    if (location.pathname !== "/course/view.php") {
      return null;
    }

    const parameters = new URLSearchParams(location.search);
    const courseId = parameters.get("id");
    if (!courseId) {
      return null;
    }

    const section = parameters.get("section");
    const scope = section ? `section-${section}` : "all";
    return {
      courseId,
      scope,
      storageKey: `${courseId}:${scope}`
    };
  }

  function directText(element, selectors) {
    const parts = [];
    for (const selector of selectors) {
      for (const node of element.querySelectorAll(selector)) {
        const clone = node.cloneNode(true);
        for (const ignored of clone.querySelectorAll(
          [
            ".accesshide",
            ".visually-hidden",
            ".moodle-utils-change-label",
            "[data-region='completion-info']",
            ".activity-completion",
            ".dropdown",
            "button"
          ].join(",")
        )) {
          ignored.remove();
        }
        const text = core.normaliseWhitespace(clone.textContent);
        if (text && !parts.includes(text)) {
          parts.push(text);
        }
      }
    }
    return parts.join(" · ");
  }

  function getSectionInfo(element) {
    const section = element.closest(
      '[data-for="section"], li.section, .course-section'
    );
    if (!section) {
      return { key: "", title: "" };
    }
    const rawId =
      section.dataset.id ||
      section.dataset.sectionid ||
      section.id.match(/section-(\d+)/)?.[1] ||
      "";
    return {
      key: rawId ? `section:${rawId}` : "",
      title: directText(section, SECTION_TITLE_SELECTORS)
    };
  }

  function primaryActivityLink(element) {
    const selectors = [
      ".activityname a[href]",
      "a.aalink[href]",
      "a[href*='/mod/'][href*='id=']"
    ];
    for (const selector of selectors) {
      const link = element.querySelector(selector);
      if (link) {
        return link;
      }
    }
    return null;
  }

  function activityKey(element, url, title, section) {
    const rawId =
      element.dataset.id ||
      element.id.match(/^module-(\d+)$/)?.[1] ||
      new URL(url || location.href).searchParams.get("id");
    if (rawId) {
      return `activity:${rawId}`;
    }
    if (url) {
      return `url:${core.canonicaliseUrl(url, location.href)}`;
    }
    return `activity-text:${section}\u241f${title}`;
  }

  function extractActivity(element) {
    const link = primaryActivityLink(element);
    const sectionInfo = getSectionInfo(element);
    const section = sectionInfo.title;
    const title =
      core.normaliseWhitespace(element.dataset.activityname) ||
      directText(element, [".activityname .instancename", ".activityname"]) ||
      core.normaliseWhitespace(link?.textContent);
    const url = link?.href || "";
    const details = directText(element, [
      ".activity-dates",
      "[data-region='activity-dates']",
      ".availabilityinfo",
      "[data-region='availability-info']",
      ".activity-altcontent",
      ".contentafterlink",
      ".activity-description"
    ]);

    return core.prepareItem({
      key: activityKey(element, url, title, section),
      kind: "activity",
      title,
      url,
      section,
      container: sectionInfo.key,
      details
    });
  }

  function extractSection(element) {
    const id =
      element.dataset.id ||
      element.dataset.sectionid ||
      element.id.match(/section-(\d+)/)?.[1];
    const title = directText(element, SECTION_TITLE_SELECTORS);
    if (!title) {
      return null;
    }
    const details = directText(element, [
      ":scope > .content .summary",
      ":scope > .section-item .summary",
      ":scope > .content > .description"
    ]);

    return core.prepareItem({
      key: id ? `section:${id}` : `section-text:${title}`,
      kind: "section",
      title,
      url: "",
      section: title,
      container: "",
      details
    });
  }

  function activityElements() {
    const preferred = [
      ...document.querySelectorAll('[data-for="cmitem"]')
    ];
    if (preferred.length) {
      return preferred;
    }

    const legacy = [...document.querySelectorAll("li.activity[id^='module-']")];
    if (legacy.length) {
      return legacy;
    }

    return [...document.querySelectorAll(".activity-item[data-activityname]")];
  }

  function sectionElements() {
    return [
      ...document.querySelectorAll(
        '[data-for="section"], li.section[id^="section-"], .course-section'
      )
    ].filter(
      (element, index, all) =>
        all.indexOf(element) === index &&
        !element.closest('[data-for="cmitem"], li.activity')
    );
  }

  function captureSnapshot(context) {
    const items = [];
    const seenKeys = new Set();
    itemElements = new Map();

    for (const element of activityElements()) {
      const item = extractActivity(element);
      if (!item.key || seenKeys.has(item.key)) {
        continue;
      }
      seenKeys.add(item.key);
      items.push(item);
      itemElements.set(item.key, element);
    }

    for (const element of sectionElements()) {
      const item = extractSection(element);
      if (!item?.key || seenKeys.has(item.key)) {
        continue;
      }
      seenKeys.add(item.key);
      items.push(item);
      itemElements.set(item.key, element);
    }

    return core.prepareSnapshot({
      courseId: context.courseId,
      scope: context.scope,
      title: document.querySelector("h1")?.textContent || document.title,
      capturedAt: Date.now(),
      items
    });
  }

  async function getSnapshots() {
    const stored = await chrome.storage.local.get(SNAPSHOTS_KEY);
    return stored[SNAPSHOTS_KEY] || {};
  }

  async function saveSnapshot(context, snapshot) {
    const snapshots = await getSnapshots();
    snapshots[context.storageKey] = core.prepareSnapshot(snapshot);

    const keysByAge = Object.keys(snapshots).sort(
      (left, right) =>
        Number(snapshots[right]?.capturedAt || 0) -
        Number(snapshots[left]?.capturedAt || 0)
    );
    for (const key of keysByAge.slice(MAX_SNAPSHOTS)) {
      delete snapshots[key];
    }

    await chrome.storage.local.set({ [SNAPSHOTS_KEY]: snapshots });
    return snapshots[context.storageKey];
  }

  function ensureHighlightStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      [data-moodle-utils-change="added"] {
        outline: 3px solid rgba(24, 128, 56, .48) !important;
        outline-offset: 2px;
        border-radius: 8px;
        background: rgba(24, 128, 56, .055) !important;
      }
      [data-moodle-utils-change="updated"] {
        outline: 3px solid rgba(249, 128, 18, .58) !important;
        outline-offset: 2px;
        border-radius: 8px;
        background: rgba(249, 128, 18, .07) !important;
      }
      .moodle-utils-change-label {
        display: inline-flex;
        align-items: center;
        margin: 4px 7px;
        padding: 3px 7px;
        border-radius: 999px;
        color: white;
        background: #188038;
        font: 700 11px/1.2 system-ui, sans-serif;
        letter-spacing: .02em;
        vertical-align: middle;
      }
      [data-moodle-utils-change="updated"] .moodle-utils-change-label {
        background: #b45309;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function clearHighlights() {
    for (const element of document.querySelectorAll(
      "[data-moodle-utils-change]"
    )) {
      delete element.dataset.moodleUtilsChange;
    }
    for (const label of document.querySelectorAll(
      ".moodle-utils-change-label"
    )) {
      label.remove();
    }
    reviewElements = [];
    reviewIndex = -1;
  }

  function highlight(item, state) {
    const element = itemElements.get(item.key);
    if (!element) {
      return;
    }

    element.dataset.moodleUtilsChange = state;
    const label = document.createElement("span");
    label.className = "moodle-utils-change-label";
    label.textContent = state === "added" ? "NEW" : "UPDATED";
    label.setAttribute("aria-label", `Moodle Utils: ${label.textContent}`);

    const target =
      element.querySelector(".activityname, .sectionname, h3") || element;
    target.appendChild(label);
    reviewElements.push(element);
  }

  function removePanel() {
    document.getElementById(PANEL_ID)?.remove();
  }

  function createPanel(diff, context) {
    removePanel();
    const total =
      diff.added.length + diff.updated.length + diff.removed.length;
    if (!total) {
      return;
    }

    const host = document.createElement("div");
    host.id = PANEL_ID;
    host.style.cssText =
      "position:fixed;right:18px;bottom:18px;z-index:2147483646";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .panel {
          width: min(370px, calc(100vw - 36px));
          overflow: hidden;
          border: 1px solid #d7d7d2;
          border-top: 4px solid #f98012;
          border-radius: 11px;
          background: #fff;
          color: #202124;
          box-shadow: 0 8px 28px rgba(0, 0, 0, .24);
          font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          padding: 13px 14px 9px;
        }
        h2 { margin: 0; font-size: 16px; }
        header p { margin: 3px 0 0; color: #666; }
        .close {
          flex: 0 0 auto;
          border: 0;
          background: transparent;
          color: #666;
          font: 22px/1 sans-serif;
          cursor: pointer;
        }
        ul {
          max-height: 210px;
          margin: 0;
          padding: 0 14px 8px 32px;
          overflow: auto;
        }
        li { margin: 4px 0; }
        .item {
          padding: 0;
          border: 0;
          background: transparent;
          color: #174ea6;
          font: inherit;
          text-align: left;
          cursor: pointer;
        }
        .removed { color: #666; }
        footer {
          display: flex;
          gap: 8px;
          padding: 10px 14px 13px;
          border-top: 1px solid #ecece8;
        }
        footer button {
          flex: 1;
          padding: 8px 10px;
          border: 1px solid #c9c9c4;
          border-radius: 7px;
          background: #fff;
          color: #202124;
          font: inherit;
          font-weight: 650;
          cursor: pointer;
        }
        footer .seen {
          border-color: #202124;
          background: #202124;
          color: #fff;
        }
        button:disabled { cursor: default; opacity: .5; }
      </style>
      <section class="panel" role="status" aria-live="polite">
        <header>
          <div>
            <h2></h2>
            <p></p>
          </div>
          <button class="close" type="button" aria-label="Hide changes panel">&times;</button>
        </header>
        <ul></ul>
        <footer>
          <button class="review" type="button">Next change</button>
          <button class="seen" type="button">Mark all seen</button>
        </footer>
      </section>
    `;

    const summaryParts = [];
    if (diff.added.length) {
      summaryParts.push(`${diff.added.length} new`);
    }
    if (diff.updated.length) {
      summaryParts.push(`${diff.updated.length} updated`);
    }
    if (diff.removed.length) {
      summaryParts.push(`${diff.removed.length} removed`);
    }

    shadow.querySelector("h2").textContent =
      total === 1 ? "1 course change" : `${total} course changes`;
    shadow.querySelector("header p").textContent = summaryParts.join(" · ");

    const list = shadow.querySelector("ul");
    const appendItem = (item, prefix, removed = false) => {
      const row = document.createElement("li");
      if (removed) {
        row.className = "removed";
        row.textContent = `${prefix}: ${item.title}`;
      } else {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "item";
        button.textContent = `${prefix}: ${item.title}`;
        button.addEventListener("click", () => {
          const element = itemElements.get(item.key);
          element?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
        row.appendChild(button);
      }
      list.appendChild(row);
    };

    diff.added.forEach((item) => appendItem(item, "New"));
    diff.updated.forEach(({ after }) => appendItem(after, "Updated"));
    diff.removed.forEach((item) => appendItem(item, "Removed", true));

    const reviewButton = shadow.querySelector(".review");
    reviewButton.disabled = reviewElements.length === 0;
    reviewButton.addEventListener("click", () => {
      if (!reviewElements.length) {
        return;
      }
      reviewIndex = (reviewIndex + 1) % reviewElements.length;
      reviewElements[reviewIndex].scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    });
    shadow.querySelector(".close").addEventListener("click", removePanel);
    shadow.querySelector(".seen").addEventListener("click", async () => {
      baselineSnapshot = await saveSnapshot(context, currentSnapshot);
      observer?.disconnect();
      clearHighlights();
      removePanel();
      showFirstVisitToast("Course changes marked as seen.");
      observeCourse();
    });

    document.documentElement.appendChild(host);
  }

  function showFirstVisitToast(message) {
    removePanel();
    const host = document.createElement("div");
    host.id = PANEL_ID;
    host.setAttribute("role", "status");
    host.textContent = message;
    host.style.cssText = [
      "position:fixed",
      "right:18px",
      "bottom:18px",
      "z-index:2147483646",
      "max-width:340px",
      "padding:11px 14px",
      "border-radius:9px",
      "background:#202124",
      "color:white",
      "box-shadow:0 4px 18px rgba(0,0,0,.28)",
      "font:600 13px/1.35 system-ui,sans-serif",
      "transition:opacity 250ms ease"
    ].join(";");
    document.documentElement.appendChild(host);
    window.setTimeout(() => {
      host.style.opacity = "0";
      window.setTimeout(() => host.remove(), 300);
    }, 4500);
  }

  function renderDiff(diff, context) {
    if (observer) {
      observer.disconnect();
    }
    clearHighlights();
    ensureHighlightStyle();
    diff.added.forEach((item) => highlight(item, "added"));
    diff.updated.forEach(({ after }) => highlight(after, "updated"));
    createPanel(diff, context);
    observeCourse();
  }

  async function scanCourse({ establishBaseline = false } = {}) {
    const context = getCourseContext();
    if (!settings.changedSinceLastVisit || !context) {
      return;
    }

    const snapshot = captureSnapshot(context);
    if (!snapshot.items.length) {
      return;
    }
    currentSnapshot = snapshot;

    if (!baselineSnapshot || establishBaseline) {
      const snapshots = await getSnapshots();
      baselineSnapshot = snapshots[context.storageKey] || null;
    }

    if (!baselineSnapshot) {
      baselineSnapshot = await saveSnapshot(context, currentSnapshot);
      showFirstVisitToast(
        "Moodle Utils is now watching this course for changes."
      );
      return;
    }

    const migration = core.migrateLegacyUntitledSections?.(
      baselineSnapshot,
      currentSnapshot
    );
    if (migration?.changed) {
      baselineSnapshot = await saveSnapshot(context, migration.snapshot);
    }

    renderDiff(core.diffSnapshots(baselineSnapshot, currentSnapshot), context);
  }

  function scheduleScan() {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(() => {
      void scanCourse();
    }, 900);
  }

  function observeCourse() {
    observer?.disconnect();
    if (!settings.changedSinceLastVisit || !getCourseContext()) {
      observer = null;
      return;
    }

    observer = new MutationObserver((mutations) => {
      const meaningful = mutations.some(
        (mutation) =>
          !mutation.target.closest?.(`#${PANEL_ID}`) &&
          !mutation.target.closest?.(".moodle-utils-change-label")
      );
      if (meaningful) {
        scheduleScan();
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function disable() {
    observer?.disconnect();
    observer = null;
    window.clearTimeout(scanTimer);
    clearHighlights();
    removePanel();
  }

  async function enable() {
    if (!getCourseContext()) {
      return;
    }
    observeCourse();
    await scanCourse({ establishBaseline: true });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "SETTINGS_UPDATED") {
      return;
    }

    const wasEnabled = settings.changedSinceLastVisit;
    settings = { ...DEFAULT_SETTINGS, ...(message.settings || {}) };
    if (wasEnabled && !settings.changedSinceLastVisit) {
      disable();
    } else if (!wasEnabled && settings.changedSinceLastVisit) {
      void enable();
    }
    sendResponse({ ok: true });
  });

  void chrome.runtime
    .sendMessage({ type: "GET_SETTINGS" })
    .then((storedSettings) => {
      settings = { ...DEFAULT_SETTINGS, ...(storedSettings || {}) };
      if (settings.changedSinceLastVisit) {
        return enable();
      }
      return null;
    })
    .catch(() => {
      // Extension reloads can briefly invalidate the message channel.
    });
})();

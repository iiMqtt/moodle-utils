(() => {
  "use strict";

  if (globalThis.__moodleUtilsCourseTabManagerLoaded) {
    return;
  }
  globalThis.__moodleUtilsCourseTabManagerLoaded = true;

  const core = globalThis.MoodleUtilsTabManagerCore;
  if (!core) {
    return;
  }

  const DEFAULT_MAIN_SETTINGS = {
    keepalive: true,
    ltiAutoClose: true,
    sessionRecovery: true,
    changedSinceLastVisit: true,
    courseTabManager: true
  };
  const DEFAULT_MANAGER_SETTINGS = {
    autoGroup: true,
    shortenTitles: true,
    preventDuplicates: true,
    moveExistingGroups: false,
    allWindows: false,
    groupColor: "auto"
  };
  const ORIGINAL_TITLE_ATTRIBUTE = "data-moodle-utils-original-title";
  const savedOriginalTitle = document.documentElement.getAttribute(
    ORIGINAL_TITLE_ATTRIBUTE
  );
  const originalTitle = savedOriginalTitle || document.title;
  if (!savedOriginalTitle) {
    document.documentElement.setAttribute(
      ORIGINAL_TITLE_ATTRIBUTE,
      originalTitle
    );
  }
  let mainSettings = { ...DEFAULT_MAIN_SETTINGS };
  let managerSettings = { ...DEFAULT_MANAGER_SETTINGS };
  let dirty = false;
  let lastContext = null;

  function isEditableControl(element) {
    if (!(element instanceof Element)) {
      return false;
    }
    const control = element.closest(
      "textarea, [contenteditable='true'], input, select"
    );
    if (!control) {
      return false;
    }
    if (control.matches("input[type='hidden'], input[type='button'], input[type='submit'], input[type='reset'], input[type='search']")) {
      return false;
    }
    return true;
  }

  function hasEditableForm() {
    return Boolean(
      document.querySelector(
        [
          "textarea",
          "[contenteditable='true']",
          "input:not([type])",
          "input[type='text']",
          "input[type='email']",
          "input[type='number']",
          "input[type='file']",
          "input[type='checkbox']",
          "input[type='radio']",
          "select"
        ].join(",")
      )
    );
  }

  function courseLinks() {
    const breadcrumbLinks = [
      ...document.querySelectorAll(
        [
          ".breadcrumb a[href*='/course/view.php?id=']",
          "[data-region='breadcrumb'] a[href*='/course/view.php?id=']"
        ].join(",")
      )
    ];
    return breadcrumbLinks.length
      ? breadcrumbLinks
      : [...document.querySelectorAll("a[href*='/course/view.php?id=']")];
  }

  function identifyCourse() {
    const pageUrl = new URL(location.href);
    const isCoursePage = pageUrl.pathname === "/course/view.php";
    const bodyCourseId =
      document.body.className.match(/\bcourse-(\d+)\b/)?.[1] || "";
    let courseId = isCoursePage
      ? pageUrl.searchParams.get("id") || bodyCourseId
      : bodyCourseId;
    let courseName = "";

    for (const link of courseLinks()) {
      let linkUrl;
      try {
        linkUrl = new URL(link.href);
      } catch {
        continue;
      }
      const candidateId = linkUrl.searchParams.get("id");
      if (!candidateId) {
        continue;
      }
      if (!courseId) {
        courseId = candidateId;
      }
      if (candidateId === courseId) {
        courseName = core.cleanCourseName(
          link.getAttribute("title") || link.textContent
        );
        if (courseName) {
          break;
        }
      }
    }

    const heading = core.normaliseWhitespace(
      document.querySelector(".page-header-headings h1, h1")?.textContent
    );
    if (!courseName && isCoursePage) {
      courseName = core.cleanCourseName(heading || originalTitle);
    }
    const courseCode = core.extractCourseCode(
      courseName,
      heading,
      originalTitle
    );
    if (!courseId || (!courseCode && !courseName)) {
      return null;
    }

    const pageTitle = heading || originalTitle;
    return {
      courseId,
      courseCode,
      courseName:
        courseName || courseCode || `Moodle course ${courseId}`,
      groupTitle: core.groupTitle(courseCode, courseName, courseId),
      pageTitle,
      originalTitle,
      canonicalUrl: core.canonicaliseTabUrl(location.href),
      url: location.href,
      isCoursePage,
      hasEditableForm: hasEditableForm(),
      dirty
    };
  }

  function applyTitle() {
    if (
      !mainSettings.courseTabManager ||
      !managerSettings.shortenTitles ||
      !lastContext
    ) {
      document.title = originalTitle;
      return;
    }

    document.title = core.shortTabTitle(
      lastContext.courseCode,
      lastContext.courseName,
      lastContext.pageTitle,
      lastContext.isCoursePage
    );
  }

  async function reportContext() {
    lastContext = identifyCourse();
    applyTitle();
    if (!lastContext) {
      return null;
    }
    lastContext.dirty = dirty;
    lastContext.hasEditableForm = hasEditableForm();
    return chrome.runtime
      .sendMessage({
        type: "COURSE_TAB_CONTEXT",
        context: lastContext
      })
      .catch(() => null);
  }

  document.addEventListener(
    "input",
    (event) => {
      if (isEditableControl(event.target)) {
        dirty = true;
      }
    },
    true
  );
  document.addEventListener(
    "change",
    (event) => {
      if (isEditableControl(event.target)) {
        dirty = true;
      }
    },
    true
  );

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "SETTINGS_UPDATED") {
      mainSettings = {
        ...DEFAULT_MAIN_SETTINGS,
        ...(message.settings || {})
      };
      applyTitle();
      void reportContext().then(() => sendResponse({ ok: true }));
      return true;
    }

    if (message?.type === "TAB_MANAGER_SETTINGS_UPDATED") {
      managerSettings = {
        ...DEFAULT_MANAGER_SETTINGS,
        ...(message.settings || {})
      };
      applyTitle();
      void reportContext().then(() => sendResponse({ ok: true }));
      return true;
    }

    if (message?.type === "GET_COURSE_TAB_CONTEXT") {
      lastContext = identifyCourse();
      sendResponse(lastContext);
      return;
    }

    if (message?.type === "CHECK_TAB_SAFE_TO_CLOSE") {
      sendResponse({
        safe: !dirty && !hasEditableForm(),
        dirty,
        hasEditableForm: hasEditableForm()
      });
    }
  });

  void Promise.all([
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }),
    chrome.runtime.sendMessage({ type: "GET_TAB_MANAGER_SETTINGS" })
  ])
    .then(([storedMainSettings, storedManagerSettings]) => {
      mainSettings = {
        ...DEFAULT_MAIN_SETTINGS,
        ...(storedMainSettings || {})
      };
      managerSettings = {
        ...DEFAULT_MANAGER_SETTINGS,
        ...(storedManagerSettings || {})
      };
      return reportContext();
    })
    .catch(() => {
      // Extension reloads can briefly invalidate the message channel.
    });
})();

"use strict";

const DEFAULT_SETTINGS = {
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

const mainView = document.querySelector("#main-view");
const managerView = document.querySelector("#tab-manager-view");
const statusBox = document.querySelector(".status");
const statusTitle = document.querySelector("#status-title");
const statusDetail = document.querySelector("#status-detail");
const primaryAction = document.querySelector("#primary-action");
const saveState = document.querySelector("#save-state");
const settingInputs = [
  ...document.querySelectorAll(".main-features input")
];
const managerSettingInputs = [
  ...document.querySelectorAll("[data-manager-setting]")
];
const managerActionButtons = [
  ...document.querySelectorAll("[data-manager-action]")
];
const managerCourse = document.querySelector("#manager-course");
const managerCourseDetail = document.querySelector("#manager-course-detail");
const managerResult = document.querySelector("#manager-result");

let recoveryState = null;
let settings = { ...DEFAULT_SETTINGS };
let managerSettings = { ...DEFAULT_MANAGER_SETTINGS };
let managerStatus = null;
let saveTimer = null;

function renderSettings() {
  for (const input of settingInputs) {
    input.checked = settings[input.id] !== false;
  }
}

function renderStatus() {
  if (!settings.sessionRecovery) {
    statusBox.dataset.phase = "disabled";
    statusTitle.textContent = "Session recovery disabled";
    statusDetail.textContent =
      "The other enabled Moodle utilities will continue independently.";
    primaryAction.textContent = "Check Moodle now";
    primaryAction.disabled = true;
    return;
  }

  if (!recoveryState?.inProgress) {
    statusBox.dataset.phase = "ready";
    statusTitle.textContent = "Ready";
    statusDetail.textContent =
      recoveryState?.lastResult || "All enabled utilities are running.";
    primaryAction.textContent = "Check Moodle now";
    primaryAction.disabled = false;
    return;
  }

  if (
    recoveryState.phase === "needs_user" ||
    recoveryState.phase === "failed"
  ) {
    statusBox.dataset.phase = "attention";
    statusTitle.textContent = "Sign-in needed";
    statusDetail.textContent =
      "Finish signing in, then Moodle Utils will restore the affected pages.";
    primaryAction.textContent = "Open UNSW sign-in";
    primaryAction.disabled = false;
    return;
  }

  statusBox.dataset.phase = "working";
  statusTitle.textContent = "Reconnecting";
  statusDetail.textContent = "Restoring the Moodle session through UNSW…";
  primaryAction.textContent = "Open recovery tab";
  primaryAction.disabled = false;
}

function showSaved() {
  saveState.textContent = "Setting saved";
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveState.textContent = "";
  }, 1600);
}

function showManagerResult(detail, ok = true) {
  managerResult.textContent = detail || "";
  managerResult.dataset.state = ok ? "ok" : "error";
}

function renderManager() {
  for (const input of managerSettingInputs) {
    if (input instanceof HTMLSelectElement) {
      input.value = managerSettings[input.id] || "auto";
    } else {
      input.checked = managerSettings[input.id] !== false;
    }
    input.disabled = !settings.courseTabManager;
  }

  const context = managerStatus?.currentCourse;
  if (context) {
    managerCourse.textContent = context.groupTitle || context.courseCode;
    managerCourseDetail.textContent = `${managerStatus.tabCount} open tab${
      managerStatus.tabCount === 1 ? "" : "s"
    } for this course`;
  } else {
    managerCourse.textContent = "No Moodle course selected";
    managerCourseDetail.textContent =
      "Open a course tab to use course-specific actions.";
  }

  const lastWorkspace = managerStatus?.lastWorkspace;
  const restoreButton = document.querySelector("#restore-workspace");
  restoreButton.textContent = lastWorkspace
    ? `Restore ${lastWorkspace.groupTitle}`
    : "Restore workspace";

  for (const button of managerActionButtons) {
    const needsCourse =
      button.dataset.managerAction === "FOCUS_COURSE_TABS" ||
      button.dataset.managerAction === "CLOSE_COURSE_TABS";
    const needsWorkspace =
      button.dataset.managerAction === "RESTORE_COURSE_WORKSPACE";
    button.disabled =
      !settings.courseTabManager ||
      (needsCourse && !context) ||
      (needsWorkspace && !lastWorkspace);
  }
}

async function refresh() {
  const [storedSettings, storedRecoveryState] = await Promise.all([
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }),
    chrome.runtime.sendMessage({ type: "GET_STATUS" })
  ]);
  settings = { ...DEFAULT_SETTINGS, ...(storedSettings || {}) };
  recoveryState = storedRecoveryState;
  renderSettings();
  renderStatus();
}

async function refreshManager() {
  const [storedManagerSettings, storedManagerStatus] = await Promise.all([
    chrome.runtime.sendMessage({ type: "GET_TAB_MANAGER_SETTINGS" }),
    chrome.runtime.sendMessage({ type: "GET_TAB_MANAGER_STATUS" })
  ]);
  managerSettings = {
    ...DEFAULT_MANAGER_SETTINGS,
    ...(storedManagerSettings || {})
  };
  managerStatus = storedManagerStatus;
  renderManager();
}

for (const input of settingInputs) {
  input.addEventListener("change", async () => {
    input.disabled = true;
    settings = {
      ...settings,
      [input.id]: input.checked
    };
    settings = await chrome.runtime.sendMessage({
      type: "UPDATE_SETTINGS",
      settings: {
        [input.id]: input.checked
      }
    });
    input.disabled = false;
    showSaved();
    renderSettings();
    renderStatus();
  });
}

for (const input of managerSettingInputs) {
  input.addEventListener("change", async () => {
    input.disabled = true;
    const value =
      input instanceof HTMLSelectElement ? input.value : input.checked;
    managerSettings = {
      ...managerSettings,
      [input.id]: value
    };
    managerSettings = await chrome.runtime.sendMessage({
      type: "UPDATE_TAB_MANAGER_SETTINGS",
      settings: {
        [input.id]: value
      }
    });
    input.disabled = false;
    showManagerResult("Setting saved.");
    renderManager();
  });
}

for (const button of managerActionButtons) {
  button.addEventListener("click", async () => {
    const message = {
      type: button.dataset.managerAction
    };
    if (
      message.type === "RESTORE_COURSE_WORKSPACE" &&
      managerStatus?.lastWorkspace
    ) {
      message.courseId = managerStatus.lastWorkspace.courseId;
    }

    for (const actionButton of managerActionButtons) {
      actionButton.disabled = true;
    }
    showManagerResult("Working…");
    const result = await chrome.runtime.sendMessage(message);
    showManagerResult(
      result?.detail || (result?.ok ? "Done." : "The action could not finish."),
      result?.ok !== false
    );
    await refreshManager();
  });
}

document.querySelector("#open-tab-manager").addEventListener("click", async () => {
  mainView.hidden = true;
  managerView.hidden = false;
  showManagerResult("");
  await refreshManager();
});

document.querySelector("#close-tab-manager").addEventListener("click", () => {
  managerView.hidden = true;
  mainView.hidden = false;
});

primaryAction.addEventListener("click", async () => {
  primaryAction.disabled = true;

  if (recoveryState?.inProgress) {
    await chrome.runtime.sendMessage({ type: "FOCUS_AUTH_TAB" });
    window.close();
    return;
  }

  recoveryState = await chrome.runtime.sendMessage({ type: "CHECK_NOW" });
  renderStatus();
});

void refresh();

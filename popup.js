"use strict";

const DEFAULT_SETTINGS = {
  keepalive: true,
  ltiAutoClose: true,
  sessionRecovery: true,
  changedSinceLastVisit: true
};

const statusBox = document.querySelector(".status");
const statusTitle = document.querySelector("#status-title");
const statusDetail = document.querySelector("#status-detail");
const primaryAction = document.querySelector("#primary-action");
const saveState = document.querySelector("#save-state");
const settingInputs = [...document.querySelectorAll(".feature input")];

let recoveryState = null;
let settings = { ...DEFAULT_SETTINGS };
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

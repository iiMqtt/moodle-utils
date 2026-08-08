"use strict";

if (typeof importScripts === "function") {
  importScripts("tab-manager-core.js", "tab-manager-background.js");
}

const MOODLE_ORIGIN = "https://moodle.telt.unsw.edu.au";
const OIDC_URL = `${MOODLE_ORIGIN}/auth/oidc/?source=loginpage`;
const STATE_KEY = "moodleGuardianState";
const DESTINATIONS_KEY = "moodleGuardianDestinations";
const SETTINGS_KEY = "moodleUtilsSettings";
const INJECTED_VERSION_KEY = "moodleUtilsInjectedVersion";
const GUARDIAN_ALARM = "moodle-utils-guardian-check";
const LEGACY_GUARDIAN_ALARM = "moodle-guardian-keepalive";
const RECOVERY_TIMEOUT_ALARM = "moodle-guardian-recovery-timeout";
const GUARDIAN_CHECK_MINUTES = 4;
const GUARDIAN_STAGGER_MS = 12 * 1000;
const RECOVERY_TIMEOUT_MINUTES = 0.5;
const MAX_STATE_AGE_MS = 10 * 60 * 1000;
const FEEDBACK_POPUP_RULE_ID = 23001;
const DEFAULT_SETTINGS = Object.freeze({
  keepalive: true,
  ltiAutoClose: true,
  sessionRecovery: true,
  changedSinceLastVisit: true,
  courseTabManager: true,
  blockMyExperiencePopup: true
});

const tabManager = globalThis.MoodleUtilsCreateTabManager(chrome);
let authLaunchLock = false;
let completionLock = false;
let startSequence = Promise.resolve();

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(stored[SETTINGS_KEY] || {})
  };

  if (!stored[SETTINGS_KEY]) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  }

  return settings;
}

async function configureGuardianAlarm(settings = null) {
  const currentSettings = settings || (await getSettings());
  if (!currentSettings.sessionRecovery) {
    await chrome.alarms.clear(GUARDIAN_ALARM);
    return;
  }

  const existing = await chrome.alarms.get(GUARDIAN_ALARM);
  if (existing?.periodInMinutes === GUARDIAN_CHECK_MINUTES) {
    return;
  }

  await chrome.alarms.create(GUARDIAN_ALARM, {
    delayInMinutes: 0.5,
    periodInMinutes: GUARDIAN_CHECK_MINUTES
  });
}

async function configureFeedbackPopupRule(settings = null) {
  const currentSettings = settings || (await getSettings());
  const addRules = currentSettings.blockMyExperiencePopup
    ? [
        {
          id: FEEDBACK_POPUP_RULE_ID,
          priority: 1,
          action: { type: "block" },
          condition: {
            urlFilter:
              "||myexperience.unsw.edu.au/unswBlueConnector/*Scripts/Moodle/BlueMoodle.min.js",
            initiatorDomains: ["moodle.telt.unsw.edu.au"],
            resourceTypes: ["script"]
          }
        }
      ]
    : [];

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [FEEDBACK_POPUP_RULE_ID],
    addRules
  });
}

async function broadcastSettings(settings) {
  const tabs = await chrome.tabs.query({
    url: `${MOODLE_ORIGIN}/*`
  });
  await Promise.allSettled(
    tabs
      .filter((tab) => Number.isInteger(tab.id))
      .map((tab) =>
        chrome.tabs.sendMessage(tab.id, {
          type: "SETTINGS_UPDATED",
          settings
        })
      )
  );
}

function defaultState() {
  return {
    inProgress: false,
    authTabId: null,
    authLaunchCount: 0,
    startedAt: 0,
    phase: "idle",
    source: null,
    userTriggered: false,
    pending: {},
    lastResult: null,
    lastResultAt: 0
  };
}

async function getState() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  const state = { ...defaultState(), ...(stored[STATE_KEY] || {}) };
  state.pending = state.pending || {};

  if (state.inProgress && Date.now() - state.startedAt > MAX_STATE_AGE_MS) {
    if (Number.isInteger(state.authTabId)) {
      try {
        await chrome.tabs.remove(state.authTabId);
      } catch {
        // The stale recovery tab may no longer exist.
      }
    }
    return resetState("Recovery expired before it could finish.");
  }

  return state;
}

async function setState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
  await updateBadge(state);
  return state;
}

async function resetState(lastResult = null) {
  const state = {
    ...defaultState(),
    lastResult,
    lastResultAt: Date.now()
  };
  await chrome.storage.local.set({ [STATE_KEY]: state });
  await chrome.action.setBadgeText({ text: "" });
  await chrome.alarms.clear(RECOVERY_TIMEOUT_ALARM);
  return state;
}

async function updateBadge(state) {
  if (!state.inProgress) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }

  const needsUser = state.phase === "needs_user";
  await chrome.action.setBadgeBackgroundColor({
    color: needsUser ? "#d93025" : "#1976d2"
  });
  await chrome.action.setBadgeText({ text: needsUser ? "!" : "…" });
}

function isMoodleUrl(value) {
  try {
    return new URL(value).origin === MOODLE_ORIGIN;
  } catch {
    return false;
  }
}

function isLoginOrAuthUrl(value) {
  if (!isMoodleUrl(value)) {
    return false;
  }

  const url = new URL(value);
  return (
    url.pathname.startsWith("/login/") ||
    url.pathname.startsWith("/auth/oidc/")
  );
}

function isSafeDestination(value) {
  if (!isMoodleUrl(value) || isLoginOrAuthUrl(value)) {
    return false;
  }

  const url = new URL(value);
  return url.pathname !== "/login/logout.php";
}

function normaliseDestination(value) {
  if (!isSafeDestination(value)) {
    return null;
  }

  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase() === "sesskey") {
      url.searchParams.delete(key);
    }
  }
  return url.href;
}

async function getDestinations() {
  const stored = await chrome.storage.local.get(DESTINATIONS_KEY);
  return stored[DESTINATIONS_KEY] || {};
}

async function rememberDestination(tabId, url) {
  const destination = normaliseDestination(url);
  if (!Number.isInteger(tabId) || !destination) {
    return;
  }

  const destinations = await getDestinations();
  destinations[String(tabId)] = {
    url: destination,
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ [DESTINATIONS_KEY]: destinations });
}

async function forgetDestination(tabId) {
  const destinations = await getDestinations();
  delete destinations[String(tabId)];
  await chrome.storage.local.set({ [DESTINATIONS_KEY]: destinations });
}

async function resolveDestination(tabId, proposedUrl, referrer) {
  const proposedDestination = normaliseDestination(proposedUrl);
  if (proposedDestination) {
    return proposedDestination;
  }

  const referrerDestination = normaliseDestination(referrer);
  if (referrerDestination) {
    return referrerDestination;
  }

  const destinations = await getDestinations();
  const remembered = destinations[String(tabId)];
  return normaliseDestination(remembered?.url);
}

async function notifyPending(state, phase, detail) {
  const tabIds = Object.keys(state.pending).map(Number).filter(Number.isInteger);
  await Promise.allSettled(
    tabIds.map((tabId) =>
      chrome.tabs.sendMessage(tabId, {
        type: "RECOVERY_STATUS",
        phase,
        detail,
        authTabId: state.authTabId
      })
    )
  );
}

async function addPendingTab(state, tabId, url) {
  const destination = normaliseDestination(url);
  if (!Number.isInteger(tabId) || !destination) {
    return state;
  }

  state.pending[String(tabId)] = {
    url: destination,
    addedAt: Date.now()
  };
  await rememberDestination(tabId, destination);
  return state;
}

function startRecovery(options = {}) {
  const operation = startSequence.then(() => performStartRecovery(options));
  startSequence = operation.catch(() => undefined);
  return operation;
}

async function performStartRecovery({
  tabId = null,
  destination = null,
  source = "unknown",
  userTriggered = false
} = {}) {
  try {
    const settings = await getSettings();
    if (!settings.sessionRecovery) {
      return;
    }

    let state = await getState();

    if (state.inProgress) {
      if (Number.isInteger(tabId) && destination) {
        state = await addPendingTab(state, tabId, destination);
      }
      state.userTriggered = state.userTriggered || userTriggered;
      await setState(state);
      await notifyPending(state, state.phase, statusText(state.phase));

      if (state.phase === "needs_user" && state.userTriggered) {
        await focusAuthTab(state.authTabId);
      }
      return;
    }

    state = {
      ...defaultState(),
      inProgress: true,
      startedAt: Date.now(),
      phase: "opening_login",
      source,
      userTriggered,
      pending: {}
    };

    if (Number.isInteger(tabId) && destination) {
      state = await addPendingTab(state, tabId, destination);
    }

    await setState(state);
    await notifyPending(state, "opening_login", statusText("opening_login"));

    const authTab = await chrome.tabs.create({
      url: "about:blank",
      active: false
    });

    state.authTabId = authTab.id;
    state.phase = "opening_login";
    await setState(state);
    await notifyPending(state, state.phase, statusText(state.phase));
    await chrome.alarms.create(RECOVERY_TIMEOUT_ALARM, {
      delayInMinutes: RECOVERY_TIMEOUT_MINUTES
    });
    await launchOidc(state);
  } catch (error) {
    const state = await getState();
    await notifyPending(
      state,
      "failed",
      "Moodle could not be reconnected automatically. Open the extension to retry."
    );
    await resetState(error instanceof Error ? error.message : String(error));
  }
}

function statusText(phase) {
  switch (phase) {
    case "opening_login":
      return "Restoring your Moodle session…";
    case "signing_in":
      return "Signing in through UNSW…";
    case "needs_user":
      return "UNSW needs you to finish signing in.";
    case "restoring":
      return "Signed in. Returning you to your page…";
    case "failed":
      return "Moodle could not be reconnected automatically.";
    default:
      return "Checking your Moodle session…";
  }
}

async function launchOidc(state) {
  if (
    authLaunchLock ||
    !state.inProgress ||
    !Number.isInteger(state.authTabId)
  ) {
    return;
  }

  authLaunchLock = true;
  try {
    const latestState = await getState();
    if (
      !latestState.inProgress ||
      latestState.authTabId !== state.authTabId
    ) {
      return;
    }

    if (latestState.authLaunchCount >= 1) {
      await markNeedsUser(latestState);
      return;
    }

    latestState.authLaunchCount += 1;
    latestState.phase = "signing_in";
    await setState(latestState);
    await notifyPending(
      latestState,
      latestState.phase,
      statusText(latestState.phase)
    );

    await chrome.tabs.update(state.authTabId, {
      url: OIDC_URL,
      active: false
    });
  } catch (error) {
    await failRecovery(
      state,
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    authLaunchLock = false;
  }
}

async function markNeedsUser(state) {
  if (!state.inProgress) {
    return;
  }

  state.phase = "needs_user";
  await setState(state);
  await notifyPending(state, state.phase, statusText(state.phase));

  if (state.userTriggered) {
    await focusAuthTab(state.authTabId);
  }
}

async function focusAuthTab(authTabId) {
  if (!Number.isInteger(authTabId)) {
    return;
  }

  try {
    const tab = await chrome.tabs.get(authTabId);
    await chrome.tabs.update(authTabId, { active: true });
    if (Number.isInteger(tab.windowId)) {
      await chrome.windows?.update?.(tab.windowId, { focused: true });
    }
  } catch {
    // The recovery tab may already have closed.
  }
}

async function completeRecovery(state) {
  if (completionLock || !state.inProgress) {
    return;
  }

  completionLock = true;
  try {
    const latestState = await getState();
    if (!latestState.inProgress) {
      return;
    }

    latestState.phase = "restoring";
    await setState(latestState);
    await notifyPending(
      latestState,
      latestState.phase,
      statusText(latestState.phase)
    );

    const authTabId = latestState.authTabId;
    const pendingEntries = Object.entries(latestState.pending);

    for (const [tabIdText, pending] of pendingEntries) {
      const tabId = Number(tabIdText);
      const destination = normaliseDestination(pending.url);
      if (!Number.isInteger(tabId) || !destination) {
        continue;
      }

      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.url === destination) {
          await chrome.tabs.reload(tabId);
        } else {
          await chrome.tabs.update(tabId, { url: destination });
        }
      } catch {
        // A tab closed while authentication was in progress.
      }
    }

    await notifyPending(
      latestState,
      "complete",
      "Moodle restored. Returning you to your page…"
    );

    if (
      Number.isInteger(authTabId) &&
      !latestState.pending[String(authTabId)]
    ) {
      try {
        await chrome.tabs.remove(authTabId);
      } catch {
        // It may have been closed manually.
      }
    }

    await resetState("Moodle session restored.");
    await probeMoodleSession({ delayMs: 0, announce: true });
  } finally {
    completionLock = false;
  }
}

async function validateRecoveryTab() {
  const state = await getState();
  if (!state.inProgress) {
    return;
  }

  if (state.phase === "restoring") {
    await completeRecovery(state);
    return;
  }

  let tabExists = false;
  if (Number.isInteger(state.authTabId)) {
    try {
      await chrome.tabs.get(state.authTabId);
      tabExists = true;
    } catch {
      // Restart the interrupted recovery below.
    }
  }

  if (tabExists) {
    return;
  }

  const pending = { ...state.pending };
  const source = state.source || "startup_recovery";
  const userTriggered = state.userTriggered;
  await resetState("Previous recovery was interrupted.");

  const firstPending = Object.entries(pending)[0];
  if (firstPending) {
    await startRecovery({
      tabId: Number(firstPending[0]),
      destination: firstPending[1]?.url,
      source,
      userTriggered
    });
    const restarted = await getState();
    for (const [tabIdText, item] of Object.entries(pending).slice(1)) {
      await addPendingTab(restarted, Number(tabIdText), item?.url);
    }
    await setState(restarted);
  }
}

async function finishTabRemoval(tabId) {
  const state = await getState();
  delete state.pending[String(tabId)];

  if (
    state.inProgress &&
    tabId === state.authTabId &&
    state.phase !== "restoring"
  ) {
    await notifyPending(
      state,
      "failed",
      "The UNSW sign-in tab was closed before Moodle reconnected."
    );
    await resetState("Sign-in tab closed.");
    return;
  }

  await setState(state);
}

async function failRecovery(state, detail) {
  state.phase = "failed";
  await setState(state);
  await notifyPending(
    state,
    state.phase,
    "Moodle could not be reconnected automatically. Open the sign-in tab to continue."
  );
  state.lastResult = detail;
  state.lastResultAt = Date.now();
  await setState(state);
}

async function handlePageState(message, sender) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) {
    return { managed: false };
  }

  const settings = await getSettings();
  if (!settings.sessionRecovery) {
    return { managed: false, disabled: true };
  }

  let state = await getState();
  const isAuthTab = state.inProgress && tabId === state.authTabId;

  if (message.state === "login_required") {
    if (isAuthTab) {
      await launchOidc(state);
      return { managed: true, phase: "signing_in" };
    }

    const destination = await resolveDestination(
      tabId,
      message.url,
      message.referrer
    );
    await startRecovery({
      tabId,
      destination,
      source: "expired_page",
      userTriggered: true
    });
    state = await getState();
    return {
      managed: true,
      phase: state.phase,
      detail: statusText(state.phase)
    };
  }

  if (message.state === "login_page") {
    if (isAuthTab) {
      await launchOidc(state);
      return { managed: true, phase: "signing_in" };
    }

    if (message.loginRedirect) {
      const destination = await resolveDestination(
        tabId,
        null,
        message.referrer
      );
      await startRecovery({
        tabId,
        destination,
        source: "redirected_login",
        userTriggered: true
      });
      state = await getState();
      return {
        managed: true,
        phase: state.phase,
        detail: statusText(state.phase)
      };
    }
  }

  if (
    message.state === "authenticated" &&
    (isAuthTab ||
      (state.inProgress &&
        (state.phase === "restoring" || state.pending[String(tabId)])))
  ) {
    await completeRecovery(state);
    return { managed: true, phase: "complete" };
  }

  if (message.state === "authenticated" && isSafeDestination(message.url)) {
    await rememberDestination(tabId, message.url);
  }

  return { managed: false };
}

async function probeMoodleSession({
  delayMs = GUARDIAN_STAGGER_MS,
  announce = true
} = {}) {
  const settings = await getSettings();
  if (!settings.sessionRecovery) {
    return;
  }

  const state = await getState();
  if (state.inProgress) {
    return;
  }

  const tabs = await chrome.tabs.query({
    url: `${MOODLE_ORIGIN}/*`
  });

  const candidates = tabs
    .filter((tab) => Number.isInteger(tab.id) && !isLoginOrAuthUrl(tab.url))
    .sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));

  for (const tab of candidates) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, {
        type: "CHECK_SESSION",
        delayMs,
        announce
      });

      if (result?.status === "authenticated") {
        return;
      }

      if (result?.status === "logged_out") {
        await startRecovery({
          source: "keepalive_probe",
          userTriggered: false
        });
        return;
      }
    } catch {
      // Discarded or not-yet-injected tabs are skipped.
    }
  }
}

async function injectIntoExistingMoodleTabs() {
  const tabs = await chrome.tabs.query({
    url: `${MOODLE_ORIGIN}/*`
  });

  await Promise.allSettled(
    tabs
      .filter((tab) => Number.isInteger(tab.id))
      .flatMap((tab) => {
        const injections = [
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["feedback-popup-blocker.js"],
            world: "ISOLATED"
          }),
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["tab-manager-core.js", "course-tab-manager.js"],
            world: "ISOLATED"
          }),
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["change-detector-core.js", "changed-since-last-visit.js"],
            world: "ISOLATED"
          }),
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content.js"],
            world: "ISOLATED"
          }),
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["keepalive.js"],
            world: "MAIN"
          })
        ];

        if (
          tab.url?.includes("/mod/lti/launch.php") ||
          tab.url?.includes("/mod/lti/view.php")
        ) {
          injections.push(
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ["lti-autoclose.js"],
              world: "ISOLATED"
            })
          );
        }

        return injections;
      })
  );

  await broadcastSettings(await getSettings());
}

async function ensureCurrentBuildInjected() {
  const version = chrome.runtime.getManifest().version;
  const stored = await chrome.storage.local.get(INJECTED_VERSION_KEY);
  if (stored[INJECTED_VERSION_KEY] === version) {
    return;
  }

  await injectIntoExistingMoodleTabs();
  await chrome.storage.local.set({ [INJECTED_VERSION_KEY]: version });
}

async function initialise() {
  const settings = await getSettings();
  await chrome.alarms.clear(LEGACY_GUARDIAN_ALARM);
  await configureGuardianAlarm(settings);
  await configureFeedbackPopupRule(settings);
  await tabManager.initialise();
  await getState();
  await validateRecoveryTab();
  await ensureCurrentBuildInjected();
}

chrome.runtime.onInstalled.addListener(() => {
  void initialise();
  void injectIntoExistingMoodleTabs();
});

chrome.runtime.onStartup.addListener(() => {
  void initialise();
  void injectIntoExistingMoodleTabs();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === GUARDIAN_ALARM) {
    void probeMoodleSession();
    return;
  }

  if (alarm.name === RECOVERY_TIMEOUT_ALARM) {
    void (async () => {
      const state = await getState();
      if (state.inProgress) {
        await markNeedsUser(state);
      }
    })();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[SETTINGS_KEY]) {
    return;
  }

  void (async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      ...(changes[SETTINGS_KEY].newValue || {})
    };
    await configureGuardianAlarm(settings);
    await configureFeedbackPopupRule(settings);
    await broadcastSettings(settings);
  })();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  tabManager.onTabUpdated(tabId, changeInfo, tab);

  if (changeInfo.url && isSafeDestination(changeInfo.url)) {
    void rememberDestination(tabId, changeInfo.url);
  }

  void (async () => {
    const state = await getState();
    if (!state.inProgress || tabId !== state.authTabId) {
      return;
    }

    if (changeInfo.url && !isMoodleUrl(changeInfo.url)) {
      state.phase = "signing_in";
      await setState(state);
      await notifyPending(state, state.phase, statusText(state.phase));
      return;
    }

    if (changeInfo.status === "complete" && isMoodleUrl(tab.url)) {
      try {
        await chrome.tabs.sendMessage(tabId, { type: "REPORT_PAGE_STATE" });
      } catch {
        // The content script will report itself when it is ready.
      }
    }
  })();
});

chrome.tabs.onCreated.addListener((tab) => {
  tabManager.onTabCreated(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabManager.onTabRemoved(tabId);
  void forgetDestination(tabId);
  void finishTabRemoval(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    switch (message?.type) {
      case "PAGE_STATE":
        sendResponse(await handlePageState(message, sender));
        break;
      case "SESSION_PROBE_RESULT":
        if (message.status === "logged_out") {
          await startRecovery({
            source: "keepalive_probe",
            userTriggered: false
          });
        }
        sendResponse({ ok: true });
        break;
      case "GET_STATUS":
        sendResponse(await getState());
        break;
      case "GET_SETTINGS":
        sendResponse(await getSettings());
        break;
      case "COURSE_TAB_CONTEXT":
        sendResponse(await tabManager.onCourseContext(message, sender));
        break;
      case "GET_TAB_MANAGER_SETTINGS":
        sendResponse(await tabManager.getSettings());
        break;
      case "UPDATE_TAB_MANAGER_SETTINGS":
        sendResponse(await tabManager.updateSettings(message.settings));
        break;
      case "GET_TAB_MANAGER_STATUS":
        sendResponse(await tabManager.getStatus());
        break;
      case "ORGANISE_COURSE_TABS":
        sendResponse(await tabManager.organiseOpenTabs());
        break;
      case "FOCUS_COURSE_TABS":
        sendResponse(await tabManager.focusCourseTabs());
        break;
      case "CLOSE_COURSE_TABS":
        sendResponse(await tabManager.closeCourseTabs());
        break;
      case "RESTORE_COURSE_WORKSPACE":
        sendResponse(
          await tabManager.restoreWorkspace(message.courseId || null)
        );
        break;
      case "UPDATE_SETTINGS": {
        const current = await getSettings();
        const settings = {
          ...current,
          ...(message.settings || {})
        };
        await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
        sendResponse(settings);
        break;
      }
      case "CHECK_NOW":
        await probeMoodleSession({ delayMs: 0, announce: true });
        sendResponse(await getState());
        break;
      case "RECONNECT_NOW":
        await startRecovery({
          source: "manual",
          userTriggered: true
        });
        sendResponse(await getState());
        break;
      case "FOCUS_AUTH_TAB": {
        const state = await getState();
        await focusAuthTab(state.authTabId);
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false });
    }
  })();
  return true;
});

void initialise();

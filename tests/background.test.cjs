"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function eventStub() {
  return { addListener() {} };
}

function createHarness() {
  const storage = {};
  const tabRecords = new Map([
    [
      41,
      {
        id: 41,
        windowId: 1,
        groupId: -1,
        url: "https://moodle.telt.unsw.edu.au/course/view.php?id=99647"
      }
    ]
  ]);
  const createdTabs = [];
  const updatedTabs = [];
  const reloadedTabs = [];
  const removedTabs = [];
  const sentMessages = [];
  const dynamicRuleUpdates = [];
  let nextTabId = 900;

  const chrome = {
    action: {
      async setBadgeBackgroundColor() {},
      async setBadgeText() {}
    },
    alarms: {
      onAlarm: eventStub(),
      async clear() {
        return true;
      },
      async create() {},
      async get() {
        return undefined;
      }
    },
    declarativeNetRequest: {
      async updateDynamicRules(options) {
        dynamicRuleUpdates.push(options);
      }
    },
    runtime: {
      getManifest() {
        return { version: "2.3.5" };
      },
      onInstalled: eventStub(),
      onMessage: eventStub(),
      onStartup: eventStub()
    },
    scripting: {
      async executeScript() {}
    },
    storage: {
      onChanged: eventStub(),
      local: {
        async get(key) {
          if (typeof key === "string") {
            return { [key]: storage[key] };
          }
          return { ...storage };
        },
        async set(values) {
          Object.assign(storage, values);
        }
      }
    },
    tabs: {
      onCreated: eventStub(),
      onRemoved: eventStub(),
      onUpdated: eventStub(),
      async create(options) {
        const tab = {
          id: nextTabId++,
          windowId: 1,
          groupId: -1,
          url: options.url,
          active: options.active
        };
        tabRecords.set(tab.id, tab);
        createdTabs.push({ ...tab });
        return tab;
      },
      async get(tabId) {
        const tab = tabRecords.get(tabId);
        if (!tab) {
          throw new Error("No tab");
        }
        return { ...tab };
      },
      async query() {
        return [];
      },
      async remove(tabId) {
        const tabIds = Array.isArray(tabId) ? tabId : [tabId];
        for (const id of tabIds) {
          removedTabs.push(id);
          tabRecords.delete(id);
        }
      },
      async group() {
        return 1;
      },
      async reload(tabId) {
        reloadedTabs.push(tabId);
      },
      async sendMessage(tabId, message) {
        sentMessages.push({ tabId, message });
        return { ok: true };
      },
      async update(tabId, changes) {
        const tab = tabRecords.get(tabId);
        if (!tab) {
          throw new Error("No tab");
        }
        Object.assign(tab, changes);
        updatedTabs.push({ tabId, changes: { ...changes } });
        return { ...tab };
      }
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      async query() {
        return [];
      },
      async update() {}
    },
    windows: {
      async update() {}
    }
  };

  const context = vm.createContext({
    chrome,
    console,
    URL,
    setTimeout,
    clearTimeout
  });
  for (const filename of [
    "tab-manager-core.js",
    "tab-manager-background.js",
    "background.js"
  ]) {
    const source = fs.readFileSync(
      path.join(__dirname, "..", filename),
      "utf8"
    );
    vm.runInContext(source, context, { filename });
  }

  return {
    context,
    storage,
    createdTabs,
    tabRecords,
    updatedTabs,
    reloadedTabs,
    removedTabs,
    sentMessages,
    dynamicRuleUpdates
  };
}

async function run() {
  const harness = createHarness();
  const {
    context,
    storage,
    createdTabs,
    tabRecords,
    updatedTabs,
    reloadedTabs,
    removedTabs,
    sentMessages,
    dynamicRuleUpdates
  } = harness;

  const defaultSettings = await context.getSettings();
  assert.equal(defaultSettings.changedSinceLastVisit, true);
  assert.equal(defaultSettings.courseTabManager, true);
  assert.equal(defaultSettings.blockMyExperiencePopup, true);

  await context.configureFeedbackPopupRule({
    blockMyExperiencePopup: true
  });
  const enabledRuleUpdate = dynamicRuleUpdates.find(
    (update) => update.addRules.length === 1
  );
  assert.ok(enabledRuleUpdate);
  assert.match(
    enabledRuleUpdate.addRules[0].condition.urlFilter,
    /BlueMoodle\.min\.js/
  );
  await context.configureFeedbackPopupRule({
    blockMyExperiencePopup: false
  });
  assert.equal(
    dynamicRuleUpdates.some((update) => update.addRules.length === 0),
    true
  );

  assert.equal(
    context.normaliseDestination(
      "https://moodle.telt.unsw.edu.au/mod/choice/view.php?id=1&sesskey=secret#answer"
    ),
    "https://moodle.telt.unsw.edu.au/mod/choice/view.php?id=1#answer"
  );
  assert.equal(
    context.normaliseDestination("https://example.com/course/view.php?id=1"),
    null
  );
  assert.equal(
    context.normaliseDestination(
      "https://moodle.telt.unsw.edu.au/login/index.php"
    ),
    null
  );

  const intendedUrl =
    "https://moodle.telt.unsw.edu.au/course/view.php?id=99647&sesskey=secret#section-10";
  await context.handlePageState(
    {
      state: "login_required",
      url: intendedUrl,
      referrer: ""
    },
    { tab: { id: 41 } }
  );

  let state = storage.moodleGuardianState;
  assert.equal(state.inProgress, true);
  assert.equal(state.pending["41"].url.includes("sesskey"), false);
  assert.equal(state.pending["41"].url.endsWith("#section-10"), true);
  assert.equal(createdTabs.length, 1);
  assert.equal(createdTabs[0].url, "about:blank");

  const authTabId = state.authTabId;
  await context.handlePageState(
    {
      state: "login_page",
      url: "https://moodle.telt.unsw.edu.au/login/index.php?loginredirect=1",
      referrer: "",
      loginRedirect: true
    },
    { tab: { id: authTabId } }
  );
  assert.equal(
    updatedTabs.some(
      (update) =>
        update.tabId === authTabId &&
        update.changes.url ===
          "https://moodle.telt.unsw.edu.au/auth/oidc/?source=loginpage"
    ),
    true
  );

  const restoredUrl =
    "https://moodle.telt.unsw.edu.au/course/view.php?id=99647#section-10";
  tabRecords.get(41).url = restoredUrl;

  await context.handlePageState(
    {
      state: "authenticated",
      url: "https://moodle.telt.unsw.edu.au/my/"
    },
    { tab: { id: authTabId } }
  );

  state = storage.moodleGuardianState;
  assert.equal(state.inProgress, false);
  assert.equal(reloadedTabs.includes(41), true);
  assert.equal(
    sentMessages.some(
      ({ tabId, message }) =>
        tabId === 41 &&
        message.type === "RECOVERY_STATUS" &&
        message.phase === "complete"
    ),
    true
  );
  assert.deepEqual(removedTabs, [authTabId]);

  storage.moodleGuardianState = {
    ...storage.moodleGuardianState,
    inProgress: true,
    startedAt: Date.now(),
    phase: "restoring",
    authTabId: null,
    pending: {
      "41": { url: restoredUrl, addedAt: Date.now() }
    }
  };
  await context.validateRecoveryTab();
  assert.equal(storage.moodleGuardianState.inProgress, false);
  assert.equal(reloadedTabs.filter((tabId) => tabId === 41).length, 2);

  tabRecords.set(42, {
    id: 42,
    windowId: 1,
    url: "https://moodle.telt.unsw.edu.au/mod/lti/launch.php?id=55"
  });
  const closedLti = await context.closeLtiLaunchTab(tabRecords.get(42));
  assert.equal(closedLti.closed, true);
  assert.equal(tabRecords.has(42), false);

  storage.moodleUtilsSettings = {
    keepalive: true,
    ltiAutoClose: true,
    sessionRecovery: false
  };
  const createdBeforeDisabledCheck = createdTabs.length;
  const disabledResult = await context.handlePageState(
    {
      state: "login_required",
      url: "https://moodle.telt.unsw.edu.au/course/view.php?id=123",
      referrer: ""
    },
    { tab: { id: 41 } }
  );
  assert.equal(disabledResult.disabled, true);
  assert.equal(createdTabs.length, createdBeforeDisabledCheck);

  process.stdout.write("background recovery tests passed\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

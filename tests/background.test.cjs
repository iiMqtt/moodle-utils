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
        url: "https://moodle.telt.unsw.edu.au/course/view.php?id=99647"
      }
    ]
  ]);
  const createdTabs = [];
  const updatedTabs = [];
  const removedTabs = [];
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
    runtime: {
      getManifest() {
        return { version: "2.0.0" };
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
      onRemoved: eventStub(),
      onUpdated: eventStub(),
      async create(options) {
        const tab = {
          id: nextTabId++,
          windowId: 1,
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
        removedTabs.push(tabId);
        tabRecords.delete(tabId);
      },
      async sendMessage() {
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
  const source = fs.readFileSync(
    path.join(__dirname, "..", "background.js"),
    "utf8"
  );
  vm.runInContext(source, context, { filename: "background.js" });

  return {
    context,
    storage,
    createdTabs,
    updatedTabs,
    removedTabs
  };
}

async function run() {
  const harness = createHarness();
  const { context, storage, createdTabs, updatedTabs, removedTabs } = harness;

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

  await context.handlePageState(
    {
      state: "authenticated",
      url: "https://moodle.telt.unsw.edu.au/my/"
    },
    { tab: { id: authTabId } }
  );

  state = storage.moodleGuardianState;
  assert.equal(state.inProgress, false);
  assert.equal(
    updatedTabs.some(
      (update) =>
        update.tabId === 41 &&
        update.changes.url ===
          "https://moodle.telt.unsw.edu.au/course/view.php?id=99647#section-10"
    ),
    true
  );
  assert.deepEqual(removedTabs, [authTabId]);

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

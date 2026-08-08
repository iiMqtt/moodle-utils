"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadTabManager(chrome) {
  const context = vm.createContext({
    chrome,
    console,
    Date,
    Map,
    Math,
    Object,
    Promise,
    Set,
    String,
    URL,
    globalThis: null
  });
  context.globalThis = context;
  for (const filename of [
    "tab-manager-core.js",
    "tab-manager-background.js"
  ]) {
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, "..", filename), "utf8"),
      context,
      { filename }
    );
  }
  return {
    core: context.MoodleUtilsTabManagerCore,
    manager: context.MoodleUtilsCreateTabManager(chrome)
  };
}

function createHarness() {
  const storage = {};
  const tabs = new Map();
  const groups = new Map();
  const removed = [];
  const focused = [];
  let nextGroupId = 50;

  function matches(tab, query) {
    if (Number.isInteger(query.windowId) && tab.windowId !== query.windowId) {
      return false;
    }
    if (query.active !== undefined && tab.active !== query.active) {
      return false;
    }
    if (query.currentWindow && tab.windowId !== 1) {
      return false;
    }
    if (
      query.url &&
      !tab.url.startsWith(String(query.url).replace("*", ""))
    ) {
      return false;
    }
    return true;
  }

  const chrome = {
    storage: {
      local: {
        async get(key) {
          return typeof key === "string"
            ? { [key]: storage[key] }
            : { ...storage };
        },
        async set(values) {
          Object.assign(storage, values);
        }
      }
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      async query({ windowId }) {
        return [...groups.values()].filter(
          (group) => group.windowId === windowId
        );
      },
      async update(groupId, changes) {
        const group = groups.get(groupId);
        Object.assign(group, changes);
        return { ...group };
      }
    },
    tabs: {
      async create(options) {
        const id = Math.max(0, ...tabs.keys()) + 1;
        const tab = {
          id,
          windowId: options.windowId || 1,
          groupId: -1,
          active: options.active !== false,
          pinned: false,
          title: "Moodle",
          url: options.url
        };
        tabs.set(id, tab);
        return { ...tab };
      },
      async get(tabId) {
        const tab = tabs.get(tabId);
        if (!tab) {
          throw new Error("Missing tab");
        }
        return { ...tab };
      },
      async group(options) {
        let groupId = options.groupId;
        if (!Number.isInteger(groupId)) {
          groupId = nextGroupId++;
          groups.set(groupId, {
            id: groupId,
            windowId: options.createProperties.windowId,
            title: "",
            color: "grey",
            collapsed: false,
            shared: false
          });
        }
        for (const tabId of options.tabIds) {
          tabs.get(tabId).groupId = groupId;
        }
        return groupId;
      },
      async query(query = {}) {
        return [...tabs.values()]
          .filter((tab) => matches(tab, query))
          .map((tab) => ({ ...tab }));
      },
      async remove(tabIds) {
        for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
          removed.push(tabId);
          tabs.delete(tabId);
        }
      },
      async sendMessage(tabId, message) {
        if (message.type === "CHECK_TAB_SAFE_TO_CLOSE") {
          const tab = tabs.get(tabId);
          return {
            safe: tab?.safe !== false && tab?.dirty !== true,
            safeUserInitiated: tab?.dirty !== true
          };
        }
        return null;
      },
      async update(tabId, changes) {
        Object.assign(tabs.get(tabId), changes);
        if (changes.active) {
          focused.push(tabId);
        }
        return { ...tabs.get(tabId) };
      }
    },
    windows: {
      async update() {}
    }
  };

  return { chrome, focused, groups, removed, storage, tabs };
}

async function run() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")
  );
  assert.equal(manifest.version, "2.3.4");
  const ltiScript = manifest.content_scripts.find((entry) =>
    entry.js.includes("lti-autoclose.js")
  );
  assert.equal(ltiScript.run_at, "document_start");
  assert.equal(manifest.permissions.includes("tabGroups"), true);
  assert.equal(
    manifest.permissions.includes("declarativeNetRequest"),
    true
  );
  assert.equal(
    manifest.content_scripts.some((entry) =>
      entry.js.includes("course-tab-manager.js")
    ),
    true
  );
  assert.equal(
    manifest.content_scripts.some(
      (entry) =>
        entry.run_at === "document_start" &&
        entry.js.includes("feedback-popup-blocker.js")
    ),
    true
  );

  const popupHtml = fs.readFileSync(
    path.join(__dirname, "..", "popup.html"),
    "utf8"
  );
  for (const controlId of [
    "courseTabManager",
    "blockMyExperiencePopup",
    "autoGroup",
    "shortenTitles",
    "preventDuplicates",
    "moveExistingGroups",
    "allWindows",
    "groupColor"
  ]) {
    assert.match(popupHtml, new RegExp(`id="${controlId}"`));
  }

  const harness = createHarness();
  const { core, manager } = loadTabManager(harness.chrome);

  assert.equal(core.extractCourseCode("Course: elec2133"), "ELEC2133");
  assert.equal(
    core.canonicaliseTabUrl(
      "https://moodle.telt.unsw.edu.au/mod/page/view.php?z=2&sesskey=secret&id=4&notify=1#answer"
    ),
    "https://moodle.telt.unsw.edu.au/mod/page/view.php?id=4&z=2#answer"
  );
  assert.equal(
    core.shortTabTitle(
      "ELEC2133",
      "ELEC2133 - Analogue Electronics",
      "Week 8 Quiz | UNSW",
      false
    ),
    "ELEC2133 · Week 8 Quiz"
  );

  harness.groups.set(7, {
    id: 7,
    windowId: 1,
    title: "ELEC2133",
    color: "blue",
    collapsed: false,
    shared: false
  });
  harness.tabs.set(1, {
    id: 1,
    windowId: 1,
    groupId: 7,
    active: false,
    pinned: false,
    safe: true,
    title: "Existing",
    url: "https://moodle.telt.unsw.edu.au/mod/page/view.php?id=4"
  });
  harness.tabs.set(2, {
    id: 2,
    windowId: 1,
    groupId: -1,
    active: true,
    pinned: false,
    safe: true,
    title: "Duplicate",
    url: "https://moodle.telt.unsw.edu.au/mod/page/view.php?id=4&sesskey=new"
  });

  manager.onTabCreated({ id: 2 });
  const duplicateResult = await manager.onCourseContext(
    {
      context: {
        courseId: "99647",
        courseCode: "ELEC2133",
        courseName: "ELEC2133 - Analogue Electronics",
        url: harness.tabs.get(2).url
      }
    },
    { tab: { ...harness.tabs.get(2) } }
  );
  assert.equal(duplicateResult.closed, 1);
  assert.deepEqual(harness.removed, [2]);
  assert.deepEqual(harness.focused, [1]);

  harness.tabs.set(3, {
    id: 3,
    windowId: 1,
    groupId: -1,
    active: true,
    pinned: false,
    safe: true,
    title: "Quiz",
    url: "https://moodle.telt.unsw.edu.au/mod/quiz/view.php?id=9"
  });
  manager.onTabCreated({ id: 3 });
  const groupedResult = await manager.onCourseContext(
    {
      context: {
        courseId: "99647",
        courseCode: "ELEC2133",
        courseName: "ELEC2133 - Analogue Electronics",
        url: harness.tabs.get(3).url
      }
    },
    { tab: { ...harness.tabs.get(3) } }
  );
  assert.equal(groupedResult.managed, true);
  assert.equal(harness.tabs.get(3).groupId, 7);

  harness.tabs.set(4, {
    id: 4,
    windowId: 1,
    groupId: -1,
    active: true,
    pinned: false,
    safe: false,
    title: "Editable quiz",
    url: "https://moodle.telt.unsw.edu.au/mod/quiz/view.php?id=9&notify=1"
  });
  manager.onTabCreated({ id: 4 });
  const protectedResult = await manager.onCourseContext(
    {
      context: {
        courseId: "99647",
        courseCode: "ELEC2133",
        courseName: "ELEC2133 - Analogue Electronics",
        url: harness.tabs.get(4).url
      }
    },
    { tab: { ...harness.tabs.get(4) } }
  );
  assert.equal(protectedResult.closed, 0);
  assert.equal(harness.tabs.has(4), true);

  harness.tabs.set(5, {
    id: 5,
    windowId: 1,
    groupId: -1,
    active: false,
    pinned: false,
    safe: false,
    dirty: true,
    title: "Edited assignment",
    url: "https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=10"
  });
  manager.onTabCreated({ id: 5 });
  const editedResult = await manager.onCourseContext(
    {
      context: {
        courseId: "99647",
        courseCode: "ELEC2133",
        courseName: "ELEC2133 - Analogue Electronics",
        url: harness.tabs.get(5).url
      }
    },
    { tab: { ...harness.tabs.get(5) } }
  );
  assert.equal(editedResult.managed, true);

  for (const tab of harness.tabs.values()) {
    tab.active = false;
  }
  harness.tabs.get(3).active = true;
  const closeResult = await manager.closeCourseTabs();
  assert.equal(closeResult.closed, 2);
  assert.equal(closeResult.skipped, 1);
  assert.equal(harness.tabs.has(3), false);
  assert.equal(harness.tabs.has(4), false);
  assert.equal(harness.tabs.has(5), true);
  assert.equal(harness.storage.moodleUtilsCourseWorkspaces.length, 1);
  assert.deepEqual(
    Array.from(
      harness.storage.moodleUtilsCourseWorkspaces[0].tabs,
      (tab) => tab.url
    ),
    [
      "https://moodle.telt.unsw.edu.au/mod/quiz/view.php?id=9",
      "https://moodle.telt.unsw.edu.au/mod/quiz/view.php?id=9"
    ]
  );

  const restoreResult = await manager.restoreWorkspace("99647");
  assert.equal(restoreResult.restored, 2);

  process.stdout.write("tab manager tests passed\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadCore() {
  const context = vm.createContext({
    Date,
    Map,
    Math,
    Object,
    Set,
    String,
    URL,
    globalThis: null
  });
  context.globalThis = context;
  const source = fs.readFileSync(
    path.join(__dirname, "..", "change-detector-core.js"),
    "utf8"
  );
  vm.runInContext(source, context, {
    filename: "change-detector-core.js"
  });
  return context.MoodleUtilsChangeDetectorCore;
}

function item(key, title, details = "", url = "", section = "Week 7") {
  return {
    key,
    kind: "activity",
    title,
    details,
    url,
    section,
    container: "section:7"
  };
}

function section(key, title, details = "") {
  return {
    key,
    kind: "section",
    title,
    details,
    url: "",
    section: title,
    container: ""
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function run() {
  const core = loadCore();

  assert.equal(
    core.canonicaliseUrl(
      "https://moodle.telt.unsw.edu.au/mod/page/view.php?id=42&sesskey=secret&notify=1#top"
    ),
    "https://moodle.telt.unsw.edu.au/mod/page/view.php?id=42"
  );

  const previous = {
    courseId: "99647",
    items: [
      item("activity:1", "Lecture notes", "Available Friday"),
      item("activity:2", "Quiz 4", "Due Thursday"),
      item("activity:3", "Old worksheet")
    ]
  };
  const current = {
    courseId: "99647",
    items: [
      item("activity:1", "Lecture 7 notes", "Available Friday"),
      item("activity:2", "Quiz 4", "Due Friday"),
      item("activity:4", "New worksheet")
    ]
  };

  const diff = plain(core.diffSnapshots(previous, current));
  assert.deepEqual(
    diff.added.map((entry) => entry.key),
    ["activity:4"]
  );
  assert.deepEqual(
    diff.updated.map((entry) => entry.after.key),
    ["activity:1", "activity:2"]
  );
  assert.deepEqual(
    diff.removed.map((entry) => entry.key),
    ["activity:3"]
  );

  const transientOnly = core.diffSnapshots(
    {
      items: [
        item(
          "activity:7",
          "Choice",
          "",
          "https://moodle.telt.unsw.edu.au/mod/choice/view.php?id=7&sesskey=old"
        )
      ]
    },
    {
      items: [
        item(
          "activity:7",
          "Choice",
          "",
          "https://moodle.telt.unsw.edu.au/mod/choice/view.php?id=7&sesskey=new&notify=1"
        )
      ]
    }
  );
  assert.equal(transientOnly.updated.length, 0);

  const sectionRenameOnly = core.diffSnapshots(
    { items: [item("activity:8", "Lecture", "", "", "Week 7")] },
    { items: [item("activity:8", "Lecture", "", "", "Topic 7")] }
  );
  assert.equal(sectionRenameOnly.updated.length, 0);

  const migrated = core.migrateLegacyUntitledSections(
    {
      courseId: "99647",
      capturedAt: 123,
      items: [
        item("activity:8", "Lecture"),
        section("section:7", "Untitled course section", "Old summary"),
        section("section-text:", "Untitled course section")
      ]
    },
    {
      courseId: "99647",
      items: [
        item("activity:8", "Lecture"),
        item("activity:9", "Forum 11 unread posts"),
        section("section:7", "Week 7", "Current summary"),
        section("section:8", "Week 8")
      ]
    }
  );
  assert.equal(migrated.changed, true);
  assert.equal(migrated.snapshot.capturedAt, 123);
  assert.equal(
    migrated.snapshot.items.some(
      (entry) => entry.title === "Untitled course section"
    ),
    false
  );
  const migratedDiff = plain(
    core.diffSnapshots(migrated.snapshot, {
      courseId: "99647",
      items: [
        item("activity:8", "Lecture"),
        item("activity:9", "Forum 11 unread posts"),
        section("section:7", "Week 7", "Current summary"),
        section("section:8", "Week 8")
      ]
    })
  );
  assert.deepEqual(
    migratedDiff.added.map((entry) => entry.key),
    ["activity:9"]
  );
  assert.equal(migratedDiff.updated.length, 0);
  assert.equal(migratedDiff.removed.length, 0);

  process.stdout.write("change detector core tests passed\n");
}

run();

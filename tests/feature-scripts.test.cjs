"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadSource(name) {
  return fs.readFileSync(path.join(__dirname, "..", name), "utf8");
}

function createKeepaliveHarness() {
  const storage = new Map();
  const elements = new Map();
  const timers = [];
  const intervals = [];
  const listeners = {};
  const requests = [];
  const messages = [];

  const document = {
    body: {},
    documentElement: {
      appendChild(element) {
        elements.set(element.id, element);
      }
    },
    addEventListener(type, listener) {
      listeners[`document:${type}`] = listener;
    },
    createElement() {
      return {
        dataset: {},
        setAttribute() {},
        style: {},
        textContent: ""
      };
    },
    getElementById(id) {
      return elements.get(id) || null;
    },
    hidden: false
  };

  const window = {
    M: {
      cfg: {
        sesskey: "test-session-key",
        wwwroot: "https://moodle.telt.unsw.edu.au"
      }
    },
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    clearTimeout() {},
    async fetch(url, options) {
      requests.push({ url: String(url), options });
      return {
        ok: true,
        async json() {
          return [{}];
        }
      };
    },
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      removeItem(key) {
        storage.delete(key);
      },
      setItem(key, value) {
        storage.set(key, String(value));
      }
    },
    postMessage(message, targetOrigin) {
      messages.push({ message, targetOrigin });
    },
    setInterval(callback, delay) {
      intervals.push({ callback, delay });
      return intervals.length;
    },
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    }
  };

  const context = vm.createContext({
    console,
    Date,
    document,
    JSON,
    location: {
      origin: "https://moodle.telt.unsw.edu.au"
    },
    Math,
    URL,
    window
  });
  vm.runInContext(loadSource("keepalive.js"), context, {
    filename: "keepalive.js"
  });

  return {
    document,
    listeners,
    messages,
    requests,
    timers,
    window
  };
}

async function testKeepaliveSuccess() {
  const harness = createKeepaliveHarness();
  const initialTimer = harness.timers.find((timer) => timer.delay === 1500);
  assert.ok(initialTimer, "initial heartbeat timer should be scheduled");
  await initialTimer.callback();

  assert.equal(harness.requests.length, 1);
  const request = harness.requests[0];
  const url = new URL(request.url);
  assert.equal(url.pathname, "/lib/ajax/service.php");
  assert.equal(url.searchParams.get("sesskey"), "test-session-key");
  assert.equal(url.searchParams.get("info"), "core_session_touch");
  assert.equal(request.options.method, "POST");
  assert.equal(
    JSON.parse(request.options.body)[0].methodname,
    "core_session_touch"
  );

  const badge = harness.document.getElementById(
    "unsw-moodle-session-keeper-status"
  );
  assert.match(badge.textContent, /live check passed/i);
  assert.equal(
    harness.messages.some(
      ({ message }) =>
        message.type === "KEEPALIVE_RESULT" && message.ok === true
    ),
    true
  );
}

async function testKeepaliveToggle() {
  const harness = createKeepaliveHarness();
  harness.listeners.message({
    source: harness.window,
    origin: "https://moodle.telt.unsw.edu.au",
    data: {
      source: "moodle-utils",
      type: "SETTINGS_UPDATED",
      settings: { keepalive: false }
    }
  });

  const initialTimer = harness.timers.find((timer) => timer.delay === 1500);
  await initialTimer.callback();
  assert.equal(harness.requests.length, 0);
}

async function testLtiAutoClose() {
  const timers = [];
  const elements = new Map();
  const runtimeMessages = [];
  let closed = false;
  const window = {
    clearTimeout(timerId) {
      const timer = timers.find((entry) => entry.id === timerId);
      if (timer) {
        timer.cleared = true;
      }
    },
    close() {
      closed = true;
    },
    setTimeout(callback, delay) {
      const id = timers.length + 1;
      timers.push({ callback, delay, id, cleared: false });
      return id;
    }
  };
  const context = vm.createContext({
    Boolean,
    chrome: {
      runtime: {
        async sendMessage(message) {
          runtimeMessages.push(message);
          if (message.type === "GET_SETTINGS") {
            return { ltiAutoClose: true };
          }
          if (message.type === "CONCEAL_LTI_LAUNCH_TAB") {
            return { concealed: true };
          }
          if (message.type === "CLOSE_CONCEALED_LTI_TAB") {
            return { closed: true };
          }
          return null;
        }
      }
    },
    console,
    document: {
      body: { innerText: "Your activity has opened in a new window" },
      createElement() {
        return {
          id: "",
          remove() {
            elements.delete(this.id);
          },
          textContent: ""
        };
      },
      documentElement: {
        appendChild(element) {
          elements.set(element.id, element);
        }
      },
      getElementById(id) {
        return elements.get(id) || null;
      },
      querySelector() {
        return null;
      },
      readyState: "complete"
    },
    globalThis: {},
    location: {
      pathname: "/mod/lti/launch.php"
    },
    window
  });
  vm.runInContext(loadSource("lti-autoclose.js"), context, {
    filename: "lti-autoclose.js"
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements.has("moodle-utils-lti-conceal"), true);
  assert.equal(
    runtimeMessages.some(
      (message) => message.type === "CONCEAL_LTI_LAUNCH_TAB"
    ),
    true
  );
  const closeTimer = timers.find((timer) => timer.delay === 1200);
  assert.ok(closeTimer);
  await closeTimer.callback();
  assert.equal(
    runtimeMessages.some(
      (message) => message.type === "CLOSE_CONCEALED_LTI_TAB"
    ),
    true
  );
  assert.equal(closed, false);
}

async function run() {
  await testKeepaliveSuccess();
  await testKeepaliveToggle();
  await testLtiAutoClose();
  assert.match(
    loadSource("content.js"),
    /phase === "complete"[\s\S]*?removeOverlay\(\)/,
    "completed recovery should explicitly dismiss its overlay"
  );
  const changeDetectorSource = loadSource("changed-since-last-visit.js");
  assert.match(
    changeDetectorSource,
    /:scope \.sectionname/,
    "section titles should be found in nested Moodle markup"
  );
  assert.match(
    changeDetectorSource,
    /if \(!title\) \{\s*return null;/,
    "partially rendered titleless sections should not be snapshotted"
  );
  process.stdout.write("feature script tests passed\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

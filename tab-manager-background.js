(() => {
  "use strict";

  if (globalThis.MoodleUtilsCreateTabManager) {
    return;
  }

  const core = globalThis.MoodleUtilsTabManagerCore;
  if (!core) {
    return;
  }

  const MOODLE_ORIGIN = "https://moodle.telt.unsw.edu.au";
  const MAIN_SETTINGS_KEY = "moodleUtilsSettings";
  const MANAGER_SETTINGS_KEY = "moodleUtilsTabManagerSettings";
  const CONTEXTS_KEY = "moodleUtilsCourseTabContexts";
  const WORKSPACES_KEY = "moodleUtilsCourseWorkspaces";
  const MAX_WORKSPACES = 12;
  const CREATED_TAB_TTL_MS = 60 * 1000;
  const DEFAULT_MAIN_SETTINGS = Object.freeze({
    courseTabManager: true
  });
  const DEFAULT_MANAGER_SETTINGS = Object.freeze({
    autoGroup: true,
    shortenTitles: true,
    preventDuplicates: true,
    moveExistingGroups: false,
    allWindows: false,
    groupColor: "auto"
  });

  function createTabManager(chromeApi) {
    const recentlyCreatedTabs = new Map();
    let operationSequence = Promise.resolve();

    function serialise(operation) {
      const result = operationSequence.then(operation);
      operationSequence = result.catch(() => undefined);
      return result;
    }

    async function getMainSettings() {
      const stored = await chromeApi.storage.local.get(MAIN_SETTINGS_KEY);
      return {
        ...DEFAULT_MAIN_SETTINGS,
        ...(stored[MAIN_SETTINGS_KEY] || {})
      };
    }

    async function getSettings() {
      const stored = await chromeApi.storage.local.get(MANAGER_SETTINGS_KEY);
      const settings = {
        ...DEFAULT_MANAGER_SETTINGS,
        ...(stored[MANAGER_SETTINGS_KEY] || {})
      };
      if (!stored[MANAGER_SETTINGS_KEY]) {
        await chromeApi.storage.local.set({
          [MANAGER_SETTINGS_KEY]: settings
        });
      }
      return settings;
    }

    async function broadcastSettings(settings) {
      const tabs = await chromeApi.tabs.query({
        url: `${MOODLE_ORIGIN}/*`
      });
      await Promise.allSettled(
        tabs
          .filter((tab) => Number.isInteger(tab.id))
          .map((tab) =>
            chromeApi.tabs.sendMessage(tab.id, {
              type: "TAB_MANAGER_SETTINGS_UPDATED",
              settings
            })
          )
      );
    }

    async function updateSettings(changes) {
      const settings = {
        ...(await getSettings()),
        ...(changes || {})
      };
      await chromeApi.storage.local.set({
        [MANAGER_SETTINGS_KEY]: settings
      });
      await broadcastSettings(settings);
      return settings;
    }

    async function getContexts() {
      const stored = await chromeApi.storage.local.get(CONTEXTS_KEY);
      return stored[CONTEXTS_KEY] || {};
    }

    async function setContexts(contexts) {
      await chromeApi.storage.local.set({ [CONTEXTS_KEY]: contexts });
    }

    async function rememberContext(tab, context) {
      if (
        !Number.isInteger(tab?.id) ||
        !Number.isInteger(tab?.windowId) ||
        !context?.courseId
      ) {
        return null;
      }

      const prepared = {
        courseId: String(context.courseId),
        courseCode: core.extractCourseCode(
          context.courseCode,
          context.courseName,
          context.groupTitle
        ),
        courseName: core.cleanCourseName(context.courseName),
        groupTitle: core.groupTitle(
          context.courseCode,
          context.courseName,
          context.courseId
        ),
        canonicalUrl: core.canonicaliseTabUrl(context.url || tab.url),
        url: context.url || tab.url,
        pageTitle: core.normaliseWhitespace(
          context.pageTitle || tab.title || context.originalTitle
        ),
        originalTitle: core.normaliseWhitespace(
          context.originalTitle || tab.title
        ),
        windowId: tab.windowId,
        updatedAt: Date.now()
      };
      const contexts = await getContexts();
      contexts[String(tab.id)] = prepared;
      await setContexts(contexts);
      return prepared;
    }

    async function forgetContext(tabId) {
      const contexts = await getContexts();
      if (!contexts[String(tabId)]) {
        return;
      }
      delete contexts[String(tabId)];
      await setContexts(contexts);
    }

    async function pruneContexts() {
      const [contexts, openTabs] = await Promise.all([
        getContexts(),
        chromeApi.tabs.query({})
      ]);
      const openIds = new Set(
        openTabs.filter((tab) => Number.isInteger(tab.id)).map((tab) => String(tab.id))
      );
      let changed = false;
      for (const tabId of Object.keys(contexts)) {
        if (!openIds.has(tabId)) {
          delete contexts[tabId];
          changed = true;
        }
      }
      if (changed) {
        await setContexts(contexts);
      }
      return contexts;
    }

    async function requestContext(tab) {
      if (!Number.isInteger(tab?.id) || !tab.url?.startsWith(MOODLE_ORIGIN)) {
        return null;
      }
      try {
        const context = await chromeApi.tabs.sendMessage(tab.id, {
          type: "GET_COURSE_TAB_CONTEXT"
        });
        return context ? rememberContext(tab, context) : null;
      } catch {
        return null;
      }
    }

    function matchingGroup(groups, title) {
      const loweredTitle = title.toLocaleLowerCase();
      return groups.find(
        (group) =>
          !group.shared &&
          String(group.title || "").trim().toLocaleLowerCase() === loweredTitle
      );
    }

    async function groupTab(tabId, context, settings, force = false) {
      const tab = await chromeApi.tabs.get(tabId);
      const none = chromeApi.tabGroups.TAB_GROUP_ID_NONE ?? -1;
      const currentGroupId = Number.isInteger(tab.groupId)
        ? tab.groupId
        : none;
      const groups = await chromeApi.tabGroups.query({
        windowId: tab.windowId
      });
      const currentGroup = groups.find((group) => group.id === currentGroupId);
      const title = core.groupTitle(
        context.courseCode,
        context.courseName,
        context.courseId
      );

      if (
        currentGroup &&
        String(currentGroup.title || "").trim().toLocaleLowerCase() ===
          title.toLocaleLowerCase()
      ) {
        return currentGroup.id;
      }
      if (
        currentGroupId !== none &&
        !force &&
        !settings.moveExistingGroups
      ) {
        return currentGroupId;
      }

      const targetGroup = matchingGroup(groups, title);
      if (targetGroup) {
        await chromeApi.tabs.group({
          tabIds: [tabId],
          groupId: targetGroup.id
        });
        return targetGroup.id;
      }

      const groupId = await chromeApi.tabs.group({
        tabIds: [tabId],
        createProperties: { windowId: tab.windowId }
      });
      await chromeApi.tabGroups.update(groupId, {
        title,
        color: core.groupColor(context.courseId, settings.groupColor)
      });
      return groupId;
    }

    async function safeToClose(tab, { userInitiated = false } = {}) {
      if (!Number.isInteger(tab?.id) || tab.pinned) {
        return false;
      }
      try {
        const result = await chromeApi.tabs.sendMessage(tab.id, {
          type: "CHECK_TAB_SAFE_TO_CLOSE"
        });
        return userInitiated
          ? result?.safeUserInitiated === true
          : result?.safe === true;
      } catch {
        return false;
      }
    }

    async function closeDuplicateForNewTab(tabId, context) {
      const createdAt = recentlyCreatedTabs.get(tabId);
      recentlyCreatedTabs.delete(tabId);
      if (!createdAt || Date.now() - createdAt > CREATED_TAB_TTL_MS) {
        return { closed: 0 };
      }

      const newTab = await chromeApi.tabs.get(tabId);
      const canonicalUrl = core.canonicaliseTabUrl(
        context.url || newTab.url
      );
      const candidates = (
        await chromeApi.tabs.query({ windowId: newTab.windowId })
      ).filter(
        (tab) =>
          tab.id !== tabId &&
          tab.url?.startsWith(MOODLE_ORIGIN) &&
          core.canonicaliseTabUrl(tab.url) === canonicalUrl
      );
      if (!candidates.length || !(await safeToClose(newTab))) {
        return { closed: 0 };
      }

      const keeper =
        candidates.find((tab) => tab.pinned) ||
        candidates.find((tab) => Number(tab.groupId) >= 0) ||
        candidates[0];
      if (newTab.active) {
        await chromeApi.tabs.update(keeper.id, { active: true });
        if (chromeApi.windows?.update) {
          await chromeApi.windows.update(keeper.windowId, { focused: true });
        }
      }
      await chromeApi.tabs.remove(tabId);
      return { closed: 1, focusedTabId: keeper.id };
    }

    async function onCourseContext(message, sender) {
      return serialise(async () => {
        const tab = sender?.tab;
        const context = await rememberContext(tab, message?.context);
        if (!context) {
          return { managed: false };
        }

        const [mainSettings, settings] = await Promise.all([
          getMainSettings(),
          getSettings()
        ]);
        if (!mainSettings.courseTabManager) {
          return { managed: false, context };
        }

        if (settings.preventDuplicates) {
          const duplicateResult = await closeDuplicateForNewTab(tab.id, context);
          if (duplicateResult.closed) {
            return { managed: true, context, ...duplicateResult };
          }
        }
        if (settings.autoGroup) {
          await groupTab(tab.id, context, settings);
        }
        return { managed: true, context, closed: 0 };
      });
    }

    async function hydrateContexts(tabs) {
      const contexts = await getContexts();
      for (const tab of tabs) {
        if (!Number.isInteger(tab.id) || contexts[String(tab.id)]) {
          continue;
        }
        const context = await requestContext(tab);
        if (context) {
          contexts[String(tab.id)] = context;
        }
      }
      return getContexts();
    }

    async function currentCourse() {
      const activeTabs = await chromeApi.tabs.query({
        active: true,
        currentWindow: true
      });
      const activeTab = activeTabs[0];
      if (!activeTab) {
        return { tab: null, context: null };
      }

      let contexts = await getContexts();
      let context = contexts[String(activeTab.id)] || null;
      if (!context) {
        context = await requestContext(activeTab);
        contexts = await getContexts();
        context = context || contexts[String(activeTab.id)] || null;
      }
      return { tab: activeTab, context };
    }

    async function tabsForCourse(context, windowId, allWindows) {
      if (!context) {
        return [];
      }
      const tabs = await chromeApi.tabs.query(
        allWindows ? {} : { windowId }
      );
      const contexts = await hydrateContexts(
        tabs.filter((tab) => tab.url?.startsWith(MOODLE_ORIGIN))
      );
      return tabs.filter(
        (tab) =>
          contexts[String(tab.id)]?.courseId === context.courseId
      );
    }

    async function closeExistingDuplicates(tabs) {
      const byUrl = new Map();
      for (const tab of tabs) {
        if (!tab.url?.startsWith(MOODLE_ORIGIN)) {
          continue;
        }
        const key = `${tab.windowId}:${core.canonicaliseTabUrl(tab.url)}`;
        if (!byUrl.has(key)) {
          byUrl.set(key, []);
        }
        byUrl.get(key).push(tab);
      }

      let closed = 0;
      for (const duplicateTabs of byUrl.values()) {
        if (duplicateTabs.length < 2) {
          continue;
        }
        const keeper =
          duplicateTabs.find((tab) => tab.pinned) ||
          duplicateTabs.find((tab) => tab.active) ||
          duplicateTabs.find((tab) => Number(tab.groupId) >= 0) ||
          duplicateTabs[0];
        for (const tab of duplicateTabs) {
          if (tab.id === keeper.id || !(await safeToClose(tab))) {
            continue;
          }
          await chromeApi.tabs.remove(tab.id);
          closed += 1;
        }
      }
      return closed;
    }

    async function organiseOpenTabs() {
      const [mainSettings, settings, active] = await Promise.all([
        getMainSettings(),
        getSettings(),
        chromeApi.tabs.query({ active: true, currentWindow: true })
      ]);
      if (!mainSettings.courseTabManager) {
        return { ok: false, detail: "Course Tab Manager is disabled." };
      }

      const activeWindowId = active[0]?.windowId;
      const tabs = await chromeApi.tabs.query(
        settings.allWindows || !Number.isInteger(activeWindowId)
          ? {}
          : { windowId: activeWindowId }
      );
      const moodleTabs = tabs.filter((tab) =>
        tab.url?.startsWith(MOODLE_ORIGIN)
      );
      const contexts = await hydrateContexts(moodleTabs);
      let grouped = 0;

      for (const tab of moodleTabs) {
        const context = contexts[String(tab.id)];
        if (!context) {
          continue;
        }
        const before = tab.groupId;
        await groupTab(tab.id, context, settings);
        const after = await chromeApi.tabs.get(tab.id);
        if (after.groupId !== before) {
          grouped += 1;
        }
      }
      const closed = settings.preventDuplicates
        ? await closeExistingDuplicates(moodleTabs)
        : 0;
      return {
        ok: true,
        grouped,
        closed,
        detail: `Organised ${grouped} tab${grouped === 1 ? "" : "s"}${
          closed ? ` and closed ${closed} duplicate${closed === 1 ? "" : "s"}` : ""
        }.`
      };
    }

    async function focusCourseTabs() {
      const settings = await getSettings();
      const { tab, context } = await currentCourse();
      if (!tab || !context) {
        return { ok: false, detail: "Open a Moodle course tab first." };
      }
      const tabs = await tabsForCourse(
        context,
        tab.windowId,
        settings.allWindows
      );
      const target =
        tabs.find((candidate) => candidate.active) ||
        tabs.find((candidate) => candidate.pinned) ||
        tabs[0];
      if (!target) {
        return { ok: false, detail: "No tabs were found for this course." };
      }
      if (Number(target.groupId) >= 0) {
        await chromeApi.tabGroups.update(target.groupId, {
          collapsed: false
        });
      }
      await chromeApi.tabs.update(target.id, { active: true });
      if (chromeApi.windows?.update) {
        await chromeApi.windows.update(target.windowId, { focused: true });
      }
      return {
        ok: true,
        count: tabs.length,
        detail: `Focused ${context.groupTitle} (${tabs.length} tab${
          tabs.length === 1 ? "" : "s"
        }).`
      };
    }

    async function getWorkspaces() {
      const stored = await chromeApi.storage.local.get(WORKSPACES_KEY);
      return Array.isArray(stored[WORKSPACES_KEY])
        ? stored[WORKSPACES_KEY]
        : [];
    }

    async function saveWorkspace(context, tabs) {
      const workspaces = await getWorkspaces();
      const workspace = {
        id: `${context.courseId}:${Date.now()}`,
        courseId: context.courseId,
        courseCode: context.courseCode,
        courseName: context.courseName,
        groupTitle: context.groupTitle,
        closedAt: Date.now(),
        tabs: tabs.map((tab) => ({
          url: core.canonicaliseTabUrl(tab.url),
          title: core.normaliseWhitespace(tab.title)
        }))
      };
      workspaces.unshift(workspace);
      await chromeApi.storage.local.set({
        [WORKSPACES_KEY]: workspaces.slice(0, MAX_WORKSPACES)
      });
      return workspace;
    }

    async function closeCourseTabs() {
      const settings = await getSettings();
      const { tab, context } = await currentCourse();
      if (!tab || !context) {
        return { ok: false, detail: "Open a Moodle course tab first." };
      }
      const tabs = await tabsForCourse(
        context,
        tab.windowId,
        settings.allWindows
      );
      const safeTabs = [];
      for (const candidate of tabs) {
        if (await safeToClose(candidate, { userInitiated: true })) {
          safeTabs.push(candidate);
        }
      }
      if (!safeTabs.length) {
        return {
          ok: false,
          detail: "No tabs were closed because they are pinned or contain unsaved edits."
        };
      }

      await saveWorkspace(context, safeTabs);
      await chromeApi.tabs.remove(safeTabs.map((candidate) => candidate.id));
      const skipped = tabs.length - safeTabs.length;
      return {
        ok: true,
        closed: safeTabs.length,
        skipped,
        detail: `Closed ${safeTabs.length} ${context.groupTitle} tab${
          safeTabs.length === 1 ? "" : "s"
        }${skipped ? `; kept ${skipped} protected` : ""}.`
      };
    }

    async function restoreWorkspace(courseId = null) {
      const [workspaces, activeTabs, settings] = await Promise.all([
        getWorkspaces(),
        chromeApi.tabs.query({ active: true, currentWindow: true }),
        getSettings()
      ]);
      const workspace =
        workspaces.find((candidate) => candidate.courseId === courseId) ||
        workspaces[0];
      if (!workspace?.tabs?.length) {
        return { ok: false, detail: "There is no saved course workspace yet." };
      }

      const windowId = activeTabs[0]?.windowId;
      const createdTabs = [];
      for (let index = 0; index < workspace.tabs.length; index += 1) {
        const created = await chromeApi.tabs.create({
          url: workspace.tabs[index].url,
          active: index === 0,
          ...(Number.isInteger(windowId) ? { windowId } : {})
        });
        createdTabs.push(created);
      }

      if (createdTabs.length) {
        const groupId = await chromeApi.tabs.group({
          tabIds: createdTabs.map((tab) => tab.id),
          createProperties: {
            windowId: createdTabs[0].windowId
          }
        });
        await chromeApi.tabGroups.update(groupId, {
          title: workspace.groupTitle,
          color: core.groupColor(workspace.courseId, settings.groupColor),
          collapsed: false
        });
      }
      return {
        ok: true,
        restored: createdTabs.length,
        detail: `Restored ${workspace.groupTitle} (${createdTabs.length} tab${
          createdTabs.length === 1 ? "" : "s"
        }).`
      };
    }

    async function getStatus() {
      const [settings, current, workspaces] = await Promise.all([
        getSettings(),
        currentCourse(),
        getWorkspaces()
      ]);
      const { tab, context } = current;
      const tabs =
        tab && context
          ? await tabsForCourse(context, tab.windowId, settings.allWindows)
          : [];
      const workspace =
        workspaces.find(
          (candidate) => candidate.courseId === context?.courseId
        ) || workspaces[0] || null;
      return {
        currentCourse: context,
        tabCount: tabs.length,
        lastWorkspace: workspace
          ? {
              courseId: workspace.courseId,
              groupTitle: workspace.groupTitle,
              tabCount: workspace.tabs.length,
              closedAt: workspace.closedAt
            }
          : null
      };
    }

    function onTabCreated(tab) {
      if (Number.isInteger(tab?.id)) {
        recentlyCreatedTabs.set(tab.id, Date.now());
      }
    }

    function onTabRemoved(tabId) {
      recentlyCreatedTabs.delete(tabId);
      void serialise(() => forgetContext(tabId));
    }

    function onTabUpdated(tabId, changeInfo) {
      if (changeInfo.url) {
        void serialise(() => forgetContext(tabId));
      }
    }

    async function initialise() {
      await Promise.all([getSettings(), pruneContexts()]);
    }

    return Object.freeze({
      closeCourseTabs: () => serialise(closeCourseTabs),
      focusCourseTabs: () => serialise(focusCourseTabs),
      getSettings,
      getStatus,
      initialise,
      onCourseContext,
      onTabCreated,
      onTabRemoved,
      onTabUpdated,
      organiseOpenTabs: () => serialise(organiseOpenTabs),
      restoreWorkspace: (courseId) =>
        serialise(() => restoreWorkspace(courseId)),
      updateSettings
    });
  }

  globalThis.MoodleUtilsCreateTabManager = createTabManager;
})();

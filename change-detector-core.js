(() => {
  "use strict";

  if (globalThis.MoodleUtilsChangeDetectorCore) {
    return;
  }

  const TRANSIENT_QUERY_PARAMETERS = new Set([
    "sesskey",
    "notify",
    "cache",
    "time",
    "moodle_utils_probe"
  ]);
  const LEGACY_UNTITLED_SECTION_TITLES = new Set([
    "untitled course section",
    "untitled moodle item"
  ]);

  function normaliseWhitespace(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function canonicaliseUrl(value, baseUrl = undefined) {
    if (!value) {
      return "";
    }

    try {
      const url = new URL(value, baseUrl);
      for (const key of [...url.searchParams.keys()]) {
        if (TRANSIENT_QUERY_PARAMETERS.has(key.toLowerCase())) {
          url.searchParams.delete(key);
        }
      }
      url.hash = "";
      return url.href;
    } catch {
      return normaliseWhitespace(value);
    }
  }

  function fingerprint(item) {
    const source = [
      item.kind,
      normaliseWhitespace(item.title),
      canonicaliseUrl(item.url),
      normaliseWhitespace(item.container),
      normaliseWhitespace(item.details)
    ].join("\u241f");

    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function prepareItem(item) {
    const prepared = {
      key: normaliseWhitespace(item.key),
      kind: item.kind === "section" ? "section" : "activity",
      title: normaliseWhitespace(item.title) || "Untitled Moodle item",
      url: canonicaliseUrl(item.url),
      section: normaliseWhitespace(item.section),
      container: normaliseWhitespace(item.container),
      details: normaliseWhitespace(item.details)
    };
    prepared.fingerprint = fingerprint(prepared);
    return prepared;
  }

  function prepareSnapshot(snapshot) {
    const items = Array.isArray(snapshot?.items)
      ? snapshot.items.map(prepareItem).filter((item) => item.key)
      : [];

    return {
      schema: 1,
      courseId: normaliseWhitespace(snapshot?.courseId),
      scope: normaliseWhitespace(snapshot?.scope) || "all",
      title: normaliseWhitespace(snapshot?.title),
      capturedAt: Number(snapshot?.capturedAt) || Date.now(),
      items
    };
  }

  function isLegacyUntitledSection(item) {
    return (
      item?.kind === "section" &&
      LEGACY_UNTITLED_SECTION_TITLES.has(
        normaliseWhitespace(item.title).toLowerCase()
      )
    );
  }

  function migrateLegacyUntitledSections(previousSnapshot, currentSnapshot) {
    const current = prepareSnapshot(currentSnapshot);
    const currentByKey = new Map(
      current.items.map((item) => [item.key, item])
    );
    const migratedItems = [];
    let changed = false;

    for (const rawItem of Array.isArray(previousSnapshot?.items)
      ? previousSnapshot.items
      : []) {
      const item = prepareItem(rawItem);
      if (!item.key) {
        continue;
      }
      if (!isLegacyUntitledSection(item)) {
        migratedItems.push(item);
        continue;
      }

      changed = true;
      const replacement = currentByKey.get(item.key);
      if (replacement && !isLegacyUntitledSection(replacement)) {
        migratedItems.push(replacement);
      }
    }

    if (changed) {
      const migratedKeys = new Set(migratedItems.map((item) => item.key));
      for (const item of current.items) {
        if (
          item.kind === "section" &&
          !isLegacyUntitledSection(item) &&
          !migratedKeys.has(item.key)
        ) {
          migratedItems.push(item);
          migratedKeys.add(item.key);
        }
      }
    }

    return {
      changed,
      snapshot: prepareSnapshot({
        ...(previousSnapshot || {}),
        items: migratedItems
      })
    };
  }

  function diffSnapshots(previousSnapshot, currentSnapshot) {
    const previous = prepareSnapshot(previousSnapshot);
    const current = prepareSnapshot(currentSnapshot);
    const previousByKey = new Map(
      previous.items.map((item) => [item.key, item])
    );
    const currentByKey = new Map(current.items.map((item) => [item.key, item]));
    const added = [];
    const updated = [];
    const removed = [];

    for (const item of current.items) {
      const oldItem = previousByKey.get(item.key);
      if (!oldItem) {
        added.push(item);
      } else if (oldItem.fingerprint !== item.fingerprint) {
        updated.push({ before: oldItem, after: item });
      }
    }

    for (const item of previous.items) {
      if (!currentByKey.has(item.key)) {
        removed.push(item);
      }
    }

    return { added, updated, removed };
  }

  globalThis.MoodleUtilsChangeDetectorCore = Object.freeze({
    canonicaliseUrl,
    diffSnapshots,
    fingerprint,
    migrateLegacyUntitledSections,
    normaliseWhitespace,
    prepareItem,
    prepareSnapshot
  });
})();

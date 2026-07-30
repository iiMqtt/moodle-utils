(() => {
  "use strict";

  if (globalThis.MoodleUtilsTabManagerCore) {
    return;
  }

  const TRANSIENT_PARAMETERS = new Set([
    "sesskey",
    "notify",
    "moodle_utils_probe",
    "cache",
    "time"
  ]);
  const COURSE_CODE_PATTERN = /\b([A-Z]{4}\d{4})\b/i;
  const GROUP_COLORS = [
    "blue",
    "green",
    "purple",
    "cyan",
    "orange",
    "pink",
    "red",
    "yellow"
  ];

  function normaliseWhitespace(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function canonicaliseTabUrl(value, baseUrl = undefined) {
    try {
      const url = new URL(value, baseUrl);
      for (const key of [...url.searchParams.keys()]) {
        if (TRANSIENT_PARAMETERS.has(key.toLowerCase())) {
          url.searchParams.delete(key);
        }
      }

      const sortedParameters = [...url.searchParams.entries()].sort(
        ([leftKey, leftValue], [rightKey, rightValue]) =>
          leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
      );
      url.search = "";
      for (const [key, parameterValue] of sortedParameters) {
        url.searchParams.append(key, parameterValue);
      }
      return url.href;
    } catch {
      return normaliseWhitespace(value);
    }
  }

  function extractCourseCode(...values) {
    for (const value of values) {
      const match = normaliseWhitespace(value).match(COURSE_CODE_PATTERN);
      if (match) {
        return match[1].toUpperCase();
      }
    }
    return "";
  }

  function cleanCourseName(value) {
    return normaliseWhitespace(value)
      .replace(/^course:\s*/i, "")
      .replace(/\s*\|\s*UNSW\s*$/i, "")
      .slice(0, 80);
  }

  function groupTitle(courseCode, courseName, courseId) {
    const code = extractCourseCode(courseCode, courseName);
    if (code) {
      return code;
    }

    const cleaned = cleanCourseName(courseName)
      .replace(/\s*-\s*20\d{2}.*$/i, "")
      .slice(0, 28);
    return cleaned || `Moodle ${courseId}`;
  }

  function groupColor(courseId, preferredColor = "auto") {
    if (preferredColor !== "auto" && GROUP_COLORS.includes(preferredColor)) {
      return preferredColor;
    }

    const source = String(courseId || "moodle");
    let hash = 0;
    for (let index = 0; index < source.length; index += 1) {
      hash = (hash * 31 + source.charCodeAt(index)) >>> 0;
    }
    return GROUP_COLORS[hash % GROUP_COLORS.length];
  }

  function shortTabTitle(courseCode, courseName, pageTitle, isCoursePage) {
    const prefix = groupTitle(courseCode, courseName, "");
    if (isCoursePage) {
      return `${prefix} · Course`;
    }

    let title = normaliseWhitespace(pageTitle)
      .replace(/\s*\|\s*UNSW\s*$/i, "")
      .replace(/^course:\s*/i, "");
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    title = title
      .replace(new RegExp(`^${escapedPrefix}[^:]*:\\s*`, "i"), "")
      .replace(new RegExp(`^${escapedPrefix}\\s*[-–—:]\\s*`, "i"), "");
    if (!title || title === prefix) {
      title = "Moodle";
    }
    if (title.length > 58) {
      title = `${title.slice(0, 55).trimEnd()}…`;
    }
    return `${prefix} · ${title}`;
  }

  globalThis.MoodleUtilsTabManagerCore = Object.freeze({
    GROUP_COLORS,
    canonicaliseTabUrl,
    cleanCourseName,
    extractCourseCode,
    groupColor,
    groupTitle,
    normaliseWhitespace,
    shortTabTitle
  });
})();

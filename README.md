# Moodle Utils

A local Chrome Manifest V3 extension that combines six UNSW Moodle utilities:

## Installation

1. Download or clone this repository into a permanent folder. Do not delete or
   move that folder after installation unless you load it again from its new
   location.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked**.
5. Select the Moodle Utils folder containing `manifest.json`.
6. Optionally pin **Moodle Utils** from Chrome's Extensions menu for quick
   access to its feature switches and Course Tab Manager.

To install a later update, replace or update the files in the same folder, open
`chrome://extensions`, and click **Reload** on Moodle Utils. Existing Moodle
tabs should update automatically; refresh a discarded or unresponsive tab once
if Chrome could not inject the updated scripts.

## Included utilities

1. **Keep Moodle signed in** — sends Moodle's lightweight
   `core_session_touch` heartbeat every four minutes using the proven standalone
   Session Keeper logic.
2. **Close Mobius launch tabs** — conceals LTI launch pages before they paint,
   then closes the redundant intermediate tab 1.2 seconds after Mobius opens.
3. **Restore expired sessions** — verifies the session with an authenticated
   `/my/` request every four minutes, starts one coordinated UNSW sign-in flow
   when needed, and returns affected tabs to their exact intended URLs.
4. **Changed since last visit** — remembers each course page, highlights new
   and updated activities or sections, and lists removed items until you
   explicitly mark the changes as seen.
5. **Course Tab Manager** — identifies Moodle tabs by course, groups them,
   shortens their titles, prevents safe-to-close exact duplicates, and saves
   restorable course workspaces.
6. **Block myExperience popup** — prevents UNSW's recurring course-feedback
   survey prompt from loading and removes an already-injected copy.

The Guardian verification runs shortly after the Session Keeper heartbeat so the
two requests are staggered. Each feature can be enabled or disabled independently
from the extension popup. All six are enabled by default.

## Keepalive feedback

Successful `core_session_touch` heartbeats display a green notification at the
bottom-left of Moodle. Guardian `/my/` verifications display a blue notification
just above it. Failures display red or amber messages.

## Changed since last visit

The first visit to a course page establishes a baseline without marking
everything as new. On later visits:

- New activities and sections are highlighted in green.
- Renamed or otherwise updated items are highlighted in orange.
- Removed items appear in the change-review panel.
- Highlights remain until **Mark all seen** is pressed.

Snapshots stay in Chrome's local extension storage and never leave the browser.

## Course Tab Manager

Open **Course Tab Manager** from the main popup to use its dedicated menu.
The conservative defaults:

- Automatically group new Moodle tabs in the window where they opened.
- Use short titles such as `ELEC2133 · Week 8 Quiz`.
- Focus an existing tab instead of keeping a newly opened exact duplicate.
- Preserve manually created groups and their colours.
- Restrict course actions to the current window.
- Automatic duplicate removal refuses pages containing editable controls.
- Manual **Close course tabs** still closes untouched forms, but preserves
  pinned tabs and pages you actually edited.

**Organise open tabs** groups currently ungrouped Moodle pages and safely removes
exact duplicates. **Close course tabs** first records their sanitised URLs as a
local workspace. **Restore workspace** reopens and regroups the most recently
saved course workspace.

The optional settings can move tabs out of existing manual groups, include all
browser windows in course actions, or choose a fixed colour for newly created
groups.

## myExperience popup blocker

The blocker targets only the external `BlueMoodle.min.js` integration used for
the recurring **Please provide feedback for the following courses** prompt. A
fallback content check also removes that exact prompt if it was injected before
the network rule became active. Ordinary Moodle dialogs, announcements, tours,
and manually opened myExperience activities are not blocked.

## Security and limits

- The extension runs only on `https://moodle.telt.unsw.edu.au/*`.
- It never reads or stores passwords, authentication codes, or cookies.
- Chrome's `tabGroups` permission is used only to view and manage tab groups.
- Chrome's `declarativeNetRequest` permission blocks the single myExperience
  popup-integration script without reading any network traffic.
- Saved recovery URLs have Moodle `sesskey` parameters removed.
- Saved workspace URLs also have transient `sesskey` and notification
  parameters removed.
- A sleeping or powered-off laptop cannot send requests.
- Password, MFA, CAPTCHA, and university-enforced absolute session limits cannot
  be bypassed.
- Expired POST/form submissions are never replayed.

## Development checks

Run the local test suite with the bundled Node runtime:

```powershell
node tests\background.test.cjs
node tests\feature-scripts.test.cjs
node tests\change-detector-core.test.cjs
node tests\tab-manager.test.cjs
```

## Logo

The Moodle icon is derived from `Moodle-icon.png` on Wikimedia Commons. See
`THIRD_PARTY_NOTICES.md` for source and licensing information.

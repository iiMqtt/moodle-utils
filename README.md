# Moodle Utils

A local Chrome Manifest V3 extension that combines four UNSW Moodle utilities:

1. **Keep Moodle signed in** — sends Moodle's lightweight
   `core_session_touch` heartbeat every four minutes using the proven standalone
   Session Keeper logic.
2. **Close Mobius launch tabs** — closes the redundant Moodle LTI intermediate
   tab 1.2 seconds after Mobius opens, using the proven standalone LTI logic.
3. **Restore expired sessions** — verifies the session with an authenticated
   `/my/` request every four minutes, starts one coordinated UNSW sign-in flow
   when needed, and returns affected tabs to their exact intended URLs.
4. **Changed since last visit** — remembers each course page, highlights new
   and updated activities or sections, and lists removed items until you
   explicitly mark the changes as seen.

The Guardian verification runs shortly after the Session Keeper heartbeat so the
two requests are staggered. Each feature can be enabled or disabled independently
from the extension popup. All four are enabled by default.

## Update the currently installed extension

This folder is the same unpacked-extension folder used by the previous
**UNSW Moodle Session Guardian** build.

1. Open `chrome://extensions`.
2. Find the extension, now named **Moodle Utils**.
3. Click its **Reload** button.
4. Disable or remove the old standalone **UNSW Moodle Session Keeper** and
   **UNSW Moodle LTI Auto-Close** extensions to avoid duplicate scripts.

Existing Moodle tabs are injected automatically when Moodle Utils reloads. If
Chrome declines to inject into a discarded tab, reload that tab once.

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

## Security and limits

- The extension runs only on `https://moodle.telt.unsw.edu.au/*`.
- It never reads or stores passwords, authentication codes, or cookies.
- Saved recovery URLs have Moodle `sesskey` parameters removed.
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
```

## Logo

The Moodle icon is derived from `Moodle-icon.png` on Wikimedia Commons. See
`THIRD_PARTY_NOTICES.md` for source and licensing information.

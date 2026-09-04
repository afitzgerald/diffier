---
name: run-diffier
description: Launch Diffier (this repo's own Electron app) against a demo repo and take a screenshot. Use when asked to run/screenshot the app, or to regenerate the README/docs images.
---

Diffier is macOS-only per the README, but the Electron binary launches fine
locally via Playwright's `_electron` — no xvfb needed on a real macOS
session.

## Build first

```sh
yarn build
```

## Generate a demo repo

`demo-repo.mjs` builds the exact fixture used for `docs/screenshot.png` /
`docs/theme-light.png`: one committed file per VCS-status color the Changes
tree renders (modified, added/untracked, deleted, untracked at repo root).

```sh
node .claude/skills/run-diffier/demo-repo.mjs /tmp/acme-app
```

## Screenshot

```sh
node .claude/skills/run-diffier/driver.mjs /tmp/acme-app docs/screenshot.png
node .claude/skills/run-diffier/driver.mjs /tmp/acme-app docs/theme-light.png light
```

Args: `<repo-dir> <out.png> [light] [user-data-dir]`.

## Gotchas

- **Never launch without `--user-data-dir`.** Electron defaults to the real
  `~/Library/Application Support/Diffier` profile, which on a dev machine
  already has personal settings (theme, `panelSide`, window size) persisted
  from real use. A screenshot taken against that profile silently reflects
  someone's personal customization, not the app's defaults — this produced a
  completely different (mirrored) panel layout the first time. The driver
  always passes an isolated `--user-data-dir` for this reason.
- **Force `--force-device-scale-factor=1`.** Without it, a Retina display
  produces a 2x (2880x1800) capture instead of the 1440x900 the committed
  assets use.
- `window.setTheme(id)` (not `window.api.setSettings`) is what actually
  applies a theme live in the renderer — `setSettings` alone only persists
  it to disk, it doesn't touch the DOM. Theme ids: `islands-dark` (default),
  `islands-light`, `darcula`, `diffier-dark` (see `main/themes.ts`).
- `page.screenshot()` only captures the web content, not native window
  chrome — the macOS traffic-light buttons never appear in a Diffier
  screenshot regardless of `titleBarStyle`.

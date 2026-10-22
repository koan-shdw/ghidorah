# Skill pick icons

The seven pick icons on the Skills page come from their own repositories, each shrunk to 128 px and bundled as a PNG data URL.

## Sources

Each download is pinned to the commit that last touched the file (`work/skill-icons-src/fetch.py`, `sources.json`). Sizes match the ones the user approved.

| Pick | Repository | File | Commit | Bytes | SHA256 of the download | SHA256 of the bundled file |
|---|---|---|---|---|---|---|
| Caveman | JuliusBrussee/caveman | extension/icons/icon128.png | 4a96dc67b70a | 3,969 | da35da1341f8… | da35da1341f8… (unchanged) |
| Poteto Mode | cursor/plugins | pstack/assets/logo.png | 7314f723a487 | 361,140 | 672f6791589e… | 89ac5715e351… |
| Ponytail | DietrichGebert/ponytail | assets/logo.png | c7a62ec779ec | 567,655 | 818905aa5c99… | 1f202fc13dcf… |
| HyperFrames | heygen-com/hyperframes | assets/icon.png | d125d6516472 | 25,268 | cc97812c2f8b… | 347aa1e2b5af… |
| Impeccable | pbakaus/impeccable | extension/icons/icon-128.png | 9ec87e590d9c | 1,837 | 1939b3a61b01… | 1939b3a61b01… (unchanged) |
| Agent Reach | Panniantong/Agent-Reach | docs/assets/logo-1.png | ebbb69c37294 | 62,369 | a15044312da5… | 9120c48aadf9… |
| Open Design | nexu-io/open-design | apps/web/public/app-icon.png | 69d3bf4f71f3 | 77,017 | 3141cc3b348a… | e940179f9962… |

The bundled files are in `app/skill-icons/` (about 66 KB together).

## Checks

- Typecheck and build pass; the UI bundle carries the seven PNG data URLs. Unit tests: 91 passing.
- `tests/requests-1oct.e2e.ts` (dev build) now decodes every pick icon on the Skills page under the page's CSP (seven, each 128 px), installs Poteto Mode from its pinned GitHub folder through the reviewed path, and checks its icon in the Installed grid and its Installed mark in Our picks. All its earlier checks still pass. `plugins-ui` and `skills-conversion` pass.
- Visual check of the Skills page screenshot: icons on the seven tiles, initials on the rest.

## Package

- Release: `release-skill-icons/win-unpacked/Trismegistus.exe`, SHA256 `B1B28B4A5E93506FED6F36B12F1698F1D1EE0FBC08543E3EE2BAE1EE97A75CFC`. Both launchers were updated and read back (`work/skill-icons-launchers.json`). The running production app was not closed; tray Quit and reopen loads this build.
- 39 packaged bundle, backend and plugin files match the tested source, and the packaged UI carries the seven icons (`work/skill-icons-package-hashes.json`).
- Hardened startup with `ELECTRON_RUN_AS_NODE=1` set: backend ready, packaged, bundled Python present, real terminal command (`work/skill-icons-smoke-run.json`).

## Limits

- Only Poteto Mode was installed in the test; the other icon picks share the same match.
- The user's own running app has not loaded this build yet.

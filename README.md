# Ghidorah

<p align="center"><b>Claude Code, Codex, GPT and DeepSeek in one window.</b> For Windows.</p>
<p align="center">
  <a href="https://github.com/koan-shdw/ghidorah/releases/latest/download/Ghidorah-Windows-Setup.exe">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/buttons/download-windows-dark.svg">
      <img src=".github/buttons/download-windows-light.svg" alt="Download for Windows" height="64">
    </picture>
  </a>
</p>
<p align="center"><a href="https://github.com/koan-shdw/ghidorah/releases">every version</a></p>

## Install

Run the installer and pick a folder. The installer is not signed, so Windows asks once on the first install: More info,
then Run anyway.

After that Ghidorah updates itself: a chip in its title bar says restart to update, and what's new opens once after each
update. Chats, keys and settings stay where they are across updates.

## What it does

- **Every model in one chat.** Claude Code with your own sign-in, Codex and GPT, DeepSeek, Gemini, Grok, Kimi, GLM,
  OpenRouter and more, side by side or picked per message.
- **Real work.** Files, changes, terminal and preview panes beside the chat; approvals and permission modes; checkpoints.
- **Tools.** MCP servers, Claude Code plugins and skills, browser and screen control, repository maps.
- **Long jobs.** Background work, goals and routines that keep running while you do something else.
- **Voice and remote.** Dictation and live voice; answer approvals from your phone over Telegram.

## Build from source

Needs Windows 10 or 11 (x64), [Node.js 24](https://nodejs.org), [Git for Windows](https://git-scm.com) and
[uv](https://docs.astral.sh/uv/).

```bash
npm ci
powershell -ExecutionPolicy Bypass -File scripts/prepare-runtime.ps1
npm start
```

`prepare-runtime.ps1` installs Ghidorah's own Python 3.12 with Hermes's locked dependencies into `runtime/` (no system
Python is touched) and stages Hermes from `hermes/`.

`scripts\dev.cmd` runs the source as **Ghidorah Dev**: its own data folder (`%LOCALAPPDATA%\Ghidorah Dev`), keys,
taskbar entry and a DEV tag in the title bar, so it runs beside an installed Ghidorah without touching its chats.

### Checks

```bash
node node_modules/typescript/bin/tsc --noEmit -p .
npm test
```

Desktop tests live in `tests/*.e2e.ts` and run with `node --import tsx tests/<name>.e2e.ts`.

### Release

```bash
npm run release -- "What changed"
npm run release -- --publish
```

The first command bumps the version, writes the notes into `app/whats-new.json`, builds and hardens the installer and
commits it with a tag. Run the release checks on `updates/build/win-unpacked/Ghidorah.exe`, then publish: it pushes
`main` and the tag here and puts the installer on Releases, where installed copies find it.

## Layout

| Folder | What is in it |
| --- | --- |
| `app/` | Electron main process and the interface (TypeScript, React) |
| `backend/` | Python host: Hermes, keys in Windows Credential Manager, documents, images |
| `hermes/` | Our fork of Hermes Agent, the engine for every non-Claude model |
| `plugins/` | Hermes plugins Ghidorah installs: permissions and the remote gate |
| `share/` | Cloudflare Worker for shared pages |
| `scripts/` | Build, runtime staging, installer and release |
| `tests/` | Unit and desktop tests |
| `third-party/` | Bundled third-party files and their licences |

## Licence

MIT, see [LICENSE](LICENSE).

`hermes/` is a fork of [Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research (MIT, see
`hermes/LICENSE`), based on release v2026.9.24 (`f97608f`). It holds only the parts Ghidorah runs, with their tests.
Licences for other bundled work are in `third-party/`.

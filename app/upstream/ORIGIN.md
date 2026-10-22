Copied from Hermes Agent (MIT), commit f97608f178d1ffeca59860195ab7da295f7c8e5f.

Protocol files: apps/shared/src. Readiness helper: apps/desktop/electron/backend-ready.ts.
The generated contract is copied unchanged. The readiness helper has a ts-nocheck
directive because upstream compiles it with implicit-any enabled. LICENSE is retained.

MCP import and shape helpers: apps/desktop/src/lib/mcp-import.ts and mcp-servers.ts.
The import path is local; quoted Windows paths preserve backslashes before ordinary
characters. Parsing fills a review form and never executes the pasted command.

Editor theme: apps/desktop/src/components/chat/code-editor-theme.ts, copied unchanged.
The workspace uses the same pinned CodeMirror, xterm and node-pty libraries as Hermes Desktop.

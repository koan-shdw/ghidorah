@echo off
rem Test stand-in for cua-driver. "mcp" runs a fake MCP server (screen control tests); anything else fails, so the
rem Hermes test never acts (its approval is denied).
if /I "%~1"=="mcp" (
  node "%~dp0fake-cua-mcp.mjs"
  exit /b %errorlevel%
)
exit /b 1

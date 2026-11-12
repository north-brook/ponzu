# Changelog

## 0.3.322

- Updated to parity with Claude Code v2.1.322

## 0.3.321

- Fixed `canUseTool` getting the app's own PreToolUse hook reason in `decisionReason` when another hook also asked
- Fixed a PreToolUse hook's `ask` being lost when another hook's `defer` finished first and could not be honored
- Fixed every hook being dropped when one event in the `hooks` option is set to `undefined`
- Fixed `WarmQuery.query()` with a string prompt hanging after `startup()` with `resume` when the resumed session finished a turn of its own before the prompt was sent
- Fixed `setMcpServers` closing a folder's `.mcp.json` or local-scope MCP server when passed an in-process server of the same name, in sessions bound with `SpareProcess.claim()`

## 0.3.320

- Updated to parity with Claude Code v2.1.320

## 0.3.319

- Added MCP task support in SDK sessions (not on Bedrock, Vertex or Foundry): with `CLAUDE_AUTO_BACKGROUND_TASKS=1` and streaming input, an MCP task runs in the background with `task_type` `"mcp_task"`
- Fixed the OpenTelemetry `claude_code.session.count` metric counting `prewarm()` processes that were never claimed; a pre-started process now counts once, when `SpareProcess.claim()` succeeds
- Fixed `session_writes_lost` listing the wrong session in `transcript_session_ids` after `/clear` in a session resumed from a transcript file outside the projects folder
- Improved `deleteSession()` to reject with `ENOTEMPTY` if the session's folder could not be fully deleted
- Changed `session_writes_lost` to be sent only when the CLI exits 0; a run that ends on an error result now gets only the stderr line


# React renderer

Four-column, project-centric vertical slice using `window.ame` exclusively. Layout tokens and the supplied HTML reference live in `packages/ui/styles`. Monaco and its language workers are bundled locally; no CDN is used.

## State and safety

- `ame.ide.layout.v1` stores theme, panel widths/visibility, active project, project sessions and tab paths. File contents and credentials are never persisted by the renderer.
- Unsaved buffers remain in memory across project and session switches. Closing a dirty tab or reloading it requires confirmation. `beforeunload` prevents app close with any dirty buffer; Electron main must show its native discard confirmation for `will-prevent-unload`.
- Filesystem invalidation reloads clean buffers and flags dirty/deleted buffers as conflicts. Saves carry the original revision and never automatically overwrite a conflict. Changes typed during an in-flight save are preserved.
- Explicitly closing Inspector keeps it hidden through tab/session/project switches. Use the Inspector title-bar button or Ctrl/Cmd+Alt+B to show it again.
- Chat refreshes are coalesced after invalidation and polled at approximately one second. Only server-returned messages are rendered; no assistant responses or artifacts are synthesized. The corner drawer is session-scoped and labels available agents separately from running work.

## Verification

From `ide`:

```powershell
node --import tsx --test apps\desktop\src\renderer\test\layout.test.ts
npm run typecheck
npm run build
```

Stable smoke selectors: `data-testid="shell"`, `inspector`, `explorer`, `chat`, `editor`.

Native services own validation, model readiness and destructive-operation confirmations. Account admin controls follow the server-provided role. Live account/backend authorization and streaming require a configured compatible server. LSP, artifact APIs and detailed running-agent status are outside this slice.

## Foundation controls

- Ctrl/Cmd+Enter commits only with a nonempty message and staged files, outside IME composition and busy operations; form submission uses the same guard.
- Ctrl/Cmd+Shift+Backquote opens the stage and creates a terminal for the selected project, even from terminal focus. Ctrl/Cmd+Backquote toggles the panel. Windows discovers Git Bash when installed alongside PowerShell/CMD.
- Theme changes update the existing xterm options without replacing the terminal or replaying a snapshot. Clear Terminal clears the visible xterm buffer, not the backend output history.
- The project rail remove button requires native confirmation. Removal closes owned terminals and watchers and forgets in-memory documents, sessions and layout for that project; it never deletes files. Unsaved in-memory edits are discarded on confirmed removal.
- Every dirty file tab shows a marker, including inactive tabs; diff tabs never show it. Dirty paths are scoped to the selected project.

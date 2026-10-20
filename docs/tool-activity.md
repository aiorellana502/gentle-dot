# Tool activity details

Expand an activity summary to see a recognized tool name and its textual outcome:
**Running**, **Completed** or **Failed**. Completed summaries still group activity
counts; the disclosure supports keyboard activation and reports its expanded state.

## Privacy baseline (T2A)

- Only fixed, recognized tool identities are displayed. Unknown integrations and
  older payloads without a recognized identity display **Tool**.
- Activity titles remain neutral and path-free. File targets follow the bounded
  project-relative policy below; legacy titles are never used as a fallback.
- Arguments, commands, prompts, results, URLs and error contents are never activity
  details. Failed means the tool reported failure, not an error-content preview.
- Live calls and reconstructed history use the same presentation policy. The UI
  ignores legacy titles, including while a call is running.

The optional identity field preserves compatibility with older clients. Activity
IDs, message association, status updates and grouped counts are unchanged. This
changes presentation only, not tool permissions or stored sessions.

## Project-relative targets (T2B)

For recognized `read`, `write` and `edit` calls, details may show
`read · src/app.ts · Completed`. The daemon uses only the engine's trusted,
normalized absolute workspace root, never a root supplied by tool arguments.
`path`, `file_path` and `filePath` are accepted only as string candidates.

Only normalized interior logical paths are displayed, with forward slashes.
External paths, the workspace root itself, unknown tools, missing context,
UNC paths, drive-relative paths, URLs and control-character payloads stay hidden.
No placeholder path is shown. The UI also rejects absolute or malformed targets
and targets attached to unrecognized or non-file tools.

Live activity and history reconstruction share this policy. History caches include
workspace context so targets cannot persist across a different or absent root.
The optional target field is backward compatible. This is pure string/path
presentation: no file reads, symlink resolution, new permissions or guarantee of
operating-system confinement. Real-panel acceptance remains separate in T2C.

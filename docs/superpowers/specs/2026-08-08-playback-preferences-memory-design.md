# Playback Preferences Memory Design

**Date:** 2026-08-08

**Goal:** Keep the user's selected playback mode after Mineradio is closed and opened again, while preserving the existing persistence behavior for volume and desktop-lyrics settings.

## Scope

This change covers the three playback modes already supported by the renderer: sequential loop (`loop`), shuffle (`shuffle`), and single-track loop (`single`). It also verifies that the existing volume and desktop-lyrics persistence remains part of the startup behavior.

Current-song and playback-position restoration are out of scope for this change because the existing playback snapshot already owns that behavior.

## Design

Add a renderer preference key for the playback mode using the existing `localStorage` pattern. The preference is independent from the queue snapshot and from the visual-settings autosave payload.

The preference API has two small responsibilities:

1. Normalize a stored value to `loop`, `shuffle`, or `single`, falling back to `loop` for missing or invalid data.
2. Read the normalized value at state initialization and write it whenever the user cycles the playback mode.

The initial `playMode` value must be read before the player controls render their first label, icon, and active state. `cyclePlayMode()` must save the new mode after applying its existing shuffle reorder behavior. Clearing the queue must not remove the preference.

## Data Flow

```text
localStorage[playback-mode]
        |
        v
state initialization -> playMode -> updatePlayModeButton()
        ^
        |
cyclePlayMode() -> normalize -> write preference
```

Volume continues to use `apex-player-volume`. Desktop-lyrics switches, dimensions, opacity, Y position, click-through, cinema motion, highlight, and FPS continue to use the existing visual autosave payload and schema. No migration or key replacement is required.

## Compatibility and Failure Handling

- Missing storage, malformed storage, and unknown mode values resolve to `loop`.
- Storage read/write failures are swallowed consistently with the existing preference helpers; playback remains usable for the current session.
- Existing saved volume and visual settings must not be overwritten when the playback-mode preference is read or written.
- The public mode labels, icons, shuffle reordering, and next-track behavior remain unchanged.

## Testing

Add focused Node tests in the repository's existing `node:test` style. The tests should exercise the real preference helper source in a small VM-like browser storage harness and assert:

- a missing mode defaults to `loop`;
- each supported mode round-trips through storage;
- an invalid stored mode falls back to `loop`;
- cycling from each mode writes the next mode;
- the startup source reads the saved mode instead of hard-coding `loop`;
- existing volume and desktop-lyrics storage paths remain present and are not replaced.

Run the focused tests, the complete Node test suite, and syntax checks for modified JavaScript files before claiming completion.

## Non-Goals

- Changing the meaning or order of the existing playback modes.
- Persisting the queue contents, current song, or playback position beyond the existing snapshot behavior.
- Moving settings from renderer storage to Electron IPC or a new user-data file.
- Redesigning the settings UI or changing desktop-lyrics visuals.

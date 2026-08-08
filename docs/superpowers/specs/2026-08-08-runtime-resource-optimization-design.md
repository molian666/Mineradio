# Runtime Resource Optimization Design

**Date:** 2026-08-08

**Goal:** Reduce Mineradio's CPU and memory use during long-running foreground and background sessions while preserving playback, lyrics, beat synchronization, and desktop wallpaper behavior.

## Scope

This change covers the browser renderer runtime loop, recurring renderer-side maintenance tasks, and unbounded or incorrectly-accounted in-memory caches in the main process and renderer. It does not change provider selection, playback ordering, login protocols, audio output routing, or wallpaper IPC contracts.

The existing background deep-sleep and cache-trim behavior remains the base policy. The change adds explicit lifecycle scheduling around it and makes cache limits consistent.

## Runtime States

The renderer uses three effective runtime states:

1. **Active playback or interaction:** Keep display-synchronized rendering for playback, progress dragging, lyrics, beat camera work, and user interaction. Audio analysis runs only when an analyser, active media, and playback are all present.
2. **Visible idle:** Keep the visual scene responsive but use a bounded low-frequency cadence. Skip Web Audio reads and repeated DOM/IPC work that cannot change while paused or inactive.
3. **Deep background:** Preserve the existing 3D renderer resize-to-4x4 and cache trim behavior. Run only the low-frequency playback snapshot needed to preserve background playback statistics, plus explicitly enabled desktop lyrics or wallpaper health work.

The scheduler must expose a wake path for playback state changes, pointer/keyboard interaction, progress dragging, visibility changes, focus restoration, and desktop lyrics/wallpaper state changes. A wake schedules an immediate frame and does not create duplicate timers or animation frames.

## Renderer Changes

### Main loop

Update `public/js/modules/11-main-loop.js` to distinguish active playback/interaction from visible idle. Active playback continues to follow VSync. Visible idle uses the existing frame-gate model at a lower fixed cadence and avoids repeatedly entering expensive audio-analysis work. Deep background continues to use the existing delayed timer path.

The implementation must keep `prevTime` and accumulated frame-gate delta bounded after a delayed frame, so restoring a minimized window cannot produce a large catch-up spike. Existing splash, adaptive render, desktop overlay, and renderer recovery paths remain intact.

### Recurring renderer tasks

Update the progress/statistics task in `public/js/modules/06-lyrics/04-progress-seek.js` so it is scheduled only while there is work to do. Visible playback may use the normal progress cadence; hidden playback may use the existing one-second snapshot cadence; paused and unloaded states must not keep a 200 ms timer alive.

Update the desktop overlay health task in `public/js/modules/10-shell/04-desktop-overlay-fullscreen.js` to start and stop from desktop lyrics/wallpaper state changes. Its cadence must not run when both features are disabled, and it must stop on page hide. Existing deduplication and IPC payload behavior remain unchanged.

No change is required for feature-scoped timers such as album gapless monitoring, audio-output mirror synchronization, QR login polling, or fullscreen visibility recovery. They remain active only while their owning feature is active and are reviewed for cleanup in the implementation tests.

## Cache Policy

### Main-process caches

Introduce a small reusable bounded TTL cache helper in the server-side cache area, or an existing-compatible local helper if one already exists. The helper must support `get`, `set`, `delete`, `clear`, `size`, TTL expiration, and oldest-entry eviction without changing cached value shapes.

Apply it to caches that can grow with user/provider/song variation, including QQ VIP info, QQ liked playlist cover records, and Netease source-match records. Existing provider-specific TTL values remain the freshness source; capacity limits are added separately. Existing Netease playlist-track and Qishui decrypted-audio policies remain compatible.

For `qishuiAudioDecryptCache`, preserve the 96 MB byte budget and update byte accounting by subtracting a replaced entry before adding the new payload. Eviction must update the byte counter even when an entry is removed because of a replacement or expiration. LRU ordering should use the existing `at` timestamp or an equivalent monotonic access update.

### Renderer caches

Keep current-song, nearby-queue, in-flight, and currently visible cover records protected. Add bounded access-order behavior for playlist covers, beat maps, DJ beat maps, and Cuefield audio descriptors. The existing background trim remains the fallback cleanup path, but normal insertion and access must not allow unbounded growth before that trim runs.

Cache cleanup must not dispose resources still referenced by the current scene. Existing `coverDepthCache` disposal and stage-lyrics disposal rules remain authoritative.

## Error Handling and Compatibility

Timer callbacks must tolerate destroyed media, unavailable renderer objects, hidden documents, and stale playback tokens. A failed maintenance callback must clear or reschedule its own timer without creating a retry loop.

All existing public globals used by the modules remain available. New scheduler helpers should be small, named functions exposed only where an existing module boundary requires them. No new dependency is needed.

## Testing

Add focused Node tests using the repository's existing `node:test` style and source-level lifecycle assertions where Electron integration is not available. Cover:

- visible idle and deep background scheduling do not retain high-frequency timers;
- playback/visibility transitions wake the runtime and avoid duplicate scheduling;
- feature-scoped desktop overlay health work is inactive when both features are disabled;
- bounded caches evict expired/old entries while preserving protected or current entries;
- replacing a Qishui decrypted-audio cache key keeps byte accounting correct;
- existing shutdown and playback lifecycle tests remain valid.

Verification includes focused tests, the full Node test suite, JavaScript syntax checks for modified files, and the existing Windows directory build when the local Electron toolchain permits it.

## Non-Goals

- Moving audio analysis or visual work to a Worker.
- Replacing Three.js, Electron, or the existing renderer architecture.
- Forcing system-wide memory purges while Mineradio is visible.
- Changing visual quality defaults solely to reduce resource use.
- Removing feature-scoped timers that are required for active playback or authentication.

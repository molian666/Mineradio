# Kugou Playlist Session Validation

## Goal

Only report a Kugou login as playlist-sync ready after the saved web session is accepted by Kugou's cloud-playlist service. A cookie that merely contains `userid` and `token` must not close the login window or enter the normal playlist refresh path when the service rejects it.

## Evidence

The live account request to `/v7/get_all_list` produced these distinct responses:

- the project's correctly signed JSON request returned `status: 0, error_code: 20017`;
- an intentionally invalid signature returned `error_code: 20006`;
- an invalid form request returned `error_code: 20010`.

This separates the observed failure from transport, JSON, and signature failures. The existing Electron login window nevertheless treats any cookie containing `userid` and `token` as complete and closes immediately, without validating that session against the cloud-playlist service.

## Design

### Backend validation contract

Add a small Kugou session-validation function at the API boundary. It performs the same read-only cloud-playlist request used by synchronization and returns a structured result containing:

- whether account identity fields are present;
- whether the cloud-playlist request succeeded;
- the provider error code without exposing cookie, token, user ID, or MID values;
- whether reauthentication is required.

`error_code: 20017` is classified as a rejected playlist session. Network errors and other provider failures remain retryable service errors and must not erase the last successful playlist rows.

### Login-window state machine

The Electron Kugou login window must not reuse or finish from `kugouCookieHasPlayback(cookie)` alone.

1. Validate an existing partition cookie before returning `reused: true`.
2. If validation reports a rejected session, clear the stale login partition once and load the official login page.
3. While the window is open, validate only when the account-cookie fingerprint changes, preventing a request every polling interval.
4. Finish and persist the cookie only after validation succeeds.
5. If the user closes the window before validation succeeds, return a truthful failure instead of a partial success.

The fingerprint is derived locally and is never logged. Validation remains read-only.

### Server and renderer behavior

The user-playlist endpoint preserves the provider error code and exposes `reauthRequired` for a rejected session. Existing transactional catalog handling keeps the last successful rows on all failures. After a validated login succeeds, the existing forced refresh rebuilds the non-merged catalog, playback queue "My Playlists" view, and 3D shelf from the same `userPlaylists` array.

### Diagnostics

Keep the existing `[KugouPlaylistSync]` markers. Add only safe fields such as provider error code, validation outcome, and `reauthRequired`; never log raw cookie/token/account identifiers.

## Testing

Add regression coverage before implementation for:

- a field-complete cookie rejected with provider code `20017` being classified as requiring reauthentication;
- a successful cloud-playlist response being classified as validated;
- the Electron login path not reusing or completing from cookie shape alone;
- duplicate polling of an unchanged rejected cookie being suppressed;
- diagnostic lines remaining free of credentials;
- the last successful renderer catalog remaining intact on validation failure.

Run the focused Kugou tests, Electron login-state tests, syntax checks, `git diff --check`, and the complete Node test suite.

## Scope

This design supersedes the incomplete-token assumption in Task 3 of the earlier Kugou playlist resilience plan. It does not add a speculative alternate Kugou playlist API, change unrelated provider login behavior, or modify playlist/shelf presentation.

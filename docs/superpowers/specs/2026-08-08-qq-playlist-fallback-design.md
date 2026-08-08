# QQ Music Playlist Fallback

## Goal

When adding a song to a QQ Music playlist fails, tell the user that QQ Music synchronization is not implemented yet, while preserving the song by adding it to the merged playlist's local collection.

## Behavior

1. Keep the existing QQ Music playlist write attempt.
2. On QQ Music write failure, add the target song to the merged playlist local-collection source.
3. Show `同步到 QQ 音乐暂未实现，已加入合并歌单（本地收藏）` when local storage succeeds.
4. Show `同步到 QQ 音乐暂未实现` if the local fallback cannot be saved.
5. Keep non-QQ playlist failure handling unchanged.

## Scope

The change is limited to the track-detail playlist collection flow, merged-playlist local collection fallback, and regression coverage. It does not change QQ Music API behavior or other providers.

## Verification

Add or preserve regression assertions for the QQ failure fallback, user-facing messages, and local merged-playlist storage. Run the focused playlist synchronization test and the repository quick checks available for this behavior.

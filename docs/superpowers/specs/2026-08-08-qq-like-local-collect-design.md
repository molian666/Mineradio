# QQ Like Local Collection

## Goal

When a user likes a QQ Music song, avoid the unavailable QQ Music write API and store the song directly in the merged playlist's local collection.

## Behavior

1. For QQ songs, liking must not call `/api/qq/song/like` or require QQ login.
2. When the song is not locally liked, add it to the merged playlist local-collection source.
3. On successful local add, show `QQ 音乐同步暂未实现，已加入合并歌单（本地收藏）`.
4. When the song is locally liked, a second click removes it from the merged playlist local-collection source.
5. On successful local removal, show `已从合并歌单移除（本地收藏）`.
6. If local persistence fails while adding, show `QQ 音乐同步暂未实现，本地收藏失败` and leave the like state unchanged.
7. Existing like behavior for Netease, Kugou, Spotify, and Qishui remains unchanged.

## State and UI

The QQ local-collection operation updates `likedSongMap` only after a successful storage operation. It then refreshes like buttons, search/queue action state, and marks the merged playlist cache dirty so the merged catalog can observe the change.

## Scope

The change is limited to the frontend like toggle flow, the existing merged local-collection helpers, and regression tests. QQ server write endpoints remain available for unrelated callers but are not used by the QQ like button.

## Verification

Add regression coverage proving the QQ like path bypasses the QQ like endpoint, adds/removes local collection entries, emits the specified messages, and leaves other provider paths unchanged. Run the focused playlist synchronization tests and the full Node test set.

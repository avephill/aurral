# Navidrome per-user libraries

- Status: Accepted
- Date: 2026-09-03
- Applies to: the `feat/user-libraries` fork, verified against Navidrome 0.63.2 (`be10f89`)

## Context

Personal libraries are symlink farms: `<rootPath>/<username>/<Artist>` links to the
artist folder in the main Lidarr-managed library, and each farm is registered with
Navidrome as its own library. The point is that a family member browsing their own
library never sees the artists someone else added.

That works, but it puts the same physical file in more than one Navidrome library,
which Navidrome does not treat as one thing.

## The constraint everything follows from

A playlist entry, a play count, a star and a rating all hang off a `media_file` row,
and a `media_file` row belongs to exactly one library. The same file symlinked into a
personal library gets a **second, unrelated row with a different id**.

This is deliberate, not an oversight. Navidrome computes a content-level persistent id
from tags (`musicbrainz_trackid|albumid,discnumber,tracknumber,title`) and then prepends
the library id to it — `model/metadata/persistent_ids.go`, `computePID(..., prependLibId)`.
Navidrome's model assumes libraries are disjoint collections.

Consequences, all measured on this server:

- **Duplicate browsing.** With two libraries selected, a sampled 200 albums produced 55
  names appearing in 2-4 libraries at once.
- **Playlists are library-bound.** `persistence/playlist_repository.go` `loadTracks()`
  calls `applyLibraryFilter(sel, "f")`. A user without the source library gets the
  playlist listed with **zero tracks and no error**. Verified: a probe user holding only
  library 5 saw 34 playlists and `songCount=0` on all of them.
- **Annotations fragment.** Play counts and stars accumulate per library row. Starring a
  song while browsing a personal library does not star it in the main library.

The only identity shared across libraries is the **library-relative path**, which is
identical for a file and its symlink. That is what the repair tooling maps through.

## Decision

**Every user keeps the main library assigned, plus their own.** Library *assignment*
(server-side, `user_library`) is what a user can play. Library *selection* (client-side
`musicFolderId`) is what they browse. They are independent, and playlists ignore the
selection filter:

```
getArtists musicFolderId=5      ->  840 artists   (curated view)
getArtists musicFolderId=1      -> 2418 artists
getPlaylist + musicFolderId=5   ->  707 entries   (filter ignored)
```

So the curated view comes from selecting one library in the client, and shared playlists
keep working because the main library is still assigned.

**Never remove the main library from a user** to enforce their subset. Playlists go
silently empty. `planNavidromeLibraries` appends to the existing assignment rather than
replacing it, which keeps this safe; a Navidrome user created with no libraries at all
would still land in the broken state.

**Playlists are normalised to one canonical library.** `navidromePlaylistRepair.js`
rewrites every entry to the main library's copy and keeps the first occurrence of each
path. This fixes both the authoring trap (a playlist built while browsing a personal
library) and per-library duplicate entries. It is a one-shot script today
(`scripts/repair-navidrome-playlists.mjs`), not a scheduled guard.

**File-backed playlists are never rewritten.** A playlist with a `path` comes from an
`.m3u` on disk or an `.NSP` smart-playlist rule and Navidrome re-syncs it from that
source. Because the farms mirror album folders, album `.m3u` files are imported once per
library — five such duplicates existed here. Navidrome's `PlaylistsPath` setting controls
which folders playlists are imported from and is the fix at source.

## What this does not give you

The personal library is a browse convenience, **not an access boundary**. Any user can
select the main library in their client and see everything. Real restriction and shared
playlists are mutually exclusive under this model, because Navidrome resolves playlist
tracks through library access.

Getting a curated view, working shared playlists and no duplicates *simultaneously and
enforced* would need per-user playlist mirroring: each subscriber gets their own copy of
a shared playlist using their library's ids. Aurral cannot do this — the native API
forces playlist ownership to the calling user (verified: `ownerId` is overwritten with
the admin's id). Only a Navidrome plugin can act as another user, via
`plugins/host_subsonicapi.go` `request.WithInternalAuth(ctx, username)` with the
`subsonicapi` and `users` permissions. That is a separate component, not an aurral change.

No small upstream patch fixes this. Loosening `applyLibraryFilter` would break a real
permission boundary, and giving playlists cross-library identity means changing what a
PID means — a schema migration and full rescan for every Navidrome install.

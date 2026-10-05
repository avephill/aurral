# Working in this fork

This is Avery's fork of Aurral, running in production on Hayduke for real
people: Avery, and their dad, who reaches it as an installed desktop app called
Psalter. Treat it as software with users, not a sandbox.

## Every deploy gets its own version

Never build the image by hand. Use:

```
scripts/deploy.sh
```

It stamps the image with `git describe --tags --always --dirty`, which reads
like `v2.8.0-108-g31d6e133`: the upstream release this descends from, the
distance past it, and the exact commit. After deploying it asks the running app
what version it reports and fails if the answer is not the version just built,
so a deploy that silently kept the old image cannot pass unnoticed.

A build from an uncommitted tree is stamped `-dirty` and warns. That is allowed
for a quick test and unacceptable for anything Avery's dad will see: if someone
reports a bug, the version has to lead back to source that can be read.

The version surfaces at `/api/health` as `appVersion`, and in the UI. Passing
`APP_VERSION` at build time is what makes this work; the Dockerfile takes it as
a build arg and defaults to `unknown`, which is what a hand-built image reports.

Tag a release (`git tag vX.Y.Z`) when a batch of work is worth naming. Between
tags the describe string is enough to identify a deploy, so there is no need to
tag every commit.

## Deploy configuration lives outside the repo

`docker-compose.yaml` and the `.env` sit in the parent directory, not here.
Environment changes, like `SESSION_EXPIRY_HOURS`, belong there rather than in
committed defaults, because they describe this one installation.

## Changing the music library

The music on disk is shared by several people's personal libraries, and
everything they have done with it - ratings, play counts, favourites,
playlist entries - hangs off Navidrome ids that change when a file's path does.
Learned the hard way in October 2026; read this before touching
`/data/Music/Library`, Lidarr, or anyone's library links.

- **Lidarr is the backbone.** Music gets into the library through Lidarr, by
  MusicBrainz release, never by copying files into `Library/` by hand: files
  Lidarr does not manage end up in everyone's libraries who follow that artist,
  outside Psalter's index, and get adopted by Lidarr's rescans in ways no one
  chose. `scripts/import-library/` is the supported way to import a folder.
  Anything Lidarr cannot identify belongs in a holding folder outside
  `Library/`, not in it.
- **Lidarr has no recycle bin.** An import with `replaceExistingFiles` deletes
  the file it replaces, for good. Switching an album's edition detaches all its
  track files until they are imported again.
- **Never run anything inside the container as root.** Psalter runs as `node`;
  a root-owned file in `users/<name>` freezes that person's library, and every
  change to it then fails quietly.
- **Before any change that moves, deletes or relinks files:** snapshot every
  affected person (`libraryHistoryService.takeSnapshot`) and record their play
  counts (`libraryMoves.capturePlayCounts`), which snapshots do not keep. Try
  it on one small artist first.
- **After it:** scan the moved folders in every personal library that links
  them - `NavidromeClient.scanFolders(["4:the Microphones", ...])` - because a
  plain scan refreshes only the main library, and personal libraries keep
  listing the old paths. Then wait for that scan and for the playlist normaliser
  (`[Playlists] Normalised` in the log, or its "Smart testing" warning - a
  deploy and a Lidarr import both start one). Build the old -> new path map
  with `libraryMoves.pathsMovedByLidarr`, then `compareWithNow` each person's
  snapshot with it. Restore what differs with `restoreSnapshot(..., { pathMap })`
  and `replayPlayCounts`, and compare again until nothing differs.
  `backend/services/libraryMoves.js` describes the full order.
- **What survives what.** Files moved within the main library (Lidarr import
  or rename) keep their ratings, plays and playlist entries. Changing how a
  personal library links a folder (a whole-folder link becoming per-album
  links) does not: every song in it gets a new id. Anything pointing at a
  deleted file is lost unless the path map says what it stands for.
- **Re-sent plays never go to Last.fm or ListenBrainz.** `replayPlayCounts`
  sends them from a `psalter-restore` player with external scrobbling off and
  refuses to send otherwise. If a job ever needs someone to unlink a scrobbler,
  ask them to link it again as its own step, and check that they did.
- **Playlist writes go through `navidromePlaylistWrites.js`.** A person's own
  Navidrome connection hides entries from libraries they cannot open while
  Navidrome counts positions against the whole list, and Navidrome silently
  ignores a request with more than 10,000 parameters. Do not rewrite or remove
  playlist entries by position through a user client.
- **Never rewrite playlists while a deploy is starting up** or a reconcile is
  running: the normaliser rewrites the same playlists, and two writers
  interleaving doubled a playlist of 11,997 songs.

## Local build and test gotchas

- `react-router-dom` may be missing from the local `node_modules`, and then
  every test that builds the whole app fails here while passing in Docker -
  five of them, including the service worker test, which is easy to mistake for
  five unrelated known failures. Install it and the suite is green:

  ```
  npm install --no-save --engine-strict=false react-router-dom --workspace frontend
  ```

  Both flags are needed: `.npmrc` sets `engine-strict`, and the repo pins Node
  22 while the machine runs a newer one.
- Frontend tests boot Vite, and a permission or resolve error inside it hangs
  the run instead of reporting anything. `npm test` passes `--test-force-exit`
  for that reason - keep it there, and keep it on any test command you write by
  hand. A hung run looks exactly like a slow one, so if a suite seems to be
  taking unusually long, check whether its log is still growing before waiting
  on it.
- Verify CSS with lightningcss from `node_modules` rather than a full build.

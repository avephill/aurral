import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { initializeSchemaOnStartup } from "./schema-migration-v2.js";
import { initializeLibrarySearchIndex } from "./library-search-index.js";
import { syncDownloadFolderPath } from "../services/downloadFolderConfig.js";
import { ensureDataDir } from "./data-dir.js";

const DATA_DIR = ensureDataDir();

const DB_PATH = process.env.AURRAL_DB_PATH
  ? path.resolve(process.env.AURRAL_DB_PATH)
  : path.join(DATA_DIR, "aurral.db");

if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("synchronous = NORMAL");
db.pragma("cache_size = -24000");
db.pragma("mmap_size = 25165824");

function tryAddColumn(sql) {
  try {
    db.exec(sql);
  } catch (error) {
    if (
      !String(error?.message || "")
        .toLowerCase()
        .includes("duplicate column name")
    ) {
      throw error;
    }
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS discovery_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    last_updated TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS images_cache (
    mbid TEXT PRIMARY KEY,
    image_url TEXT,
    images_json TEXT,
    cache_age INTEGER,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    permissions TEXT,
    discover_layout TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS lastfm_link_states (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    browser_nonce_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_lastfm_link_states_expiry
    ON lastfm_link_states(expires_at);

  CREATE TABLE IF NOT EXISTS subsonic_stars (
    user_id INTEGER NOT NULL,
    entity_kind TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, entity_kind, entity_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS play_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    track_id TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT,
    artist_mbid TEXT,
    album_mbid TEXT,
    track_mbid TEXT,
    duration_ms INTEGER,
    played_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_play_events_user_played_at
    ON play_events(user_id, played_at DESC);

  CREATE TABLE IF NOT EXISTS playlist_download_jobs (
    id TEXT PRIMARY KEY,
    artist_name TEXT NOT NULL,
    track_name TEXT NOT NULL,
    album_name TEXT,
    reason TEXT,
    artist_mbid TEXT,
    album_mbid TEXT,
    track_mbid TEXT,
    release_year TEXT,
    duration_ms INTEGER,
    track_number INTEGER,
    album_track_count INTEGER,
    album_track_titles TEXT,
    artist_aliases TEXT,
    playlist_id TEXT NOT NULL,
    playlist_type TEXT,
    status TEXT NOT NULL,
    staging_path TEXT,
    final_path TEXT,
    error TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    download_source TEXT,
    download_client TEXT,
    download_client_id TEXT,
    release_guid TEXT,
    release_title TEXT,
    indexer_id TEXT,
    indexer_name TEXT,
    slskd_search_id TEXT,
    slskd_batch_id TEXT,
    remote_username TEXT,
    remote_filename TEXT,
    denied_remote_sources TEXT,
    quality_tier TEXT,
    quality_format TEXT,
    quality_bitrate_kbps INTEGER,
    quality_sample_rate_hz INTEGER,
    quality_bit_depth INTEGER,
    quality_checked_at INTEGER,
    quality_upgrade_checked_at INTEGER,
    upgrade_for_job_id TEXT
  );

  CREATE TABLE IF NOT EXISTS deezer_mbid_cache (
    cache_key TEXT PRIMARY KEY,
    mbid TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS musicbrainz_artist_mbid_cache (
    artist_name_key TEXT PRIMARY KEY,
    mbid TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS artist_overrides (
    mbid TEXT PRIMARY KEY,
    musicbrainz_id TEXT,
    deezer_artist_id TEXT,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS lidarr_artist_id_map (
    musicbrainz_id TEXT PRIMARY KEY,
    lidarr_foreign_artist_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS library_artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_key TEXT NOT NULL UNIQUE,
    mbid TEXT,
    name TEXT NOT NULL,
    sort_name TEXT,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS library_albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_key TEXT NOT NULL UNIQUE,
    mbid TEXT,
    release_group_mbid TEXT,
    artist_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    album_artist TEXT,
    release_date TEXT,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (artist_id) REFERENCES library_artists(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS library_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_key TEXT NOT NULL UNIQUE,
    mbid TEXT,
    title TEXT NOT NULL,
    artist_name TEXT,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS library_album_tracks (
    album_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    disc_number INTEGER NOT NULL DEFAULT 1,
    track_number INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (album_id, track_id, disc_number, track_number),
    FOREIGN KEY (album_id) REFERENCES library_albums(id) ON DELETE CASCADE,
    FOREIGN KEY (track_id) REFERENCES library_tracks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS library_media_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER NOT NULL,
    album_id INTEGER,
    source TEXT NOT NULL,
    path TEXT NOT NULL,
    format TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    mtime_ms INTEGER,
    duration_ms INTEGER,
    quality_json TEXT,
    available INTEGER NOT NULL DEFAULT 1,
    last_seen_scan_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (source, path),
    FOREIGN KEY (track_id) REFERENCES library_tracks(id) ON DELETE CASCADE
  );

  -- Which folder a person files a Navidrome playlist under. Navidrome has no
  -- notion of a folder, so the tree lives here; every client still sees one
  -- flat list of playlists, which is what Navidrome holds.
  CREATE TABLE IF NOT EXISTS navidrome_playlist_folders (
    user_id INTEGER NOT NULL,
    playlist_id TEXT NOT NULL,
    folder TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, playlist_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Navidrome's id for one indexed file, per Navidrome library. Learned the
  -- first time a track is resolved and reused after that, so path lookups stop
  -- repeating and a song id can be turned back into a file.
  CREATE TABLE IF NOT EXISTS navidrome_song_ids (
    media_path TEXT NOT NULL,
    library_id INTEGER NOT NULL,
    song_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (media_path, library_id)
  );

  CREATE TABLE IF NOT EXISTS library_scan_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    root_path TEXT,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    error TEXT,
    files_seen INTEGER NOT NULL DEFAULT 0,
    files_indexed INTEGER NOT NULL DEFAULT 0,
    files_failed INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_lidarr_artist_id_map_foreign_id
    ON lidarr_artist_id_map (lidarr_foreign_artist_id);
  CREATE INDEX IF NOT EXISTS idx_library_albums_artist_id
    ON library_albums (artist_id);
  CREATE INDEX IF NOT EXISTS idx_library_albums_mbid
    ON library_albums (mbid);
  CREATE INDEX IF NOT EXISTS idx_library_albums_release_group_mbid
    ON library_albums (release_group_mbid);
  CREATE INDEX IF NOT EXISTS idx_library_albums_title
    ON library_albums (title COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_library_albums_release_date
    ON library_albums (release_date DESC);
  CREATE INDEX IF NOT EXISTS idx_library_artists_sort_name_name
    ON library_artists (sort_name COLLATE NOCASE, name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_library_artists_mbid
    ON library_artists (mbid);
  CREATE INDEX IF NOT EXISTS idx_library_artists_provider_id
    ON library_artists (CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.id') END AS TEXT));
  CREATE INDEX IF NOT EXISTS idx_library_artists_foreign_artist_id
    ON library_artists (CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.foreignArtistId') END AS TEXT));
  CREATE INDEX IF NOT EXISTS idx_library_artists_name
    ON library_artists (name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_library_album_tracks_track_id
    ON library_album_tracks (track_id);
  CREATE INDEX IF NOT EXISTS idx_library_tracks_title
    ON library_tracks (title COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_navidrome_playlist_folders_user
    ON navidrome_playlist_folders (user_id, folder);
  CREATE INDEX IF NOT EXISTS idx_navidrome_song_ids_song_id
    ON navidrome_song_ids (song_id);
  CREATE INDEX IF NOT EXISTS idx_library_media_files_track_id
    ON library_media_files (track_id);
  CREATE INDEX IF NOT EXISTS idx_library_media_files_track_source_available
    ON library_media_files (track_id, source, available);
  CREATE INDEX IF NOT EXISTS idx_library_media_files_source_available
    ON library_media_files (source, available);
  CREATE INDEX IF NOT EXISTS idx_library_media_files_scan_id
    ON library_media_files (last_seen_scan_id);

  -- Rollups of the artist -> album -> track -> media join, which is otherwise
  -- recomputed on every request that lists artists or newly available albums.
  -- On a large library that join costs the better part of a second each time
  -- while producing byte-identical results between scans, so it is done once
  -- when the library is indexed instead. Rebuilt by libraryRollups.js.
  CREATE TABLE IF NOT EXISTS library_artist_stats (
    artist_id INTEGER PRIMARY KEY,
    album_count INTEGER NOT NULL DEFAULT 0,
    track_count INTEGER NOT NULL DEFAULT 0,
    size_on_disk INTEGER NOT NULL DEFAULT 0,
    sources TEXT,
    available INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (artist_id) REFERENCES library_artists(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS library_album_stats (
    album_id INTEGER PRIMARY KEY,
    first_seen_at INTEGER,
    track_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (album_id) REFERENCES library_albums(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_library_album_stats_first_seen
    ON library_album_stats (first_seen_at DESC, album_id DESC);

  CREATE TABLE IF NOT EXISTS aurral_history (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    subtitle TEXT,
    status TEXT NOT NULL,
    status_label TEXT,
    href TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL
  );

  -- Album requests, kept for good. aurral_history holds the same events but is
  -- pruned after 30 days, which would lose exactly the old, still-unfilled
  -- requests an admin needs to see. One row per album per person.
  CREATE TABLE IF NOT EXISTS album_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_key TEXT NOT NULL,
    user_id INTEGER,
    username TEXT,
    lidarr_album_id INTEGER,
    album_mbid TEXT,
    album_name TEXT NOT NULL,
    artist_name TEXT,
    artist_mbid TEXT,
    first_requested_at INTEGER NOT NULL,
    last_requested_at INTEGER NOT NULL,
    UNIQUE(request_key, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_album_requests_last_requested
    ON album_requests (last_requested_at DESC);

  -- Every webhook Lidarr sends, kept until it has been acted on. The library
  -- relies on these to pick up new albums, so an event is written here first
  -- and indexed after; a failure is retried instead of lost. status is one of
  -- pending, done, ignored or failed.
  CREATE TABLE IF NOT EXISTS lidarr_webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    payload TEXT,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    processed_at INTEGER,
    error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_lidarr_webhook_events_due
    ON lidarr_webhook_events (status, next_attempt_at);

  CREATE INDEX IF NOT EXISTS idx_lidarr_webhook_events_received
    ON lidarr_webhook_events (received_at DESC);

  -- One person's songs as their old music library knew them, with the tags
  -- they gave each one. The record is the song's identity for that person and
  -- outlives any file: which file it is lives in song_record_links, so a song
  -- not on the server yet keeps its tags until it arrives. source_key is the
  -- iTunes path tail (or artist|album|title|length), stable across exports.
  -- Tags a person puts on a song here, as opposed to the ones their iTunes
  -- library arrived with. Kept apart from the imported records on purpose: the
  -- import is a historical document and should stay as it was exported, while
  -- these are edited, and they are the only tags music added since can have.
  CREATE TABLE IF NOT EXISTS track_tags (
    owner TEXT NOT NULL,
    track_id INTEGER NOT NULL,
    tags_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner, track_id),
    FOREIGN KEY (track_id) REFERENCES library_tracks (id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS album_tags (
    owner TEXT NOT NULL,
    album_id INTEGER NOT NULL,
    tags_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner, album_id),
    FOREIGN KEY (album_id) REFERENCES library_albums (id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS song_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    source TEXT NOT NULL,
    source_key TEXT NOT NULL,
    title TEXT,
    artist TEXT,
    album_artist TEXT,
    album TEXT,
    disc_number INTEGER,
    track_number INTEGER,
    duration_ms INTEGER,
    year INTEGER,
    genre TEXT,
    comment TEXT,
    rating INTEGER NOT NULL DEFAULT 0,
    loved INTEGER NOT NULL DEFAULT 0,
    play_count INTEGER NOT NULL DEFAULT 0,
    date_added TEXT,
    track_type TEXT,
    metadata_json TEXT,
    dismissed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (owner, source, source_key)
  );

  -- Which canonical track a record is. status: linked (trusted), review (a
  -- guess an admin should confirm), confirmed (an admin said so), rejected (an
  -- admin said no; the matcher will not offer this track again).
  CREATE TABLE IF NOT EXISTS song_record_links (
    record_id INTEGER PRIMARY KEY,
    track_id INTEGER NOT NULL,
    method TEXT,
    status TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (record_id) REFERENCES song_records(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_song_record_links_track ON song_record_links (track_id);

  -- Old playlists a record belonged to, by name, for the missing-music report
  -- and for judging how well a smart playlist's rules reproduce the original.
  CREATE TABLE IF NOT EXISTS song_record_playlists (
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT,
    record_ids_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner, name)
  );

  -- Smart playlists Psalter evaluates over a person's tags and ratings and
  -- writes to Navidrome as ordinary playlists. Nothing is written until
  -- enabled; last_song_ids_json is what was last written, so an unchanged
  -- result writes nothing.
  CREATE TABLE IF NOT EXISTS tag_playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    rules_json TEXT NOT NULL,
    unsupported_json TEXT,
    enabled INTEGER NOT NULL DEFAULT 0,
    navidrome_playlist_id TEXT,
    last_song_ids_json TEXT,
    last_built_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (owner, name)
  );

  -- A playlist one person shares with another. Navidrome has no per-user
  -- sharing - a playlist is private to its owner or public to everyone - so
  -- the playlist is written a second time into the recipient's own account and
  -- kept in step. They own their copy, so nobody else can see it.
  CREATE TABLE IF NOT EXISTS playlist_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    recipient TEXT NOT NULL,
    source_playlist_id TEXT NOT NULL,
    name TEXT NOT NULL,
    mirror_playlist_id TEXT,
    last_song_ids_json TEXT,
    missing_count INTEGER NOT NULL DEFAULT 0,
    last_synced_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (source_playlist_id, recipient)
  );

  CREATE INDEX IF NOT EXISTS idx_playlist_shares_recipient
    ON playlist_shares (recipient, updated_at DESC);

  -- A playlist several people build together. Navidrome has one owner per
  -- playlist and no way for anyone else to edit it, so the real list lives
  -- here and every member gets their own copy of it. What they do to their
  -- copy is read back on the next pass and folded in.
  CREATE TABLE IF NOT EXISTS collab_playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- The list itself, as file paths: a path is the one identity a song keeps
  -- across everybody's libraries.
  CREATE TABLE IF NOT EXISTS collab_tracks (
    collab_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    path TEXT NOT NULL,
    added_by TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (collab_id, path),
    FOREIGN KEY (collab_id) REFERENCES collab_playlists (id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS collab_members (
    collab_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    copy_playlist_id TEXT,
    last_song_ids_json TEXT,
    last_paths_json TEXT,
    missing_count INTEGER NOT NULL DEFAULT 0,
    left_at INTEGER,
    last_error TEXT,
    joined_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (collab_id, username),
    FOREIGN KEY (collab_id) REFERENCES collab_playlists (id) ON DELETE CASCADE
  );

  -- An album, song or playlist one person points another at, with a note.
  -- A row with no recipient is meant for everyone.
  CREATE TABLE IF NOT EXISTS recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    recipient TEXT,
    kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    title TEXT,
    subtitle TEXT,
    note TEXT,
    created_at INTEGER NOT NULL,
    read_at INTEGER,
    dismissed_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_recommendations_for
    ON recommendations (recipient, created_at DESC);

  -- Read and hidden are per person, not per row: one recommendation with no
  -- recipient is one row seen by everybody, so keeping the state on it meant
  -- whoever opened the page first marked it read, and hid it, for the rest.
  CREATE TABLE IF NOT EXISTS recommendation_states (
    recommendation_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    read_at INTEGER,
    dismissed_at INTEGER,
    PRIMARY KEY (recommendation_id, username),
    FOREIGN KEY (recommendation_id) REFERENCES recommendations (id) ON DELETE CASCADE
  );

  -- What was read or hidden before that table existed. A recommendation
  -- addressed to one person can be carried over exactly; one sent to everybody
  -- cannot, because the row does not record who hid it, so it comes back.
  INSERT OR IGNORE INTO recommendation_states (recommendation_id, username, read_at, dismissed_at)
    SELECT id, recipient, read_at, dismissed_at FROM recommendations
    WHERE recipient IS NOT NULL AND (read_at IS NOT NULL OR dismissed_at IS NOT NULL);

  -- Who reaches whom. A congregation is a group of people who share with each
  -- other: what you send goes to everyone in every congregation you are in,
  -- and nobody else. The server's library is not scoped by this - everyone can
  -- still see and ask for the same music. This is about who sees what you make
  -- and what you have been playing.
  CREATE TABLE IF NOT EXISTS congregations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    -- 'open': anyone can see it and put themselves in it.
    -- 'assigned': only its own members and an admin can see it at all, and
    -- only an admin puts people in it. Family is this one.
    enrollment TEXT NOT NULL DEFAULT 'assigned',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS congregation_members (
    congregation_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (congregation_id, username),
    FOREIGN KEY (congregation_id) REFERENCES congregations (id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_congregation_members_username
    ON congregation_members (username);

  -- What each person lets the Social page show about their listening.
  CREATE TABLE IF NOT EXISTS social_settings (
    username TEXT PRIMARY KEY,
    share_listening INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );

  -- A playlist's songs just before Psalter first replaced them, for undo.
  CREATE TABLE IF NOT EXISTS tag_playlist_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_playlist_id INTEGER NOT NULL,
    navidrome_playlist_id TEXT,
    song_ids_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS inbox_items (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    source_key TEXT NOT NULL,
    title TEXT NOT NULL,
    subtitle TEXT,
    href TEXT,
    image_url TEXT,
    metadata TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    is_saved INTEGER NOT NULL DEFAULT 0,
    is_dismissed INTEGER NOT NULL DEFAULT 0,
    is_added INTEGER NOT NULL DEFAULT 0,
    dismissed_until INTEGER,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, kind, source_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS slskd_transfer_history (
    id TEXT PRIMARY KEY,
    job_id TEXT,
    username TEXT NOT NULL,
    remote_filename TEXT,
    transfer_id TEXT,
    search_id TEXT,
    batch_id TEXT,
    status TEXT NOT NULL,
    reason TEXT,
    score REAL,
    artist_name TEXT,
    track_name TEXT,
    album_name TEXT,
    source_path TEXT,
    final_path TEXT,
    actual_duration_ms INTEGER,
    created_at INTEGER NOT NULL,
    cleaned_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS honker_task_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    queue TEXT NOT NULL,
    name TEXT,
    payload TEXT,
    worker_id TEXT,
    attempt INTEGER,
    status TEXT NOT NULL,
    error TEXT,
    queued_at INTEGER,
    run_at INTEGER,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_playlist_download_jobs_status ON playlist_download_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_playlist_download_jobs_playlist_id ON playlist_download_jobs(playlist_id);
  CREATE INDEX IF NOT EXISTS idx_images_cache_cache_age ON images_cache(cache_age);
  CREATE INDEX IF NOT EXISTS idx_musicbrainz_artist_mbid_cache_updated_at ON musicbrainz_artist_mbid_cache(updated_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_subsonic_stars_user_created
    ON subsonic_stars (user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_aurral_history_created_at ON aurral_history(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_inbox_items_user_state ON inbox_items(user_id, is_dismissed, is_read, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_inbox_items_expiry ON inbox_items(expires_at, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_username ON slskd_transfer_history(username, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_created_at ON slskd_transfer_history(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_status ON slskd_transfer_history(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_slskd_transfer_history_cleanup ON slskd_transfer_history(cleaned_at, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_honker_task_runs_started_at ON honker_task_runs(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_honker_task_runs_queue_started ON honker_task_runs(queue, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_honker_task_runs_job ON honker_task_runs(job_id, queue);
`);

tryAddColumn("ALTER TABLE library_media_files ADD COLUMN album_id INTEGER");
tryAddColumn("ALTER TABLE images_cache ADD COLUMN images_json TEXT");
// Set when an admin dismisses a request from the Requests report.
tryAddColumn("ALTER TABLE album_requests ADD COLUMN dismissed_at INTEGER");
// A share the recipient has thrown away, and what the source looked like when
// it was last copied, so an unchanged playlist costs nothing to check.
tryAddColumn("ALTER TABLE playlist_shares ADD COLUMN dropped_at INTEGER");
tryAddColumn("ALTER TABLE playlist_shares ADD COLUMN source_updated_at TEXT");

function hasUniqueIndex(columns) {
  return db.prepare("PRAGMA index_list(library_media_files)").all().some((index) => {
    if (!index.unique) return false;
    const indexName = String(index.name).replaceAll('"', '""');
    const indexColumns = db
      .prepare(`PRAGMA index_info("${indexName}")`)
      .all()
      .map((column) => column.name);
    return JSON.stringify(indexColumns) === JSON.stringify(columns);
  });
}

if (hasUniqueIndex(["path"])) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE library_media_files_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id INTEGER NOT NULL,
        album_id INTEGER,
        source TEXT NOT NULL,
        path TEXT NOT NULL,
        format TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        mtime_ms INTEGER,
        duration_ms INTEGER,
        quality_json TEXT,
        available INTEGER NOT NULL DEFAULT 1,
        last_seen_scan_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (source, path),
        FOREIGN KEY (track_id) REFERENCES library_tracks(id) ON DELETE CASCADE
      );

      INSERT INTO library_media_files_v3
        (id, track_id, album_id, source, path, format, size, mtime_ms, duration_ms, quality_json,
         available, last_seen_scan_id, created_at, updated_at)
      SELECT id, track_id, album_id, source, path, format, size, mtime_ms, duration_ms, quality_json,
        available, last_seen_scan_id, created_at, updated_at
      FROM library_media_files;

      DROP TABLE library_media_files;
      ALTER TABLE library_media_files_v3 RENAME TO library_media_files;
    `);
  })();

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_library_media_files_track_id
      ON library_media_files (track_id);
    CREATE INDEX IF NOT EXISTS idx_library_media_files_track_source_available
      ON library_media_files (track_id, source, available);
    CREATE INDEX IF NOT EXISTS idx_library_media_files_source_available
      ON library_media_files (source, available);
    CREATE INDEX IF NOT EXISTS idx_library_media_files_scan_id
      ON library_media_files (last_seen_scan_id);
  `);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_library_artists_provider_id
    ON library_artists (CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.id') END AS TEXT));
  CREATE INDEX IF NOT EXISTS idx_library_artists_foreign_artist_id
    ON library_artists (CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.foreignArtistId') END AS TEXT));
  CREATE INDEX IF NOT EXISTS idx_library_artists_name
    ON library_artists (name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_library_media_files_album_source_available
    ON library_media_files (album_id, source, available);
  CREATE INDEX IF NOT EXISTS idx_library_media_files_track_album_source_available
    ON library_media_files (track_id, album_id, source, available);
`);

const duplicateLidarrArtistIds = db
  .prepare(
    `SELECT lidarr_foreign_artist_id
     FROM lidarr_artist_id_map
     GROUP BY lidarr_foreign_artist_id
     HAVING COUNT(*) > 1`,
  )
  .all();

if (duplicateLidarrArtistIds.length > 0) {
  const deleteDuplicateLidarrArtistId = db.prepare(
    `DELETE FROM lidarr_artist_id_map
     WHERE lidarr_foreign_artist_id = ?
       AND musicbrainz_id NOT IN (
         SELECT musicbrainz_id
         FROM lidarr_artist_id_map
         WHERE lidarr_foreign_artist_id = ?
         ORDER BY updated_at DESC, musicbrainz_id ASC
         LIMIT 1
       )`,
  );
  db.transaction((duplicates) => {
    for (const duplicate of duplicates) {
      deleteDuplicateLidarrArtistId.run(
        duplicate.lidarr_foreign_artist_id,
        duplicate.lidarr_foreign_artist_id,
      );
    }
  })(duplicateLidarrArtistIds);
}

db.exec(`
  DROP INDEX IF EXISTS idx_lidarr_artist_id_map_foreign_id;
  CREATE UNIQUE INDEX idx_lidarr_artist_id_map_foreign_id
    ON lidarr_artist_id_map (lidarr_foreign_artist_id);
`);

const tableColumns = db
  .prepare("PRAGMA table_info(playlist_download_jobs)")
  .all()
  .map((column) => column.name);

if (!tableColumns.includes("album_name")) {
  tryAddColumn("ALTER TABLE playlist_download_jobs ADD COLUMN album_name TEXT");
}
if (!tableColumns.includes("reason")) {
  tryAddColumn("ALTER TABLE playlist_download_jobs ADD COLUMN reason TEXT");
}
if (!tableColumns.includes("artist_mbid")) {
  tryAddColumn("ALTER TABLE playlist_download_jobs ADD COLUMN artist_mbid TEXT");
}
if (!tableColumns.includes("album_mbid")) {
  tryAddColumn("ALTER TABLE playlist_download_jobs ADD COLUMN album_mbid TEXT");
}
if (!tableColumns.includes("track_mbid")) {
  tryAddColumn("ALTER TABLE playlist_download_jobs ADD COLUMN track_mbid TEXT");
}
if (!tableColumns.includes("release_year")) {
  tryAddColumn("ALTER TABLE playlist_download_jobs ADD COLUMN release_year TEXT");
}
if (!tableColumns.includes("duration_ms")) {
  tryAddColumn("ALTER TABLE playlist_download_jobs ADD COLUMN duration_ms INTEGER");
}
if (!tableColumns.includes("external_path")) {
  tryAddColumn("ALTER TABLE playlist_download_jobs ADD COLUMN external_path TEXT");
}
if (!tableColumns.includes("denied_remote_sources")) {
  tryAddColumn("ALTER TABLE playlist_download_jobs ADD COLUMN denied_remote_sources TEXT");
}
for (const [name, type] of [
  ["quality_tier", "TEXT"],
  ["quality_format", "TEXT"],
  ["quality_bitrate_kbps", "INTEGER"],
  ["quality_sample_rate_hz", "INTEGER"],
  ["quality_bit_depth", "INTEGER"],
  ["quality_checked_at", "INTEGER"],
  ["quality_upgrade_checked_at", "INTEGER"],
  ["upgrade_for_job_id", "TEXT"],
]) {
  if (!tableColumns.includes(name)) {
    tryAddColumn(`ALTER TABLE playlist_download_jobs ADD COLUMN ${name} ${type}`);
  }
}

const userColumns = db
  .prepare("PRAGMA table_info(users)")
  .all()
  .map((column) => column.name);

if (!userColumns.includes("lastfm_username")) {
  tryAddColumn("ALTER TABLE users ADD COLUMN lastfm_username TEXT");
}
if (!userColumns.includes("listen_history_provider")) {
  tryAddColumn("ALTER TABLE users ADD COLUMN listen_history_provider TEXT");
}
if (!userColumns.includes("listen_history_username")) {
  tryAddColumn("ALTER TABLE users ADD COLUMN listen_history_username TEXT");
}
if (!userColumns.includes("lidarr_root_folder_path")) {
  tryAddColumn("ALTER TABLE users ADD COLUMN lidarr_root_folder_path TEXT");
}
if (!userColumns.includes("lidarr_quality_profile_id")) {
  tryAddColumn("ALTER TABLE users ADD COLUMN lidarr_quality_profile_id INTEGER");
}
if (!userColumns.includes("discover_layout")) {
  tryAddColumn("ALTER TABLE users ADD COLUMN discover_layout TEXT");
}
if (!userColumns.includes("listen_history_url")) {
  tryAddColumn("ALTER TABLE users ADD COLUMN listen_history_url TEXT");
}

db.exec(`
  UPDATE users
  SET listen_history_username = NULLIF(TRIM(lastfm_username), '')
  WHERE (listen_history_username IS NULL OR TRIM(listen_history_username) = '')
    AND lastfm_username IS NOT NULL
    AND TRIM(lastfm_username) != '';
`);

db.exec(`
  UPDATE users
  SET listen_history_provider = 'lastfm'
  WHERE (listen_history_provider IS NULL OR TRIM(listen_history_provider) = '')
    AND listen_history_username IS NOT NULL
    AND TRIM(listen_history_username) != '';
`);

// Congregations decide who reaches whom, and switching them on must not take
// away a way of sharing that already worked. So the first run puts everyone who
// already has an account into one congregation together. Splitting that into
// Family and the rest is a decision for a person, not a migration.
db.exec(`
  INSERT OR IGNORE INTO congregations (name, description, enrollment, created_at, updated_at)
    SELECT 'Everyone', 'Everyone who had an account when congregations were switched on.', 'assigned',
           CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
     WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'congregations:seeded:v1')
       AND EXISTS (SELECT 1 FROM users);

  INSERT OR IGNORE INTO congregation_members (congregation_id, username, joined_at)
    SELECT c.id, u.username, CAST(strftime('%s','now') AS INTEGER) * 1000
      FROM congregations AS c, users AS u
     WHERE c.name = 'Everyone'
       AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'congregations:seeded:v1');

  INSERT OR IGNORE INTO settings (key, value) VALUES ('congregations:seeded:v1', 'true');
`);

// Psalter looks like iTunes, for everyone rather than for whoever went looking
// in Settings. A one-time pass over the themes already chosen, recorded so it
// never runs twice: anyone who picks something else afterwards keeps it, and
// their light-or-dark preference is left exactly as they set it.
db.exec(`
  UPDATE settings
     SET value = json_set(CASE WHEN json_valid(value) THEN value ELSE '{}' END, '$.themeId', 'itunes')
   WHERE key LIKE 'user:%:theme'
     AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'theme:itunesForEveryone:v1');

  INSERT OR IGNORE INTO settings (key, value) VALUES ('theme:itunesForEveryone:v1', 'true');
`);

export const dbHelpers = {
  parseJSON: (text) => {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  },

  stringifyJSON: (obj) => {
    if (obj === undefined) return null;
    try {
      return JSON.stringify(obj);
    } catch {
      return null;
    }
  },
};

initializeSchemaOnStartup(db, dbHelpers);
initializeLibrarySearchIndex(db);

// Without sqlite_stat1 the query planner guesses, and on a large library it
// guesses badly enough to build throwaway indexes mid-query: one Discover
// query measured 316s with no stats and 31ms with them, for 141ms of ANALYZE.
// Backfill once for databases created before this ran; refreshLibraryStats()
// keeps them current after a scan changes the row counts.
export function refreshLibraryStats() {
  try {
    db.exec("ANALYZE");
    return true;
  } catch {
    return false;
  }
}

if (!db.prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'").get()) {
  refreshLibraryStats();
}

const existingDownloadFolder = db
  .prepare("SELECT value FROM settings WHERE key = ?")
  .get("downloadFolderPath");
syncDownloadFolderPath(existingDownloadFolder?.value || null);

export { db };

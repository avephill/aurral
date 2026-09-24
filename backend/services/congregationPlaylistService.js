import { db } from "../config/db-sqlite.js";
import { congregationsFor } from "./congregationService.js";
import { SocialError, defaultSocialDeps, planShare, takeShare } from "./socialService.js";

/**
 * Playlists shown to a congregation.
 *
 * A direct share is for someone by name, and waits for them to say yes. This
 * is the other way round: the owner puts a playlist on the list of one or more
 * of their congregations, and anyone in them can take a copy of it or not. The
 * owner is never told who did - that is theirs.
 *
 * Taking one is an ordinary share underneath (playlist_shares.listing_id says
 * which list it came from), so the copy follows the owner's playlist exactly
 * as a direct share's does, and asks about albums the same way first.
 */

const now = () => Date.now();
const clean = (value, limit = 200) => String(value ?? "").trim().slice(0, limit);

const listingRow = (id) => db.prepare("SELECT * FROM congregation_playlists WHERE id = ?").get(Number(id));

// The congregations a listing is shown to that still exist. Foreign keys are
// not enforced here, so a deleted congregation can leave an audience row.
function audienceOf(listingId) {
  return db.prepare(`
    SELECT c.id, c.name FROM congregation_playlist_audience AS a
    JOIN congregations AS c ON c.id = a.congregation_id
    WHERE a.listing_id = ? ORDER BY c.name COLLATE NOCASE
  `).all(listingId);
}

/** Whether this person is in a congregation the listing is shown to. */
function canSee(listing, username) {
  if (!listing || listing.owner === username) return false;
  return Boolean(db.prepare(`
    SELECT 1 FROM congregation_playlist_audience AS a
    JOIN congregation_members AS m ON m.congregation_id = a.congregation_id
    JOIN congregations AS c ON c.id = a.congregation_id
    WHERE a.listing_id = ? AND m.username = ? LIMIT 1
  `).get(listing.id, username));
}

function visibleListing(id, username) {
  const listing = listingRow(id);
  if (!canSee(listing, username)) throw new SocialError("No such playlist", 404);
  return listing;
}

/**
 * Show one of your playlists to some of your congregations, or change which.
 * Only congregations you are in can be chosen.
 */
export async function listPlaylist({ owner, playlistId, congregationIds = [], deps = defaultSocialDeps } = {}) {
  const id = clean(playlistId);
  if (!id) throw new SocialError("playlistId is required");
  const admin = deps.adminClient();
  if (!admin?.isConfigured?.()) throw new SocialError("Navidrome admin connection not configured", 503);
  const record = await admin.getPlaylistRecord(id).catch(() => null);
  if (!record) throw new SocialError("No such playlist", 404);
  const ownerName = record.ownerName || record.owner;
  if (ownerName && ownerName !== owner) throw new SocialError("That playlist is not yours to show", 403);

  const mine = new Set(congregationsFor(owner).map((entry) => Number(entry.id)));
  const chosen = [...new Set((congregationIds || []).map(Number))].filter((entry) => mine.has(entry));
  if (!chosen.length) throw new SocialError("Choose at least one of your congregations");

  const at = now();
  const name = clean(record.name || "Playlist");
  db.transaction(() => {
    db.prepare(`
      INSERT INTO congregation_playlists (owner, source_playlist_id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (source_playlist_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
    `).run(owner, id, name, at, at);
    const listing = db.prepare("SELECT id FROM congregation_playlists WHERE source_playlist_id = ?").get(id);
    db.prepare("DELETE FROM congregation_playlist_audience WHERE listing_id = ?").run(listing.id);
    const add = db.prepare("INSERT INTO congregation_playlist_audience (listing_id, congregation_id) VALUES (?, ?)");
    for (const congregationId of chosen) add.run(listing.id, congregationId);
  })();
  const listing = db.prepare("SELECT * FROM congregation_playlists WHERE source_playlist_id = ?").get(id);
  return { id: listing.id, name: listing.name, congregations: audienceOf(listing.id) };
}

/**
 * Take it off the list. Everyone who took a copy keeps it as their own
 * playlist; it stops following yours, as when a direct share is stopped.
 */
export function unlistPlaylist({ id, requester } = {}) {
  const listing = listingRow(id);
  if (!listing) throw new SocialError("No such playlist", 404);
  if (listing.owner !== requester) throw new SocialError("That playlist is not yours", 403);
  db.transaction(() => {
    db.prepare("DELETE FROM playlist_shares WHERE listing_id = ?").run(listing.id);
    db.prepare("DELETE FROM congregation_playlist_audience WHERE listing_id = ?").run(listing.id);
    db.prepare("DELETE FROM congregation_playlists WHERE id = ?").run(listing.id);
  })();
  return { removed: true };
}

/** What you have shown, and to which congregations - not who took it. */
export function listingsBy(owner) {
  return db.prepare("SELECT * FROM congregation_playlists WHERE owner = ? ORDER BY name COLLATE NOCASE")
    .all(owner)
    .map((listing) => ({
      id: listing.id,
      name: listing.name,
      sourcePlaylistId: listing.source_playlist_id,
      congregations: audienceOf(listing.id),
    }));
}

/**
 * What the congregations someone is in have been shown, and for each whether
 * they have taken a copy. A playlist already shared with them by name is left
 * off: they have it, or have been asked, the other way.
 */
export function listingsFor(username) {
  const mine = new Set(congregationsFor(username).map((entry) => Number(entry.id)));
  return db.prepare(`
    SELECT DISTINCT l.* FROM congregation_playlists AS l
    JOIN congregation_playlist_audience AS a ON a.listing_id = l.id
    JOIN congregation_members AS m ON m.congregation_id = a.congregation_id
    JOIN congregations AS c ON c.id = a.congregation_id
    WHERE m.username = ? AND l.owner != ?
    ORDER BY l.updated_at DESC
  `).all(username, username).flatMap((listing) => {
    const share = db.prepare(`
      SELECT * FROM playlist_shares WHERE source_playlist_id = ? AND recipient = ? AND dropped_at IS NULL
    `).get(listing.source_playlist_id, username);
    if (share && share.listing_id == null) return [];
    const taken = share?.accepted_at ? share : null;
    return [{
      id: listing.id,
      owner: listing.owner,
      name: listing.name,
      // Only the congregations they are in: an assigned one they are not in
      // is not theirs to know about.
      congregations: audienceOf(listing.id).filter((entry) => mine.has(Number(entry.id))),
      taken: taken ? {
        shareId: taken.id,
        playlistId: taken.mirror_playlist_id,
        songCount: JSON.parse(taken.last_song_ids_json || "[]").length,
        missing: taken.missing_count,
        syncedAt: taken.last_synced_at,
        error: taken.last_error,
      } : null,
    }];
  });
}

const pseudoShare = (listing, username) => ({
  id: null,
  owner: listing.owner,
  recipient: username,
  source_playlist_id: listing.source_playlist_id,
  name: listing.name,
});

/** What taking a copy would put into your library, before you say yes. */
export async function previewListing({ id, requester, deps = defaultSocialDeps } = {}) {
  return planShare(pseudoShare(visibleListing(id, requester), requester), deps);
}

/**
 * Take a copy: add the albums it needs, and write the copy into your account.
 * Asked again once you have it, it adds albums for songs added since.
 */
export async function takeListing({ id, requester, deps = defaultSocialDeps } = {}) {
  const listing = visibleListing(id, requester);
  const at = now();
  db.prepare(`
    INSERT INTO playlist_shares (owner, recipient, source_playlist_id, name, listing_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source_playlist_id, recipient) DO UPDATE SET
      name = excluded.name, updated_at = excluded.updated_at, last_error = NULL,
      listing_id = COALESCE(playlist_shares.listing_id, excluded.listing_id),
      mirror_playlist_id = CASE WHEN playlist_shares.dropped_at IS NOT NULL
        THEN NULL ELSE playlist_shares.mirror_playlist_id END,
      last_song_ids_json = CASE WHEN playlist_shares.dropped_at IS NOT NULL
        THEN NULL ELSE playlist_shares.last_song_ids_json END,
      dropped_at = NULL
  `).run(listing.owner, requester, listing.source_playlist_id, listing.name, listing.id, at, at);
  const share = db.prepare("SELECT * FROM playlist_shares WHERE source_playlist_id = ? AND recipient = ?")
    .get(listing.source_playlist_id, requester);
  return takeShare(share, deps);
}

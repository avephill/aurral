// Moves personal libraries from holding the whole Various Artists folder to
// holding compilations one album at a time. A dry run unless APPLY=1.
//
//   docker cp plan.json aurral:/tmp/compilation-plan.json
//   docker exec -i [-e APPLY=1] -e PLAN=/tmp/compilation-plan.json \
//     aurral node --input-type=module < scripts/compilations/switch-to-picks.mjs
//
// The plan says what each person starts with, which is a decision about the
// people on this server rather than something to guess:
//
//   {
//     "users": {
//       "someone": { "mbids": ["<release group>", ...], "folders": ["Various Artists/<album>", ...] }
//     },
//     "untag": ["someone", ...]
//   }
//
// mbids are compilations Lidarr knows, by MusicBrainz release group. folders
// are compilation folders Lidarr has not matched yet; they are kept by path
// until it does, so nobody loses one in the meantime.
//
// In order, so nobody is ever without a compilation they had:
//
//   1. A library-history snapshot of everyone named, to undo with.
//   2. Their picks are recorded.
//   3. Compilations switch to being picked by album, which stops Various
//      Artists being linked whole whatever Lidarr's tags say.
//   4. Each person in "untag" loses the Various Artists tag in Lidarr, so its
//      tags say the same as their library.
//   5. The libraries are rebuilt, and Navidrome rescans them.

import fs from "node:fs/promises";

const APPLY = process.env.APPLY === "1";
const plan = JSON.parse(await fs.readFile(process.env.PLAN || "/tmp/compilation-plan.json", "utf8"));

const { db } = await import("/app/backend/config/db-sqlite.js");
const { dbOps, userOps } = await import("/app/backend/db/helpers/index.js");
const library = await import("/app/backend/services/userLibraryService.js");
const { takeSnapshot } = await import("/app/backend/services/libraryHistoryService.js");

const users = Object.entries(plan.users || {});
const untag = plan.untag || [];
const resolvable = (mbids) => library.currentAlbumFolders(mbids);

console.log(APPLY ? "APPLYING" : "DRY RUN - nothing is changed");
for (const [username, wanted] of users) {
  const found = resolvable(wanted.mbids || []);
  const unknown = (wanted.mbids || []).filter((mbid) => !found.has(mbid));
  console.log(`${username}: ${found.size} compilations Lidarr knows, ${(wanted.folders || []).length} folders by path`
    + (unknown.length ? `, ${unknown.length} with no files to link (skipped)` : ""));
}
console.log(`untag Various Artists for: ${untag.join(", ") || "nobody"}`);
console.log(`compilations picked by album: ${library.getUserLibrariesSettings().compilationsByAlbum ? "already on" : "will be turned on"}`);
if (!APPLY) process.exit(0);

for (const username of new Set([...users.map(([name]) => name), ...untag])) {
  const user = userOps.getUserByUsername(username);
  if (!user) throw new Error(`No Psalter user ${username}`);
  const snapshot = await takeSnapshot(user, { reason: "before compilations were picked by album" });
  console.log(`snapshot ${snapshot.id} of ${username}`);
}

for (const [username, wanted] of users) {
  const byMbid = library.addUserLibraryAlbumsByMbid(username, wanted.mbids || [], "compilations, as they were");
  const byFolder = library.addUserLibraryAlbums(username, wanted.folders || [], "compilations, as they were");
  console.log(`${username}: ${byMbid.added} added by release group, ${byFolder} by folder`);
}

const settings = dbOps.getSettings();
dbOps.updateSettings({ ...settings, userLibraries: { ...settings.userLibraries, compilationsByAlbum: true } });
console.log("compilations are now picked by album");

for (const username of untag) {
  const result = await library.setUserLibraryMembership({ username }, library.VARIOUS_ARTISTS_MBID, false);
  console.log(`${username}: Various Artists tag ${result.changed.length ? "removed" : "was not there"}`);
}

const result = await library.reconcileUserLibrariesAndWait();
for (const entry of result.users || []) console.log(`${entry.username}: ${entry.changes} links changed`);
console.log("rows now:", db.prepare("SELECT username, COUNT(*) AS n FROM user_library_albums GROUP BY username").all());
process.exit(0);

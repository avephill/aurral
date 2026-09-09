import express from "express";
import { requireAuth, requirePermission } from "../../middleware/requirePermission.js";
import { isAutomaticPlaylistsEnabled } from "../../config/featureFlags.js";
import { registerStream } from "./handlers/stream.js";
import { registerArtworkServe } from "./handlers/artworkServe.js";
import { registerArtworkManagement } from "./handlers/artworkManagement.js";
import { registerFlows } from "./handlers/flows.js";
import { registerSharedPlaylists } from "./handlers/sharedPlaylists.js";
import { registerSpotifyImport } from "./handlers/spotifyImport.js";
import { registerListenBrainzImport } from "./handlers/listenbrainzImport.js";
import { registerLastfmImport } from "./handlers/lastfmImport.js";
import { registerJobs } from "./handlers/jobs.js";

const router = express.Router();

registerStream(router);
registerArtworkServe(router);

router.use(requireAuth);
router.use(requirePermission("accessFlow"));

// Flows are Aurral's automatic playlists. With those switched off the routes
// that would create or run one are closed, while hand-made playlists stay.
router.use("/flows", (req, res, next) => {
  if (req.method === "GET" || isAutomaticPlaylistsEnabled()) return next();
  return res.status(403).json({ error: "Automatic playlists are disabled on this server" });
});

registerArtworkManagement(router);
registerFlows(router);
registerSharedPlaylists(router);
registerSpotifyImport(router);
registerListenBrainzImport(router);
registerLastfmImport(router);
registerJobs(router);

export default router;

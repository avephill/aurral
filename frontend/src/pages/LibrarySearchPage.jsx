import { useMemo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Compass, Disc3, Globe, Library, Play, UserRound } from "lucide-react";
import { DotLoader } from "../components/DotLoader";
import { useAuth } from "../contexts/AuthContext";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useLibraryScope } from "../hooks/useLibraryScope";
import { buildAuthenticatedApiUrl } from "../utils/api/core.js";
import { searchUnified } from "../utils/api/endpoints/search.js";
import { navigateFromSearchResult } from "../utils/searchNavigation";
import { searchPathFor } from "../utils/searchScope";
import "./librarySearch.css";

// What pressing Enter in the search box finds from a library page: music on
// the server, nothing to ask for. It follows the same your-library /
// whole-server switch as the Library page, and never ends in a dead end -
// the same words can be taken to Discover from here.

const LIMIT = 50;

function toPlayable(track) {
  if (!track?.streamPath) return null;
  return {
    id: `library-search:${track.canonicalTrackId}`,
    title: track.title,
    artist: track.artistName || "Unknown Artist",
    album: track.albumTitle || "Unknown Album",
    src: buildAuthenticatedApiUrl(track.streamPath),
    artistMbid: track.artistMbid || null,
    albumMbid: track.albumMbid || null,
    trackMbid: track.trackMbid || null,
    recordHistory: true,
    canonicalTrackId: track.canonicalTrackId,
    canonicalAlbumId: track.canonicalAlbumId,
  };
}

const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export default function LibrarySearchPage() {
  const [searchParams] = useSearchParams();
  const query = (searchParams.get("q") || "").trim();
  useDocumentTitle(query ? `“${query}” in your library` : "Search your library");
  const navigate = useNavigate();
  const { user } = useAuth();
  const [scope, chooseScope] = useLibraryScope(user?.id);
  const { playQueue } = useAudioQueue();

  const search = useQuery({
    queryKey: ["library-search", query],
    queryFn: ({ signal }) => searchUnified(query, { mode: "library", limit: LIMIT, signal }),
    enabled: query.length > 0,
    staleTime: 15_000,
  });

  // Every hit is marked as theirs or only on the server; looking at their own
  // library, the others are counted rather than shown.
  const { artists, albums, tracks, hidden } = useMemo(() => {
    const library = search.data?.library || {};
    const keep = (items) =>
      (items || []).filter((item) => scope === "server" || item.inUserLibrary !== false);
    const all = ["artists", "albums", "tracks"].flatMap((key) => library[key] || []);
    return {
      artists: keep(library.artists),
      albums: keep(library.albums),
      tracks: keep(library.tracks).filter((track) => track.streamPath),
      hidden: scope === "mine" ? all.filter((item) => item.inUserLibrary === false).length : 0,
    };
  }, [search.data, scope]);

  const open = (item) => navigateFromSearchResult(navigate, item, { query, scope: "library" });
  const play = (track) => {
    const queue = tracks.map(toPlayable).filter(Boolean);
    const startIndex = Math.max(0, queue.findIndex((entry) => entry.canonicalTrackId === track.canonicalTrackId));
    playQueue(queue, { startIndex, source: { type: "library-search", id: query } });
  };

  const nothing = !artists.length && !albums.length && !tracks.length;

  return (
    <main className="library-search">
      <header className="library-search__header">
        <div>
          <p className="library-search__eyebrow">
            <Library aria-hidden="true" /> {scope === "mine" ? "Your library" : "The whole server's library"}
          </p>
          <h1 className="page-title">{query ? `“${query}”` : "Search your library"}</h1>
        </div>
        <div className="library-search__actions">
          <div className="library-search__scope" role="group" aria-label="Search in">
            <button
              type="button"
              className={scope === "mine" ? "is-active" : ""}
              aria-pressed={scope === "mine"}
              onClick={() => chooseScope("mine")}
            >
              <Library aria-hidden="true" /> Your library
            </button>
            <button
              type="button"
              className={scope === "server" ? "is-active" : ""}
              aria-pressed={scope === "server"}
              onClick={() => chooseScope("server")}
            >
              <Globe aria-hidden="true" /> Whole server
            </button>
          </div>
          {query ? (
            <Link className="btn btn-secondary btn-sm" to={searchPathFor("discover", query)}>
              <Compass aria-hidden="true" className="artist-icon-sm" /> Search Discover
            </Link>
          ) : null}
        </div>
      </header>

      {!query ? (
        <p className="library-search__empty">Type in the search box above to search your library.</p>
      ) : search.isLoading ? (
        <div className="library-search__state"><DotLoader label="Searching your library" /></div>
      ) : search.isError ? (
        <p className="library-search__empty">The library could not be searched just now. Try again in a moment.</p>
      ) : (
        <>
          {artists.length ? (
            <section className="library-search__section" aria-labelledby="library-search-artists">
              <h2 id="library-search-artists">Artists</h2>
              <ul className="library-search__artists">
                {artists.map((artist) => (
                  <li key={artist.key || artist.name}>
                    <button type="button" onClick={() => open(artist)}>
                      <UserRound aria-hidden="true" />
                      <span>{artist.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {albums.length ? (
            <section className="library-search__section" aria-labelledby="library-search-albums">
              <h2 id="library-search-albums">Albums</h2>
              <ul className="library-search__albums">
                {albums.map((album) => (
                  <li key={album.key || album.id}>
                    <button type="button" onClick={() => open(album)}>
                      <span className="library-search__cover">
                        {album.coverUrl ? (
                          <img src={album.coverUrl} alt="" loading="lazy" />
                        ) : (
                          <Disc3 aria-hidden="true" />
                        )}
                      </span>
                      <span className="library-search__album-title">{album.title}</span>
                      <span className="library-search__album-artist">{album.artistName}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {tracks.length ? (
            <section className="library-search__section" aria-labelledby="library-search-songs">
              <h2 id="library-search-songs">Songs</h2>
              <ol className="library-search__songs">
                {tracks.map((track) => (
                  <li key={track.key || track.id}>
                    <button
                      type="button"
                      className="library-search__play"
                      onClick={() => play(track)}
                      aria-label={`Play ${track.title}`}
                    >
                      <Play aria-hidden="true" fill="currentColor" />
                    </button>
                    <button type="button" className="library-search__song" onClick={() => play(track)}>
                      <span className="library-search__song-title">{track.title}</span>
                      <span className="library-search__song-meta">
                        {[track.artistName, track.albumTitle].filter(Boolean).join(" · ")}
                      </span>
                    </button>
                    <button type="button" className="library-search__to-album" onClick={() => open(track)}>
                      Go to album
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {hidden ? (
            <button type="button" className="library-search__more" onClick={() => chooseScope("server")}>
              <Globe aria-hidden="true" />
              <span>
                {plural(hidden, "more match")} on the server
                <small>Music others have added. Show the whole server&apos;s library</small>
              </span>
            </button>
          ) : null}

          <div className="library-search__footer">
            {nothing ? (
              <p className="library-search__empty">
                Nothing in {scope === "mine" ? "your library" : "the server's library"} matches “{query}”.
              </p>
            ) : null}
            <Link className="library-search__discover" to={searchPathFor("discover", query)}>
              <Compass aria-hidden="true" />
              <span>
                {nothing ? `Search Discover for “${query}”` : `Looking for more? Search Discover for “${query}”`}
                <small>Artists and albums not on the server yet, to ask for</small>
              </span>
            </Link>
          </div>
        </>
      )}
    </main>
  );
}

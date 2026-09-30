import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { completeWalkthrough } from "../utils/api/endpoints/auth.js";
import { placeWalkthroughCard } from "../utils/walkthroughPlacement.js";
import CongregationPicker from "./CongregationPicker";
import "./walkthrough.css";

// A short look around on someone's first visit: where their music is, how to
// find something, where playlists live, and the pages worth knowing about. No
// lectures - enough to start, and it never comes back unless an admin hands it
// back from Settings -> Users.
//
// Someone whose library came in from iTunes gets a tour of their own at the
// edges: tags explained against what they knew, and it ends on the playlists
// they brought rather than on picking artists, which was done for them.

const fromItunes = (bootstrap) => bootstrap?.itunesLibraryImported === true;

const STEPS = [
  {
    title: "Welcome to Psalter",
    body: "This is where you listen to your music, rate it, and add more of it. The tour takes about a minute.",
    path: "/library",
  },
  {
    title: "Your library",
    body: "Everything in your library, by artist, album or song. The stars you gave songs in iTunes came across with them.",
    path: "/library",
    anchor: '[data-tour="library"]',
  },
  {
    title: "Yours, and the server's",
    body: "The server holds more music than your library does - other people's records live there too. Yours is the part you have picked out, and it is what you see by default. The switch at the top of the Library shows the whole server's instead.",
    path: "/library",
    anchor: '[data-tour="library"]',
  },
  {
    title: "Finding something",
    body: "The search box searches whatever you are looking at. On the Library it looks through your library - music you can play now. On Discover it looks everywhere, records to ask for included. If what you want is not in your library, the bottom of the list offers to look in Discover.",
    anchor: '[data-tour="search"]',
  },
  {
    title: "Playlists",
    body: "Your playlists live under Library, and work in any music player you use, not only here. Add a song to one from the ••• beside it, or several songs from an album at once from the album's •••. On this page you can also drag a song onto a playlist on the left. A playlist can be a fixed list of songs, or a set of rules - every song rated five stars, say - that keeps filling itself.",
    path: "/library/playlists",
    anchor: '[data-tour="library"]',
  },
  // Only for someone whose library came in from iTunes: it is a comparison,
  // and it means nothing to anyone with nothing to compare it against.
  {
    title: "Tags",
    body: "The words you tagged songs with in iTunes came across, and tags are their own thing now: put one on a song from the ••• beside it instead of typing into its comment field, on a whole record from the record's •••, or on several songs of a record at once with \"Tag songs\". To see every song with a tag, pick it in the filter on the Tracks page, or type # and the tag into the search box. What your library arrived with is kept exactly as it was.",
    path: "/library/tags",
    anchor: '[data-tour="tags"]',
    needs: fromItunes,
  },
  {
    title: "Adding music",
    body: "Something already on the server: add it to your library and it is yours straight away. Something nobody has yet: find the album on Discover and ask for it - a few a day - and when it arrives it goes into your library too. Once an artist is in your library, anything of theirs that reaches the server later joins it on its own.",
    path: "/discover",
    anchor: '[data-tour="discover"]',
  },
  {
    title: "Discover",
    body: "Somewhere to find records worth asking for - new releases, things like what you already play, and what has just been added to the server. Searching from here looks everywhere.",
    path: "/discover",
    anchor: '[data-tour="discover"]',
  },
  // Onboarding's one real question. Everything someone shares reaches their
  // congregations and nowhere else, so it is worth asking before they start
  // sharing rather than explaining afterwards.
  {
    title: "Who you share with",
    body: "Psalter keeps people in congregations - a group of people who share with each other. Anything you send reaches everyone in every congregation you are in, and nobody else. The music on the server is the same for everybody; this is about who sees what you make and what you have been playing.",
    content: "congregations",
    anchor: '[data-tour="social"]',
    path: "/social",
  },
  {
    title: "Social",
    body: "A playlist someone shares with you waits here until you add it, and says first if adding it means putting albums in your library. Playlists shown to your whole congregation are here too, to add or not, and albums or songs people think you would like. You can send some back.",
    path: "/social",
    anchor: '[data-tour="social"]',
  },
  // Last, and left open: the tour ends on the page worth using first. For
  // someone new that is picking their artists. Someone who came from iTunes
  // has had that done for them, so theirs ends on the playlists they brought.
  {
    title: "Where to start",
    body: "Bulk migration is the quickest way to say which of the server's music is yours: tick the artists you want and they and their records join your library in one go. It is the one thing worth doing before anything else, so the tour leaves you here.",
    path: "/library/mine",
    anchor: '[data-tour="bulk-migration"]',
    cta: "Pick my artists",
    // Nothing to send anyone to when the server keeps one library for
    // everyone; the step would open a page saying so.
    needs: (bootstrap) => bootstrap?.userLibrariesEnabled === true && !fromItunes(bootstrap),
  },
  {
    title: "Where to start",
    body: "Your music, your ratings and your playlists came across from iTunes and are all here. Pick a playlist and press play - and if something is missing, ask for it from Discover.",
    path: "/library/playlists",
    anchor: '[data-tour="library"]',
    cta: "Show my playlists",
    needs: fromItunes,
  },
];

export default function Walkthrough() {
  const { bootstrap, isAuthenticated, refreshAuth } = useAuth();
  const navigate = useNavigate();
  const steps = useMemo(
    () => STEPS.filter((entry) => !entry.needs || entry.needs(bootstrap)),
    [bootstrap],
  );
  const [step, setStep] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [spotlight, setSpotlight] = useState(null);
  const [cardAt, setCardAt] = useState(null);
  const cardRef = useRef(null);

  const pending = isAuthenticated && bootstrap?.walkthroughPending === true && !dismissed;
  const current = steps[step];

  // Follow the tour to the page it is talking about, so what it describes is
  // on screen behind it.
  useEffect(() => {
    if (!pending || !current?.path) return;
    navigate(current.path);
  }, [current?.path, navigate, pending]);

  // Put a ring around whatever the step names, wherever it has ended up, and
  // stand the card beside it rather than always in the same corner.
  useEffect(() => {
    if (!pending) return undefined;
    const place = () => {
      const target = current?.anchor ? document.querySelector(current.anchor) : null;
      if (!target) {
        setSpotlight(null);
        setCardAt(null);
        return;
      }
      const rect = target.getBoundingClientRect();
      const box = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
      setSpotlight(box);
      // On a phone the card is a bar across the bottom and there is nowhere
      // else for it to go, so leave it where the stylesheet puts it.
      if (window.innerWidth <= 640) {
        setCardAt(null);
        return;
      }
      const card = cardRef.current?.getBoundingClientRect();
      setCardAt(
        placeWalkthroughCard({
          target: box,
          card: { width: card?.width || 0, height: card?.height || 0 },
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      );
    };
    place();
    // The page behind the tour is still arriving on the step that navigated,
    // so measure again once it has settled.
    const timer = setTimeout(place, 250);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [current?.anchor, pending, step]);

  const finish = useCallback(async () => {
    setDismissed(true);
    try {
      await completeWalkthrough();
      refreshAuth?.();
    } catch {
      // Not worth interrupting anyone over; it simply shows again next time.
    }
  }, [refreshAuth]);

  useEffect(() => {
    if (!pending) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [finish, pending]);

  if (!pending || !current) return null;

  const last = step === steps.length - 1;
  return (
    <div className="walkthrough" role="dialog" aria-modal="true" aria-labelledby="walkthrough-title">
      <div className="walkthrough__veil" onClick={finish} />
      {spotlight ? (
        <div
          className="walkthrough__spotlight"
          style={{
            top: `${spotlight.top}px`,
            left: `${spotlight.left}px`,
            width: `${spotlight.width}px`,
            height: `${spotlight.height}px`,
          }}
        />
      ) : null}
      <div
        className="walkthrough__card"
        ref={cardRef}
        style={cardAt ? { top: `${cardAt.top}px`, left: `${cardAt.left}px`, right: "auto", bottom: "auto" } : undefined}
      >
        <p className="walkthrough__count">{step + 1} of {steps.length}</p>
        <h2 className="walkthrough__title" id="walkthrough-title">{current.title}</h2>
        <p className="walkthrough__body">{current.body}</p>
        {current.content === "congregations" ? (
          <div className="walkthrough__content">
            <CongregationPicker compact />
          </div>
        ) : null}
        <div className="walkthrough__actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={finish}>
            Skip
          </button>
          <div className="walkthrough__forward">
            {step > 0 ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setStep(step - 1)}>
                Back
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => (last ? finish() : setStep(step + 1))}
            >
              {last ? current.cta || "Start listening" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

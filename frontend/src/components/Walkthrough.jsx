import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { completeWalkthrough } from "../utils/api/endpoints/auth.js";
import { placeWalkthroughCard } from "../utils/walkthroughPlacement.js";
import "./walkthrough.css";

// A short look around on someone's first visit: where their music is, how to
// find something, where playlists live, and the two pages worth knowing about.
// Six steps, no lectures - enough to start, and it never comes back.

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
    body: "The server holds more music than your library does - other people's records live there too. Yours is the part you have picked out, and it is what you see by default.",
    path: "/library",
    anchor: '[data-tour="library"]',
  },
  {
    title: "Finding something",
    body: "Search from anywhere. Your own library comes first, then the rest of the server, and you can search further afield from the bottom of the list.",
    anchor: '[data-tour="search"]',
  },
  {
    title: "Playlists",
    body: "Your playlists live under Library. Add a song to one from the ••• beside it, and they work in any music player you use, not only here.",
    path: "/library/playlists",
    anchor: '[data-tour="library"]',
  },
  {
    title: "Adding music",
    body: "Something already on the server: add it to your library and it is yours straight away. Something nobody has yet: ask for it, and when it arrives it goes into your library too. Once an artist is in your library, anything of theirs that reaches the server later joins it on its own.",
    path: "/discover",
    anchor: '[data-tour="discover"]',
  },
  {
    title: "Discover",
    body: "Somewhere to find records worth asking for - new releases, things like what you already play, and what has just been added to the server.",
    path: "/discover",
    anchor: '[data-tour="discover"]',
  },
  {
    title: "Social",
    body: "Playlists other people share with you, and albums or songs they think you would like. You can send some back.",
    path: "/social",
    anchor: '[data-tour="social"]',
  },
];

export default function Walkthrough() {
  const { bootstrap, isAuthenticated, refreshAuth } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [spotlight, setSpotlight] = useState(null);
  const [cardAt, setCardAt] = useState(null);
  const cardRef = useRef(null);

  const pending = isAuthenticated && bootstrap?.walkthroughPending === true && !dismissed;
  const current = STEPS[step];

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

  const last = step === STEPS.length - 1;
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
        <p className="walkthrough__count">{step + 1} of {STEPS.length}</p>
        <h2 className="walkthrough__title" id="walkthrough-title">{current.title}</h2>
        <p className="walkthrough__body">{current.body}</p>
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
              {last ? "Start listening" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

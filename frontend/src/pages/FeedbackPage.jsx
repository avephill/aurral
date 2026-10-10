import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bug, Lightbulb, Send, Trash2 } from "lucide-react";
import { DotLoader } from "../components/DotLoader";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import {
  answerFeedback,
  deleteFeedback,
  getAllFeedback,
  getMyFeedback,
  markFeedbackRepliesRead,
  sendFeedback,
} from "../utils/api/endpoints/feedback.js";
import "./feedback.css";

// Somewhere to say something is not working, or that something would be
// nice. What was sent stays listed with whatever came back. Admins also see
// everyone's, mark each one and write back.

const errorText = (error, fallback) => error?.response?.data?.error || error?.message || fallback;

const KINDS = [
  {
    id: "problem",
    label: "Something isn't working",
    icon: Bug,
    placeholder: "What were you doing, what did you expect, and what happened instead?",
  },
  {
    id: "idea",
    label: "I have an idea",
    icon: Lightbulb,
    placeholder: "What would you like Psalter to do?",
  },
];

const STATUS_LABELS = {
  new: "Sent",
  seen: "Read",
  planned: "Planned",
  done: "Done",
  wont: "Not planned",
};

const dateFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const when = (value) => dateFormatter.format(new Date(Number(value)));

function FeedbackItem({ item, admin }) {
  const queryClient = useQueryClient();
  const { showError } = useToast();
  const [reply, setReply] = useState(item.reply || "");
  useEffect(() => setReply(item.reply || ""), [item.reply]);
  const Icon = item.kind === "idea" ? Lightbulb : Bug;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["feedback"] });
  };
  const answer = useMutation({
    mutationFn: (changes) => answerFeedback(item.id, changes),
    onSuccess: refresh,
    onError: (error) => showError(errorText(error, "Could not update that")),
  });
  const remove = useMutation({
    mutationFn: () => deleteFeedback(item.id),
    onSuccess: refresh,
    onError: (error) => showError(errorText(error, "Could not delete that")),
  });

  return (
    <li className={`feedback-item feedback-item--${item.status}${item.unreadReply && !admin ? " is-unread" : ""}`}>
      <div className="feedback-item__head">
        <Icon className="feedback-item__kind" aria-label={item.kind === "idea" ? "Idea" : "Problem"} />
        <span className="feedback-item__meta">
          {admin ? <strong>{item.username}</strong> : null}
          {when(item.createdAt)}
          {admin && item.page ? <> · from <Link to={item.page}>{item.page}</Link></> : null}
          {admin && item.appVersion ? <> · {item.appVersion}</> : null}
        </span>
        {admin ? (
          <select
            className="input input-sm feedback-item__status"
            value={item.status}
            aria-label="Status"
            onChange={(event) => answer.mutate({ status: event.target.value })}
            disabled={answer.isPending}
          >
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{value === "new" ? "New" : label}</option>
            ))}
          </select>
        ) : (
          <span className={`feedback-item__badge feedback-item__badge--${item.status}`}>{STATUS_LABELS[item.status]}</span>
        )}
      </div>
      <p className="feedback-item__message">{item.message}</p>
      {admin ? (
        <form
          className="feedback-item__answer"
          onSubmit={(event) => {
            event.preventDefault();
            answer.mutate({ reply, status: item.status === "new" ? "seen" : item.status });
          }}
        >
          <textarea
            value={reply}
            rows={2}
            maxLength={2000}
            placeholder={`Write back to ${item.username}`}
            onChange={(event) => setReply(event.target.value)}
          />
          <div className="feedback-item__actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                if (window.confirm("Delete this message for good?")) remove.mutate();
              }}
              disabled={remove.isPending}
              aria-label="Delete"
            >
              <Trash2 className="artist-icon-sm" aria-hidden="true" />
            </button>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={answer.isPending || reply.trim() === (item.reply || "")}
            >
              Send reply
            </button>
          </div>
        </form>
      ) : item.reply ? (
        <p className="feedback-item__reply">
          <span>Reply</span>
          {item.reply}
        </p>
      ) : null}
    </li>
  );
}

export default function FeedbackPage() {
  useDocumentTitle("Ideas & problems");
  const location = useLocation();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { showError, showSuccess } = useToast();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState("problem");
  const [message, setMessage] = useState("");
  const [view, setView] = useState(isAdmin ? "everyone" : "mine");
  // The page they came from, so a report about something says where it was.
  const [from] = useState(() => location.state?.from || null);

  const mine = useQuery({
    queryKey: ["feedback", "mine"],
    queryFn: ({ signal }) => getMyFeedback({ signal }),
  });
  const everyone = useQuery({
    queryKey: ["feedback", "everyone"],
    queryFn: ({ signal }) => getAllFeedback({ signal }),
    enabled: isAdmin,
  });

  // Opening the page reads whatever has come back.
  const hasUnread = (mine.data?.items || []).some((item) => item.unreadReply);
  useEffect(() => {
    if (!hasUnread) return undefined;
    const timer = setTimeout(() => {
      markFeedbackRepliesRead()
        .then(() => queryClient.invalidateQueries({ queryKey: ["feedback", "waiting"] }))
        .catch(() => {});
    }, 1500);
    return () => clearTimeout(timer);
  }, [hasUnread, queryClient]);

  const send = useMutation({
    mutationFn: () => sendFeedback({ kind, message, page: from }),
    onSuccess: () => {
      setMessage("");
      showSuccess(kind === "idea" ? "Thanks - your idea has been sent" : "Thanks - your report has been sent");
      queryClient.invalidateQueries({ queryKey: ["feedback"] });
    },
    onError: (error) => showError(errorText(error, "Could not send that")),
  });

  const chosen = KINDS.find((entry) => entry.id === kind);
  const shown = view === "everyone" ? everyone : mine;
  const items = shown.data?.items || [];
  const newCount = (everyone.data?.items || []).filter((item) => item.status === "new").length;

  return (
    <main className="feedback">
      <header>
        <h1 className="page-title">Ideas &amp; problems</h1>
        <p className="feedback__muted">
          Tell us when something isn&apos;t working, or what would make Psalter better. You&apos;ll see an answer here.
        </p>
      </header>

      <form
        className="feedback__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (message.trim()) send.mutate();
        }}
      >
        <div className="feedback__kinds" role="radiogroup" aria-label="What is it?">
          {KINDS.map((entry) => {
            const Icon = entry.icon;
            return (
              <button
                key={entry.id}
                type="button"
                role="radio"
                aria-checked={kind === entry.id}
                className={kind === entry.id ? "is-active" : ""}
                onClick={() => setKind(entry.id)}
              >
                <Icon aria-hidden="true" />
                {entry.label}
              </button>
            );
          })}
        </div>
        <textarea
          value={message}
          rows={5}
          maxLength={5000}
          placeholder={chosen.placeholder}
          aria-label={chosen.label}
          onChange={(event) => setMessage(event.target.value)}
          disabled={send.isPending}
        />
        <div className="feedback__send">
          <span className="feedback__muted">
            {from && from !== "/feedback" ? `Sent from ${from}` : ""}
          </span>
          <button type="submit" className="btn btn-primary btn-sm" disabled={!message.trim() || send.isPending}>
            {send.isPending ? <DotLoader size="xs" label={null} /> : <Send className="artist-icon-sm" aria-hidden="true" />}
            Send
          </button>
        </div>
      </form>

      <section className="feedback__history" aria-labelledby="feedback-history">
        <div className="feedback__history-head">
          <h2 id="feedback-history">{view === "everyone" ? "Everyone's" : "What you've sent"}</h2>
          {isAdmin ? (
            <div className="feedback__views" role="group" aria-label="Show">
              <button type="button" className={view === "everyone" ? "is-active" : ""} aria-pressed={view === "everyone"} onClick={() => setView("everyone")}>
                Everyone{newCount ? ` (${newCount} new)` : ""}
              </button>
              <button type="button" className={view === "mine" ? "is-active" : ""} aria-pressed={view === "mine"} onClick={() => setView("mine")}>
                Mine
              </button>
            </div>
          ) : null}
        </div>
        {shown.isLoading ? (
          <DotLoader label="Loading" />
        ) : shown.isError ? (
          <p className="feedback__muted">These could not be loaded just now.</p>
        ) : !items.length ? (
          <p className="feedback__muted">Nothing yet.</p>
        ) : (
          <ul className="feedback__list">
            {items.map((item) => (
              <FeedbackItem key={item.id} item={item} admin={view === "everyone"} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { DotLoader } from "../../../components/DotLoader";
import { getAlbumRequestReport } from "../../../utils/api/endpoints/library.js";
import "./settingsRequests.css";

// Album requests from everyone, and whether each has reached the disk. The
// default view is the admin's to-do list: requested, and still not there.

const FILTERS = [
  { id: "open", label: "Not on disk" },
  { id: "done", label: "On disk" },
  { id: "all", label: "All" },
];

const isOnDisk = (item) => item.availability?.status === "complete";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});

const formatDate = (value) => {
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime()) ? dateFormatter.format(date) : "—";
};

export function SettingsRequestsTab() {
  const [filter, setFilter] = useState("open");
  const [includeAdmins, setIncludeAdmins] = useState(false);
  const report = useQuery({
    queryKey: ["requests", "report"],
    queryFn: ({ signal }) => getAlbumRequestReport({ signal }),
    staleTime: 30_000,
  });

  const people = useMemo(
    () => (report.data?.items || []).filter((item) => includeAdmins || !item.requestedBy?.isAdmin),
    [includeAdmins, report.data],
  );
  const counts = useMemo(
    () => ({
      open: people.filter((item) => !isOnDisk(item)).length,
      done: people.filter(isOnDisk).length,
      all: people.length,
    }),
    [people],
  );
  const visible = useMemo(
    () =>
      people.filter((item) =>
        filter === "all" ? true : filter === "open" ? !isOnDisk(item) : isOnDisk(item),
      ),
    [filter, people],
  );

  return (
    <div className="settings-requests">
      <header className="settings-requests__header">
        <div>
          <h2>Album requests</h2>
          <p>
            What people have asked for, and whether it is on disk yet. Anything not on disk still
            needs finding: buy it, rip it, or let Lidarr keep searching.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => report.refetch()}
          disabled={report.isFetching}
        >
          {report.isFetching ? (
            <DotLoader size="sm" label={null} />
          ) : (
            <RefreshCw className="settings-requests__icon" aria-hidden="true" />
          )}
          Refresh
        </button>
      </header>

      <div className="settings-requests__controls">
        <div className="settings-requests__filters" role="tablist" aria-label="Filter requests">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={filter === option.id}
              className={`settings-requests__filter${filter === option.id ? " is-active" : ""}`}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
              <span className="settings-requests__count">{counts[option.id]}</span>
            </button>
          ))}
        </div>
        <label className="settings-requests__toggle">
          <input
            type="checkbox"
            checked={includeAdmins}
            onChange={(event) => setIncludeAdmins(event.target.checked)}
          />
          Include admins&apos; own requests
        </label>
      </div>

      {report.isLoading ? (
        <div className="settings-requests__state">
          <DotLoader size="sm" label="Loading requests" />
        </div>
      ) : report.isError ? (
        <p className="settings-requests__state">
          Could not load requests: {report.error?.response?.data?.message || report.error?.message}
        </p>
      ) : visible.length === 0 ? (
        <p className="settings-requests__state">
          {filter === "open" ? "Nothing outstanding. Every request is on disk." : "No requests here yet."}
        </p>
      ) : (
        <div className="settings-requests__table-wrap">
          <table className="settings-requests__table">
            <thead>
              <tr>
                <th scope="col">Album</th>
                <th scope="col">Requested by</th>
                <th scope="col">Requested</th>
                <th scope="col">On disk</th>
                <th scope="col">Lidarr</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div className="settings-requests__album">{item.albumName}</div>
                    <div className="settings-requests__artist">
                      {item.artistMbid ? (
                        <Link to={`/artist/${item.artistMbid}`}>{item.artistName || "Artist"}</Link>
                      ) : (
                        item.artistName || "Unknown artist"
                      )}
                    </div>
                  </td>
                  <td>
                    {item.requestedBy?.username || "Unknown"}
                    {item.requestedBy?.isAdmin ? (
                      <span className="settings-requests__role">admin</span>
                    ) : null}
                  </td>
                  <td
                    title={
                      item.firstRequestedAt !== item.lastRequestedAt
                        ? `First asked ${formatDate(item.firstRequestedAt)}`
                        : undefined
                    }
                  >
                    {formatDate(item.lastRequestedAt)}
                  </td>
                  <td>
                    <span className={`settings-requests__badge is-${item.availability?.status}`}>
                      {item.availability?.label}
                    </span>
                  </td>
                  <td className="settings-requests__muted">
                    {item.activity?.label || (item.availability?.monitored ? "Monitored" : "—")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Tag as TagIcon, Trash2 } from "lucide-react";
import { DotLoader } from "../components/DotLoader";
import { useToast } from "../contexts/ToastContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import {
  applyTag,
  deleteTag,
  getMyTags,
  getTracksWithTag,
  renameTag,
} from "../utils/api/endpoints/tags.js";
import "./tags.css";

// Tagging is how his smart playlists decide what belongs in them, and until
// now the only tags there were came in with the iTunes library in 2021. These
// are his to add to, rename and drop; the imported ones stay as exported and
// are shown as coming from there.

const errorText = (error, fallback) =>
  error?.response?.data?.error || error?.message || fallback;

export default function TagsPage() {
  useDocumentTitle("Tags");
  const queryClient = useQueryClient();
  const { showError, showSuccess } = useToast();
  const [selected, setSelected] = useState("");
  const [renaming, setRenaming] = useState("");
  const [newName, setNewName] = useState("");

  const tags = useQuery({ queryKey: ["tags"], queryFn: ({ signal }) => getMyTags({ signal }) });
  const tracks = useQuery({
    queryKey: ["tags", "tracks", selected],
    queryFn: ({ signal }) => getTracksWithTag(selected, { signal }),
    enabled: Boolean(selected),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["tags"] });

  const rename = useMutation({
    mutationFn: () => renameTag({ from: renaming, to: newName }),
    onSuccess: (result) => {
      showSuccess(`Renamed on ${result.changed} song${result.changed === 1 ? "" : "s"}`);
      if (selected === renaming) setSelected(result.to);
      setRenaming("");
      setNewName("");
      refresh();
    },
    onError: (error) => showError(errorText(error, "Could not rename that tag")),
  });

  const drop = useMutation({
    mutationFn: (tag) => deleteTag(tag),
    onSuccess: (result) => {
      showSuccess(`Taken off ${result.changed} song${result.changed === 1 ? "" : "s"}`);
      if (selected === result.from) setSelected("");
      refresh();
    },
    onError: (error) => showError(errorText(error, "Could not drop that tag")),
  });

  const untag = useMutation({
    mutationFn: (trackId) => applyTag({ trackIds: [trackId], tag: selected, remove: true }),
    onSuccess: refresh,
    onError: (error) => showError(errorText(error, "Could not take that tag off")),
  });

  const rows = tags.data?.tags || [];

  return (
    <div className="tags-page">
      <header>
        <h1 className="page-title">Tags</h1>
        <p className="page-subtitle">
          Words on your songs, and what your smart playlists read. The ones your iTunes library
          brought are marked; anything you add here works the same way, including on music that
          arrived since.
        </p>
      </header>

      {tags.isLoading ? (
        <div className="tags-page__state"><DotLoader size="sm" label="Reading your tags" /></div>
      ) : rows.length === 0 ? (
        <p className="tags-page__muted">
          Nothing tagged yet. Put a tag on a song from the ••• beside it in your library.
        </p>
      ) : (
        <div className="tags-page__layout">
          <ul className="tags-page__list">
            {rows.map((row) => (
              <li key={row.tag} className={row.tag === selected ? "is-selected" : ""}>
                <button type="button" className="tags-page__tag" onClick={() => setSelected(row.tag)}>
                  <TagIcon aria-hidden="true" />
                  <span className="tags-page__name">{row.tag}</span>
                  <span className="tags-page__count">{row.songs}</span>
                </button>
                <div className="tags-page__row-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    onClick={() => { setRenaming(row.tag); setNewName(row.tag); }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    title="Takes it off every song, here and from the import"
                    onClick={() => drop.mutate(row.tag)}
                    disabled={drop.isPending}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                </div>
                {row.imported ? (
                  <p className="tags-page__origin">
                    {row.imported} from iTunes{row.own ? `, ${row.own} added here` : ""}
                  </p>
                ) : null}
                {renaming === row.tag ? (
                  <div className="tags-page__rename">
                    <input
                      type="text"
                      className="input input-sm"
                      value={newName}
                      autoFocus
                      onChange={(event) => setNewName(event.target.value)}
                      onKeyDown={(event) => event.key === "Enter" && newName.trim() && rename.mutate()}
                    />
                    <button
                      type="button"
                      className="btn btn-primary btn-xs"
                      disabled={!newName.trim() || rename.isPending}
                      onClick={() => rename.mutate()}
                    >
                      Save
                    </button>
                    <button type="button" className="btn btn-secondary btn-xs" onClick={() => setRenaming("")}>
                      Cancel
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>

          <div className="tags-page__songs">
            {!selected ? (
              <p className="tags-page__muted">Choose a tag to see what carries it.</p>
            ) : tracks.isLoading ? (
              <div className="tags-page__state"><DotLoader size="sm" label="Reading" /></div>
            ) : (
              <>
                <h2>{selected}</h2>
                <ul>
                  {(tracks.data?.tracks || []).map((track) => (
                    <li key={track.id}>
                      <span>
                        <strong>{track.title}</strong>
                        <span className="tags-page__muted"> — {track.artistName}{track.album ? ` · ${track.album}` : ""}</span>
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={() => untag.mutate(track.id)}
                        disabled={untag.isPending}
                      >
                        Take off
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

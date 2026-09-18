import { useEffect, useState } from "react";
import { SettingsSelect } from "./SettingsField";
import { getStreamQualities, setUserStreamQuality } from "../../../utils/api/endpoints/auth.js";
import { useToast } from "../../../contexts/ToastContext";

// How good the audio is for one person, set by an admin rather than chosen by
// them: it is about what their connection and their device can take, and what
// the server has to do about it. Takes effect on their next song - the stream
// reads it per request rather than at sign-in.

let cached = null;

export function UserStreamQuality({ user, onSaved }) {
  const { showError } = useToast();
  const [qualities, setQualities] = useState(cached);
  const [value, setValue] = useState(user?.streamQuality || "standard");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(user?.streamQuality || "standard");
  }, [user?.streamQuality]);

  useEffect(() => {
    if (cached) return;
    getStreamQualities()
      .then((data) => {
        cached = data?.qualities || [];
        setQualities(cached);
      })
      .catch(() => setQualities([]));
  }, []);

  const save = async (next) => {
    const previous = value;
    setValue(next);
    setSaving(true);
    try {
      await setUserStreamQuality(user.id, next);
      onSaved?.();
    } catch (error) {
      setValue(previous);
      showError(error.response?.data?.error || error.message || "Could not change that");
    } finally {
      setSaving(false);
    }
  };

  const chosen = (qualities || []).find((quality) => quality.id === value);

  return (
    <SettingsSelect
      value={value}
      disabled={saving || !qualities}
      onChange={(event) => save(event.target.value)}
      aria-label={`Audio quality for ${user?.username || "this user"}`}
      title={chosen ? `${chosen.summary} — ${chosen.detail}` : undefined}
    >
      {(qualities || [{ id: value, label: value }]).map((quality) => (
        <option key={quality.id} value={quality.id}>
          {quality.label}{quality.summary ? ` — ${quality.summary}` : ""}
        </option>
      ))}
    </SettingsSelect>
  );
}

export default UserStreamQuality;

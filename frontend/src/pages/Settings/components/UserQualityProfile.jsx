import { useEffect, useState } from "react";
import { SettingsSelect } from "./SettingsField";
import {
  getLidarrQualityProfiles,
  setUserQualityProfile,
} from "../../../utils/api/endpoints/auth.js";
import { useToast } from "../../../contexts/ToastContext";

// What quality this person's requests are fetched at. An admin's call rather
// than theirs: it decides what the downloaders go looking for and how much
// disk a request costs. Left unset, they follow whatever the server is on.

const SERVER_DEFAULT = "";

let cached = null;

export function UserQualityProfile({ user, onSaved }) {
  const { showError } = useToast();
  const [profiles, setProfiles] = useState(cached);
  const [value, setValue] = useState(
    user?.lidarrQualityProfileId == null ? SERVER_DEFAULT : String(user.lidarrQualityProfileId),
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(user?.lidarrQualityProfileId == null ? SERVER_DEFAULT : String(user.lidarrQualityProfileId));
  }, [user?.lidarrQualityProfileId]);

  useEffect(() => {
    if (cached) return;
    getLidarrQualityProfiles()
      .then((data) => {
        cached = data?.qualityProfiles || [];
        setProfiles(cached);
      })
      .catch(() => setProfiles([]));
  }, []);

  const save = async (next) => {
    const previous = value;
    setValue(next);
    setSaving(true);
    try {
      await setUserQualityProfile(user.id, next === SERVER_DEFAULT ? null : Number(next));
      onSaved?.();
    } catch (error) {
      setValue(previous);
      showError(error.response?.data?.message || error.response?.data?.error || error.message || "Could not change that");
    } finally {
      setSaving(false);
    }
  };

  if (profiles && !profiles.length) {
    return <span className="arr-table__path">Lidarr not configured</span>;
  }

  return (
    <SettingsSelect
      value={value}
      disabled={saving || !profiles}
      onChange={(event) => save(event.target.value)}
      aria-label={`Quality for ${user?.username || "this user"}`}
    >
      <option value={SERVER_DEFAULT}>Server default</option>
      {(profiles || []).map((profile) => (
        <option key={profile.id} value={String(profile.id)}>
          {profile.name}
        </option>
      ))}
    </SettingsSelect>
  );
}

export default UserQualityProfile;

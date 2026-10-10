import { useEffect, useState } from "react";
import { SettingsSelect } from "./SettingsField";
import { setUserAlbumRequestLimit } from "../../../utils/api/endpoints/auth.js";
import { useToast } from "../../../contexts/ToastContext";

// How many albums this person may ask for in a day. An admin's call: each
// request sends the downloaders out and costs disk. Admins have no limit.

// Kept in step with DEFAULT_DAILY_ALBUM_REQUESTS in albumRequestService.js.
const DEFAULT_DAILY = 3;
const FOLLOW_DEFAULT = "";
const NO_LIMIT = "-1";
const COUNTS = [0, 1, 2, 3, 5, 10, 20];

const toValue = (limit) => (limit == null ? FOLLOW_DEFAULT : String(limit));

export function UserRequestLimit({ user, onSaved }) {
  const { showError } = useToast();
  const [value, setValue] = useState(toValue(user?.albumRequestLimit));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(toValue(user?.albumRequestLimit));
  }, [user?.albumRequestLimit]);

  if (user?.role === "admin") {
    return <span className="arr-table__path">No limit</span>;
  }

  const save = async (next) => {
    const previous = value;
    setValue(next);
    setSaving(true);
    try {
      await setUserAlbumRequestLimit(user.id, next === FOLLOW_DEFAULT ? null : Number(next));
      onSaved?.();
    } catch (error) {
      setValue(previous);
      showError(error.response?.data?.message || error.response?.data?.error || error.message || "Could not change that");
    } finally {
      setSaving(false);
    }
  };

  // A number set by hand elsewhere still shows as itself.
  const counts = COUNTS.includes(Number(value)) || value === FOLLOW_DEFAULT || value === NO_LIMIT
    ? COUNTS
    : [...COUNTS, Number(value)].sort((a, b) => a - b);

  return (
    <SettingsSelect
      value={value}
      disabled={saving}
      onChange={(event) => save(event.target.value)}
      aria-label={`Albums a day for ${user?.username || "this user"}`}
    >
      <option value={FOLLOW_DEFAULT}>{DEFAULT_DAILY} a day (default)</option>
      {counts.map((count) => (
        <option key={count} value={String(count)}>
          {count === 0 ? "None" : `${count} a day`}
        </option>
      ))}
      <option value={NO_LIMIT}>No limit</option>
    </SettingsSelect>
  );
}

export default UserRequestLimit;

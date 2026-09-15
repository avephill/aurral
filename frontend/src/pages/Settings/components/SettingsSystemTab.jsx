import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Check, Copy, RotateCcw } from "lucide-react";
import { DotLoader } from "../../../components/DotLoader";
import {
  getApiKey,
  getLidarrWebhookKey,
  getLidarrWebhookStatus,
  rotateApiKey,
  rotateLidarrWebhookKey,
} from "../../../utils/api/endpoints/auth";
import { SettingsSystemSection } from "./SettingsStorageSection";
import { SettingsSelect } from "./SettingsField";
import PillToggle from "../../../components/PillToggle";
import { setDateTimeFormat } from "../../../utils/dateTime.js";

// One secret shown with copy and rotate buttons: the API key and the Lidarr
// webhook key work the same way here.
function SecretKeyRow({ label, description, load, rotate, pick, showSuccess, showError }) {
  const [value, setValue] = useState(null);
  const [loading, setLoading] = useState(true);
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState(false);

  const fetchValue = useCallback(async () => {
    try {
      setValue(pick(await load()) || null);
    } catch {
      setValue(null);
    } finally {
      setLoading(false);
    }
  }, [load, pick]);

  useEffect(() => {
    fetchValue();
  }, [fetchValue]);

  const handleCopy = async () => {
    if (!value) return;
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      showError(`Failed to copy the ${label}. Select it and copy it manually.`);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showError(`Failed to copy the ${label}. Select it and copy it manually.`);
    }
  };

  const handleRotate = async () => {
    setRotating(true);
    try {
      setValue(pick(await rotate()) || null);
      showSuccess(`${label} rotated`);
    } catch {
      showError(`Failed to rotate the ${label}`);
    } finally {
      setRotating(false);
    }
  };

  if (loading) {
    return (
      <div className="settings-system__row">
        <div className="settings-system__copy">
          <div className="settings-system__label">{label}</div>
        </div>
        <div className="settings-system__value">
          <DotLoader size="sm" label={null} /> Loading…
        </div>
      </div>
    );
  }

  if (!value) {
    return (
      <div className="settings-system__row">
        <div className="settings-system__copy">
          <div className="settings-system__label">{label}</div>
        </div>
        <div className="settings-system__value settings-system__value--error">
          <AlertCircle className="artist-icon-xs" aria-hidden />
          Unable to load the {label}
        </div>
      </div>
    );
  }

  return (
    <div className="settings-system__row">
      <div className="settings-system__copy">
        <div className="settings-system__label">{label}</div>
        <p className="settings-system__description">{description}</p>
      </div>
      <div className="settings-system__api-value">
        <code className="settings-system__api-key" title={label}>
          {value}
        </code>
        <button
          type="button"
          className="arr-btn arr-btn--ghost arr-btn--icon"
          onClick={handleCopy}
          title={copied ? "Copied" : "Copy to clipboard"}
          aria-label={copied ? "Copied" : `Copy ${label}`}
        >
          {copied ? <Check className="artist-icon-xs" /> : <Copy className="artist-icon-xs" />}
        </button>
        <button
          type="button"
          className="arr-btn arr-btn--ghost arr-btn--icon"
          onClick={handleRotate}
          disabled={rotating}
          title={`Rotate ${label}`}
          aria-label={`Rotate ${label}`}
        >
          {rotating ? (
            <DotLoader size="xs" label={null} />
          ) : (
            <RotateCcw className="artist-icon-xs" aria-hidden />
          )}
        </button>
      </div>
    </div>
  );
}

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const ago = (timestamp) => {
  const seconds = Math.round((Number(timestamp) - Date.now()) / 1000);
  const units = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  const [unit, size] = units.find(([, unitSeconds]) => Math.abs(seconds) >= unitSeconds) || ["second", 1];
  return relativeTime.format(Math.round(seconds / size), unit);
};

// Whether Lidarr's webhook is arriving and being acted on. The library relies
// on it for new albums, so a quiet or failing webhook should be seen here.
function LidarrWebhookStatusRow() {
  const [status, setStatus] = useState(null);
  const [failedToLoad, setFailedToLoad] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getLidarrWebhookStatus()
        .then((next) => {
          if (cancelled) return;
          setStatus(next);
          setFailedToLoad(false);
        })
        .catch(() => {
          if (!cancelled) setFailedToLoad(true);
        });
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  let summary;
  let value;
  if (failedToLoad) {
    summary = "Could not read the webhook status.";
    value = "Unknown";
  } else if (!status) {
    summary = "Loading…";
    value = <DotLoader size="sm" label={null} />;
  } else if (!status.lastEvent) {
    summary = "No events received yet. Press Test in Lidarr's webhook settings to check the connection.";
    value = "Nothing yet";
  } else {
    const parts = [
      `Last event: ${status.lastEvent.type}, ${ago(status.lastEvent.receivedAt)}.`,
      `${status.lastDay} in the last day.`,
    ];
    if (status.lastIndexed) {
      parts.push(`Last indexed after ${status.lastIndexed.type}, ${ago(status.lastIndexed.processedAt)}.`);
    }
    if (status.pending) parts.push(`${status.pending} waiting to be indexed.`);
    if (status.lastError) {
      parts.push(
        `${status.lastError.status === "failed" ? "Gave up on" : "Retrying"} a ${status.lastError.type} event: ${status.lastError.message}`,
      );
    }
    summary = parts.join(" ");
    value = status.failed ? `${status.failed} failed` : "Receiving";
  }

  return (
    <div className="settings-system__row">
      <div className="settings-system__copy">
        <div className="settings-system__label">Status</div>
        <p className="settings-system__description">{summary}</p>
      </div>
      <div
        className={`settings-system__value${failedToLoad || status?.failed ? " settings-system__value--error" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}

const pickApiKey = (response) => response?.apiKey;
const pickWebhookKey = (response) => response?.key;

export function SettingsSystemTab({ health, settings, updateSettings, showSuccess, showError }) {
  return (
    <div className="arr-page settings-system">
      <SettingsSystemSection health={health} />

      <section className="settings-system__section">
        <div className="settings-system__section-header">
          <h2 className="settings-system__section-title">Display</h2>
        </div>
        <div className="settings-system__rows">
          <div className="settings-system__row">
            <div className="settings-system__copy">
              <label className="settings-system__label" htmlFor="date-time-format">
                Date and time format
              </label>
              <p className="settings-system__description">
                Set the date and 24-hour time order for all users.
              </p>
            </div>
            <SettingsSelect
              id="date-time-format"
              value={settings.dateTimeFormat}
              onChange={(event) => {
                const dateTimeFormat = event.target.value;
                setDateTimeFormat(dateTimeFormat);
                updateSettings({ ...settings, dateTimeFormat });
              }}
            >
              <option value="browser">Browser default</option>
              <option value="day-first">14:30 09/08/2026</option>
              <option value="year-first">2026/08/09 14:30</option>
            </SettingsSelect>
          </div>
        </div>
      </section>

      <section className="settings-system__section">
        <div className="settings-system__section-header">
          <h2 className="settings-system__section-title">Subsonic</h2>
        </div>
        <div className="settings-system__rows">
          <div className="settings-system__row">
            <div className="settings-system__copy">
              <label className="settings-system__label" htmlFor="subsonic-favorite-auto-keep">
                Favorite Flow tracks
              </label>
              <p className="settings-system__description">
                Keep a Flow track in the permanent Library when a Subsonic client favorites it.
              </p>
            </div>
            <div className="settings-system__value">
              <PillToggle
                id="subsonic-favorite-auto-keep"
                checked={settings.subsonic?.favoriteAutoKeep !== false}
                onChange={(event) =>
                  updateSettings({
                    ...settings,
                    subsonic: {
                      ...(settings.subsonic || {}),
                      favoriteAutoKeep: event.target.checked,
                    },
                  })
                }
                aria-label="Keep Flow tracks when favorited through Subsonic"
              />
            </div>
          </div>
        </div>
      </section>

      <section className="settings-system__section settings-system__api-section">
        <div className="settings-system__section-header">
          <h2 className="settings-system__section-title">API access</h2>
          <p className="settings-system__section-description">
            Authenticate requests with an <code>X-Api-Key</code> header or <code>api_key</code>{" "}
            query parameter.
          </p>
        </div>
        <div className="settings-system__rows">
          <SecretKeyRow
            label="API key"
            description="Admin access to everything. Keep this key private."
            load={getApiKey}
            rotate={rotateApiKey}
            pick={pickApiKey}
            showSuccess={showSuccess}
            showError={showError}
          />
        </div>
      </section>

      <section className="settings-system__section settings-system__api-section">
        <div className="settings-system__section-header">
          <h2 className="settings-system__section-title">Lidarr webhook</h2>
          <p className="settings-system__section-description">
            In Lidarr, add a Webhook under Settings → Connect. Set the URL to an address of Psalter
            that Lidarr can reach, ending in <code>/api/webhooks/lidarr</code>, and add a header named{" "}
            <code>X-Webhook-Key</code> with the key below.
          </p>
        </div>
        <div className="settings-system__rows">
          <LidarrWebhookStatusRow />
          <SecretKeyRow
            label="Webhook key"
            description="Opens the Lidarr webhook and nothing else. Rotating it only stops the webhook until Lidarr has the new key."
            load={getLidarrWebhookKey}
            rotate={rotateLidarrWebhookKey}
            pick={pickWebhookKey}
            showSuccess={showSuccess}
            showError={showError}
          />
        </div>
      </section>
    </div>
  );
}

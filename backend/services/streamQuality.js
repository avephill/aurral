/**
 * How good the audio is when Psalter plays it.
 *
 * Navidrome does the work: a stream request carries a format and a ceiling in
 * kbps, and it either transcodes to fit or hands the file over untouched. The
 * choice belongs to an admin rather than to each person, because it is about
 * what the connection and the device can take - someone listening on a phone
 * over mobile data and someone at a desk on the same network are not asking
 * the same thing of the server.
 *
 * `original` is the honest name for lossless. Nothing here converts a file to
 * 16-bit FLAC: it sends what is on disk. A library of 16-bit FLAC plays as
 * 16-bit FLAC, and a 24-bit file plays as 24-bit, because nothing downsamples.
 */

export const DEFAULT_STREAM_QUALITY = "standard";

export const STREAM_QUALITIES = [
  {
    id: "standard",
    label: "Standard",
    summary: "MP3 at 192 kbps",
    detail: "Small enough for a phone on mobile data, and hard to fault on ordinary speakers.",
    format: "mp3",
    maxBitRate: 192,
  },
  {
    id: "high",
    label: "High",
    summary: "MP3 at 320 kbps",
    detail: "As good as MP3 gets. Roughly twice the data of Standard.",
    format: "mp3",
    maxBitRate: 320,
  },
  {
    id: "original",
    label: "Original",
    summary: "the file as it is, never transcoded",
    detail:
      "Lossless where the file is lossless - a 16-bit FLAC plays as a 16-bit FLAC. Nothing is converted or downsampled, so a 24-bit file arrives as 24-bit and a big one is a big download.",
    format: "raw",
    maxBitRate: 0,
  },
];

const BY_ID = new Map(STREAM_QUALITIES.map((quality) => [quality.id, quality]));

export const isStreamQuality = (id) => BY_ID.has(String(id || ""));

/** The named quality, or Standard when the name means nothing. */
export function streamQuality(id) {
  return BY_ID.get(String(id || "")) || BY_ID.get(DEFAULT_STREAM_QUALITY);
}

/**
 * What to put on a Subsonic stream request. `raw` asks Navidrome for the file
 * itself; a ceiling of zero means no ceiling, which is what Subsonic reads an
 * absent maxBitRate as anyway, so it is left off rather than sent as 0.
 */
export function streamParams(id) {
  const quality = streamQuality(id);
  const params = { format: quality.format };
  if (quality.maxBitRate > 0) params.maxBitRate = quality.maxBitRate;
  return params;
}

/**
 * Smart playlists, the iTunes idea: a playlist described by rules rather than
 * by a list of songs, kept up to date on its own.
 *
 * Navidrome evaluates the rules, so Aurral's job is to say what the rules are
 * in a shape a person can edit and Navidrome will accept. The two shapes
 * differ: an editor wants a row of field, operator and value, while Navidrome
 * wants `{ "contains": { "title": "love" } }`. Everything crossing that line
 * goes through here, in both directions, and anything not in the catalogue
 * below is refused rather than passed along, because Navidrome answers an
 * unknown field with an empty playlist rather than an error.
 */

const TEXT_OPERATORS = ["is", "isNot", "contains", "notContains", "startsWith", "endsWith"];
const NUMBER_OPERATORS = ["is", "isNot", "gt", "lt", "inTheRange"];
const DATE_OPERATORS = ["before", "after", "inTheLast", "notInTheLast", "inTheRange"];
const BOOLEAN_OPERATORS = ["is"];

// Field name as Navidrome knows it, the kind of value it holds, and the label
// the editor shows. Ordered as the editor lists them.
const FIELDS = [
  { name: "title", type: "text", label: "Title" },
  { name: "album", type: "text", label: "Album" },
  { name: "artist", type: "text", label: "Artist" },
  { name: "albumartist", type: "text", label: "Album artist" },
  { name: "genre", type: "text", label: "Genre" },
  { name: "comment", type: "text", label: "Comment" },
  { name: "lyrics", type: "text", label: "Lyrics" },
  { name: "albumtype", type: "text", label: "Album type" },
  { name: "catalognum", type: "text", label: "Catalogue number" },
  { name: "discsubtitle", type: "text", label: "Disc subtitle" },
  { name: "filetype", type: "text", label: "File type" },
  { name: "filepath", type: "text", label: "File path" },
  { name: "year", type: "number", label: "Year" },
  { name: "rating", type: "number", label: "Rating" },
  { name: "playcount", type: "number", label: "Play count" },
  { name: "duration", type: "number", label: "Length in seconds" },
  { name: "bitrate", type: "number", label: "Bitrate" },
  { name: "bpm", type: "number", label: "Beats per minute" },
  { name: "loved", type: "boolean", label: "Loved" },
  { name: "compilation", type: "boolean", label: "Compilation" },
  { name: "dateadded", type: "date", label: "Date added" },
  { name: "lastplayed", type: "date", label: "Last played" },
  { name: "datemodified", type: "date", label: "Date modified" },
];

const OPERATORS_BY_TYPE = {
  text: TEXT_OPERATORS,
  number: NUMBER_OPERATORS,
  date: DATE_OPERATORS,
  boolean: BOOLEAN_OPERATORS,
};

// Labels for the operators, so the editor reads as a sentence.
const OPERATOR_LABELS = {
  is: "is",
  isNot: "is not",
  contains: "contains",
  notContains: "does not contain",
  startsWith: "starts with",
  endsWith: "ends with",
  gt: "is greater than",
  lt: "is less than",
  inTheRange: "is between",
  before: "is before",
  after: "is after",
  inTheLast: "is in the last (days)",
  notInTheLast: "is not in the last (days)",
};

const FIELD_BY_NAME = new Map(FIELDS.map((field) => [field.name, field]));
const SORTABLE = ["random", ...FIELDS.map((field) => field.name)];
const MAX_CONDITIONS = 25;
const MAX_LIMIT = 5000;

export class SmartPlaylistRuleError extends Error {
  constructor(message) {
    super(message);
    this.name = "SmartPlaylistRuleError";
    this.status = 400;
  }
}

/** Everything the editor needs to offer only rules Navidrome will honour. */
export function describeSmartPlaylistFields() {
  return {
    fields: FIELDS.map((field) => ({
      ...field,
      operators: OPERATORS_BY_TYPE[field.type].map((operator) => ({
        name: operator,
        label: OPERATOR_LABELS[operator],
      })),
    })),
    sortFields: SORTABLE,
    maxConditions: MAX_CONDITIONS,
    maxLimit: MAX_LIMIT,
  };
}

function coerce(field, operator, rawValue) {
  if (field.type === "boolean") {
    if (typeof rawValue === "boolean") return rawValue;
    const text = String(rawValue ?? "").trim().toLowerCase();
    if (["true", "yes", "1"].includes(text)) return true;
    if (["false", "no", "0"].includes(text)) return false;
    throw new SmartPlaylistRuleError(`${field.label} takes yes or no`);
  }

  if (operator === "inTheRange") {
    const pair = Array.isArray(rawValue) ? rawValue : String(rawValue ?? "").split(",");
    if (pair.length !== 2) throw new SmartPlaylistRuleError(`${field.label} between needs two values`);
    return pair.map((value) => coerceScalar(field, value));
  }

  return coerceScalar(field, rawValue, operator);
}

function coerceScalar(field, rawValue, operator = null) {
  if (field.type === "number" || (field.type === "date" && ["inTheLast", "notInTheLast"].includes(operator))) {
    const number = Number(rawValue);
    if (!Number.isFinite(number)) throw new SmartPlaylistRuleError(`${field.label} takes a number`);
    return number;
  }
  if (field.type === "date") {
    const text = String(rawValue ?? "").trim();
    // Navidrome reads dates as ISO, and a day on its own is enough.
    if (!/^\d{4}-\d{2}-\d{2}/.test(text)) {
      throw new SmartPlaylistRuleError(`${field.label} takes a date, written as 2026-01-31`);
    }
    return text;
  }
  const text = String(rawValue ?? "").trim();
  if (!text) throw new SmartPlaylistRuleError(`${field.label} needs a value`);
  return text;
}

/**
 * An editor's rules to Navidrome's. Throws SmartPlaylistRuleError with a
 * message meant for the person who typed it.
 */
export function toNavidromeRules(input) {
  const match = String(input?.match || "all").toLowerCase();
  if (!["all", "any"].includes(match)) throw new SmartPlaylistRuleError("Match must be all or any");

  const conditions = Array.isArray(input?.conditions) ? input.conditions : [];
  if (!conditions.length) throw new SmartPlaylistRuleError("A smart playlist needs at least one rule");
  if (conditions.length > MAX_CONDITIONS) {
    throw new SmartPlaylistRuleError(`At most ${MAX_CONDITIONS} rules`);
  }

  const clauses = conditions.map((condition) => {
    const field = FIELD_BY_NAME.get(String(condition?.field || "").trim());
    if (!field) throw new SmartPlaylistRuleError(`Unknown field: ${condition?.field}`);
    const operator = String(condition?.operator || "").trim();
    if (!OPERATORS_BY_TYPE[field.type].includes(operator)) {
      throw new SmartPlaylistRuleError(`${field.label} cannot be asked "${operator}"`);
    }
    return { [operator]: { [field.name]: coerce(field, operator, condition?.value) } };
  });

  const rules = { [match]: clauses };

  const sort = String(input?.sort || "").trim();
  if (sort) {
    if (!SORTABLE.includes(sort)) throw new SmartPlaylistRuleError(`Cannot sort by ${sort}`);
    rules.sort = sort;
    const order = String(input?.order || "asc").toLowerCase();
    if (!["asc", "desc"].includes(order)) throw new SmartPlaylistRuleError("Order must be asc or desc");
    // Navidrome has no order for a random pick, and sending one confuses it.
    if (sort !== "random") rules.order = order;
  }

  if (input?.limit !== undefined && input?.limit !== null && input?.limit !== "") {
    const limit = Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new SmartPlaylistRuleError(`Limit must be a whole number up to ${MAX_LIMIT}`);
    }
    rules.limit = limit;
  }

  return rules;
}

/**
 * Navidrome's rules back to the editor's shape, so an existing smart playlist
 * can be opened and changed. Returns null for rules this editor cannot show,
 * which keeps it from silently rewriting something it does not understand.
 */
export function fromNavidromeRules(rules) {
  if (!rules || typeof rules !== "object") return null;
  const match = Array.isArray(rules.all) ? "all" : Array.isArray(rules.any) ? "any" : null;
  if (!match) return null;

  const conditions = [];
  for (const clause of rules[match]) {
    if (!clause || typeof clause !== "object") return null;
    const [operator, payload] = Object.entries(clause)[0] || [];
    if (!operator || !payload || typeof payload !== "object") return null;
    const [fieldName, value] = Object.entries(payload)[0] || [];
    const field = FIELD_BY_NAME.get(String(fieldName || ""));
    // A nested group, or a field this editor does not offer: leave it alone.
    if (!field || !OPERATORS_BY_TYPE[field.type].includes(operator)) return null;
    conditions.push({
      field: field.name,
      operator,
      value: Array.isArray(value) ? value.join(",") : value,
    });
  }
  if (!conditions.length) return null;

  return {
    match,
    conditions,
    sort: rules.sort ? String(rules.sort) : "",
    order: rules.order === "desc" ? "desc" : "asc",
    limit: Number.isFinite(Number(rules.limit)) && Number(rules.limit) > 0 ? Number(rules.limit) : null,
  };
}

/** True when this playlist is described by rules rather than by its contents. */
export function isSmartPlaylistRecord(record) {
  const rules = record?.rules;
  return Boolean(rules && typeof rules === "object" && (Array.isArray(rules.all) || Array.isArray(rules.any)));
}

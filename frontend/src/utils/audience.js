// Who a recommendation went to, read out as a person would say it. "Everyone"
// tells you nothing about who saw it, and on a server with three people the
// names are shorter than the word.

export const formatAudience = (names = [], me = "") => {
  const others = names.filter((name) => name && name !== me);
  const list = names.includes(me) ? ["you", ...others] : others;
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
};

/** "avery told you and dunshill", or just the sender when nobody is named. */
export const describeRecommendationFrom = (entry, me = "") => {
  const audience = formatAudience(entry?.audience || [], me);
  return audience ? `${entry?.sender} told ${audience}` : `from ${entry?.sender}`;
};

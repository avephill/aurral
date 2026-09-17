// Where to put the tour card so it sits beside what it is talking about
// without covering it. The sidebar entries it points at are narrow and on the
// left, the search box is wide and along the top, so no single corner works:
// the card goes to whichever side of the target has room for it.

export const CARD_GAP = 16;
export const VIEWPORT_MARGIN = 12;

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

const fits = (start, size, limit) => start >= VIEWPORT_MARGIN && start + size <= limit - VIEWPORT_MARGIN;

export const placeWalkthroughCard = ({ target, card, viewport }) => {
  const width = card?.width || 0;
  const height = card?.height || 0;
  const vw = viewport?.width || 0;
  const vh = viewport?.height || 0;

  // Nothing to sit beside: the card keeps its resting place, bottom right.
  if (!target) return null;

  const right = target.left + target.width + CARD_GAP;
  const left = target.left - CARD_GAP - width;
  const below = target.top + target.height + CARD_GAP;
  const above = target.top - CARD_GAP - height;

  if (fits(right, width, vw)) {
    return { left: right, top: clamp(target.top, VIEWPORT_MARGIN, vh - height - VIEWPORT_MARGIN) };
  }
  if (fits(left, width, vw)) {
    return { left, top: clamp(target.top, VIEWPORT_MARGIN, vh - height - VIEWPORT_MARGIN) };
  }
  if (fits(below, height, vh)) {
    return { top: below, left: clamp(target.left, VIEWPORT_MARGIN, vw - width - VIEWPORT_MARGIN) };
  }
  if (fits(above, height, vh)) {
    return { top: above, left: clamp(target.left, VIEWPORT_MARGIN, vw - width - VIEWPORT_MARGIN) };
  }

  // Too cramped for any side: there is no placement that clears the target, so
  // take the roomier strip above or below it and sit flush in that.
  const spaceAbove = target.top;
  const spaceBelow = vh - (target.top + target.height);
  const cornerLeft = clamp(
    vw - width - VIEWPORT_MARGIN,
    VIEWPORT_MARGIN,
    Math.max(VIEWPORT_MARGIN, vw - width - VIEWPORT_MARGIN),
  );
  if (spaceBelow >= spaceAbove) {
    return { top: Math.max(VIEWPORT_MARGIN, vh - height - VIEWPORT_MARGIN), left: cornerLeft };
  }
  return { top: VIEWPORT_MARGIN, left: cornerLeft };
};

// Does the card, where it landed, sit clear of what the step is pointing at?
export const cardClearsTarget = (placement, target, card) => {
  if (!placement || !target) return true;
  const a = { top: placement.top, left: placement.left, right: placement.left + card.width, bottom: placement.top + card.height };
  const b = { top: target.top, left: target.left, right: target.left + target.width, bottom: target.top + target.height };
  return a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom;
};

/** Card decks and card classification. */

/** Cards that carry no numeric meaning and are excluded from statistics. */
export const SPECIAL_CARDS = ["?", "☕"];

export const DECKS = {
  fibonacci: {
    id: "fibonacci",
    label: "Fibonacci",
    cards: ["0", "1", "2", "3", "5", "8", "13", "21", "34", "55", "89", "?", "☕"],
  },
  fibShort: {
    id: "fibShort",
    label: "Fibonacci (short)",
    cards: ["0", "½", "1", "2", "3", "5", "8", "13", "20", "40", "100", "?", "☕"],
  },
  powers: {
    id: "powers",
    label: "Powers of 2",
    cards: ["0", "1", "2", "4", "8", "16", "32", "64", "?", "☕"],
  },
  tshirt: {
    id: "tshirt",
    label: "T-shirt sizes",
    cards: ["XS", "S", "M", "L", "XL", "XXL", "?", "☕"],
  },
  sequential: {
    id: "sequential",
    label: "Sequential 0–10",
    cards: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "?", "☕"],
  },
  custom: {
    id: "custom",
    label: "Custom deck",
    cards: [],
  },
};

export const DECK_LIST = Object.values(DECKS);

export function isSpecialCard(card) {
  return SPECIAL_CARDS.includes(card);
}

/** True for cards that can take part in numeric statistics. */
export function isNumericCard(card) {
  return cardToNumber(card) !== null;
}

/** Numeric value of a card, or null. Understands the ½ card. */
export function cardToNumber(card) {
  if (card === null || card === undefined) return null;
  const text = String(card).trim();
  if (text === "½" || text === "1/2") return 0.5;
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
}

/** The cards in play for a room, honouring a custom deck. */
export function deckCards(room) {
  if (!room) return DECKS.fibonacci.cards;
  if (room.deckId === "custom") {
    const custom = Array.isArray(room.customCards) ? room.customCards.filter(Boolean) : [];
    return custom.length ? custom : DECKS.fibonacci.cards;
  }
  return (DECKS[room.deckId] || DECKS.fibonacci).cards;
}

export function deckLabel(room) {
  if (!room) return DECKS.fibonacci.label;
  return (DECKS[room.deckId] || DECKS.fibonacci).label;
}

/** Parse a comma/space separated custom deck into unique cards. */
export function parseCustomDeck(text) {
  const seen = new Set();
  const cards = [];
  for (const raw of String(text || "").split(/[,\n]+|\s{2,}/)) {
    const card = raw.trim();
    if (!card || seen.has(card)) continue;
    seen.add(card);
    cards.push(card);
  }
  return cards;
}

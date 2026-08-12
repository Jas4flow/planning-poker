/** Vote statistics. Pure functions — covered by tests.html. */

import { cardToNumber, isSpecialCard } from "./decks.js";

/**
 * @param {{name: string, card: string}[]} votes cast votes (spectators excluded by the caller)
 * @param {string[]} cards the deck in play, used for ordering and agreement
 */
export function computeStats(votes, cards) {
  const cast = (votes || []).filter((v) => v && v.card !== null && v.card !== undefined);
  const scale = (cards || []).filter((c) => !isSpecialCard(c));
  const counted = cast.filter((v) => !isSpecialCard(v.card));
  const numbers = counted
    .map((v) => cardToNumber(v.card))
    .filter((n) => n !== null)
    .sort((a, b) => a - b);

  const distribution = buildDistribution(cast, cards);
  const topCount = distribution.length ? Math.max(...distribution.map((d) => d.count)) : 0;
  for (const bucket of distribution) bucket.isTop = topCount > 0 && bucket.count === topCount;

  const average = numbers.length ? mean(numbers) : null;
  const median = numbers.length ? medianOf(numbers) : null;
  const modes = distribution.filter((d) => d.isTop).map((d) => d.card);
  const consensus = counted.length > 0 && new Set(counted.map((v) => v.card)).size === 1;

  return {
    total: cast.length,
    countedTotal: counted.length,
    specials: cast.length - counted.length,
    average,
    median,
    min: numbers.length ? numbers[0] : null,
    max: numbers.length ? numbers[numbers.length - 1] : null,
    modes,
    consensus,
    agreement: agreementPercent(counted, scale),
    distribution,
    suggestion: suggestEstimate({ average, modes, cards }),
    outliers: findOutliers(distribution, scale),
  };
}

function mean(numbers) {
  return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
}

function medianOf(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One bucket per voted card, in deck order, with unexpected cards appended. */
function buildDistribution(cast, cards) {
  const byCard = new Map();
  for (const vote of cast) {
    if (!byCard.has(vote.card)) byCard.set(vote.card, []);
    byCard.get(vote.card).push(vote.name);
  }
  const ordered = [];
  for (const card of cards || []) {
    if (byCard.has(card)) {
      ordered.push({ card, count: byCard.get(card).length, voters: byCard.get(card) });
      byCard.delete(card);
    }
  }
  for (const [card, voters] of byCard) {
    ordered.push({ card, count: voters.length, voters });
  }
  return ordered;
}

/**
 * 100% when everyone picked the same card, falling towards 0% as picks spread
 * across the deck. Measured as mean absolute deviation of deck positions,
 * normalised by the worst case for that deck.
 */
export function agreementPercent(counted, scale) {
  const positions = counted
    .map((v) => scale.indexOf(v.card))
    .filter((i) => i >= 0);
  if (positions.length < 2) return counted.length ? 100 : null;
  const centre = mean(positions);
  const deviation = mean(positions.map((p) => Math.abs(p - centre)));
  const worst = (scale.length - 1) / 2 || 1;
  return Math.max(0, Math.min(100, Math.round((1 - deviation / worst) * 100)));
}

/** Nearest deck card to the average; ties round up. Falls back to the single mode. */
export function suggestEstimate({ average, modes, cards }) {
  const numericCards = (cards || [])
    .map((card) => ({ card, value: cardToNumber(card) }))
    .filter((entry) => entry.value !== null);
  if (average !== null && numericCards.length) {
    let best = numericCards[0];
    let bestDistance = Infinity;
    for (const entry of numericCards) {
      const distance = Math.abs(entry.value - average);
      if (distance < bestDistance || (distance === bestDistance && entry.value > best.value)) {
        best = entry;
        bestDistance = distance;
      }
    }
    return best.card;
  }
  return modes && modes.length === 1 ? modes[0] : null;
}

/** Lone votes at least two deck positions away from the modal pick. */
function findOutliers(distribution, scale) {
  if (distribution.length < 2) return [];
  const top = distribution.filter((d) => d.isTop).map((d) => scale.indexOf(d.card));
  const anchor = top.filter((i) => i >= 0);
  if (!anchor.length) return [];
  const centre = mean(anchor);
  return distribution
    .filter((d) => {
      const position = scale.indexOf(d.card);
      return d.count === 1 && position >= 0 && Math.abs(position - centre) >= 2;
    })
    .map((d) => d.card);
}

/**
 * Validate a story-point value before sending it to Jira.
 * @returns {{ok: boolean, value?: number|string, error?: string, warning?: string}}
 */
export function validatePointValue(raw, cards) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, error: "Enter a story point value." };
  const number = cardToNumber(text);
  if (number === null) {
    // Non-numeric decks (T-shirt) can only be written to a text field in Jira.
    if ((cards || []).includes(text)) {
      return {
        ok: true,
        value: text,
        warning: `"${text}" is not a number — Jira will reject it unless your story point field accepts text.`,
      };
    }
    return { ok: false, error: `"${text}" is not a number and is not a card in this deck.` };
  }
  if (number < 0) return { ok: false, error: "Story points cannot be negative." };
  if (number > 1000) return { ok: false, error: "That looks too large for a story point value." };
  const warning = (cards || []).includes(text)
    ? undefined
    : `${text} is not a card in this deck — sending it anyway.`;
  return { ok: true, value: number, warning };
}

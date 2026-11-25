/**
 * Pure room filtering & date-range helpers for Yosemite Valley lodging.
 * Ensures canvas tents, tent cabins, and cabins without private baths
 * are strictly excluded when configured.
 */

const TENT_PATTERNS = [
  /\bcanvas\b/i,
  /\btent\b/i,
  /\btent\s+cabin\b/i
];

const NO_BATH_PATTERNS = [
  /\bwithout\s+bath\b/i,
  /\bno\s+bath\b/i,
  /\bshared\s+bath\b/i
];

/**
 * Decide whether a scraped room passes the watch's room-type and price filters.
 * Note: Housekeeping Camp ('H') is its own dedicated property and is never
 * rejected by tent/bath filters when explicitly selected in the watch.
 */
function roomMatchesWatch(room, watch) {
  const title = String(room.roomName || '');
  const desc = String(room.description || '');
  const propCode = String(room.propertyCode || '');
  const combined = `${title} ${desc}`;

  if (propCode !== 'H') {
    if (watch.excludeTents) {
      if (TENT_PATTERNS.some(re => re.test(title)) || /\bcanvas\s+tent\b/i.test(combined)) {
        return { matched: false, reason: 'Excluded tent / canvas cabin' };
      }
    }

    if (watch.requirePrivateBath) {
      if (NO_BATH_PATTERNS.some(re => re.test(title))) {
        return { matched: false, reason: 'Excluded room without private bath' };
      }
      // At Curry Village, explicitly ensure wooden cabins specify "with Bath" or are Stoneman hotel rooms
      if (propCode === 'D') {
        const isStoneman = /\bstoneman\b/i.test(title);
        const isCabinWithBath = /\bcabin\s+with\s+bath\b/i.test(title);
        if (!isStoneman && !isCabinWithBath) {
          return { matched: false, reason: 'Excluded non-bath Curry Village unit' };
        }
      }
    }
  }

  if (watch.maxPricePerNight && typeof room.pricePerNight === 'number' && room.pricePerNight > watch.maxPricePerNight) {
    return { matched: false, reason: `Above $${watch.maxPricePerNight}/night cap` };
  }

  return { matched: true, reason: null };
}

/**
 * Build the list of date windows to query for a watch:
 * - Always includes the full stay (checkIn -> checkOut)
 * - If matchMode === 'both' and stay > 1 night, also includes each individual night
 */
function buildDateSegments(checkIn, checkOut, matchMode = 'both') {
  const start = new Date(checkIn + 'T00:00:00Z');
  const end = new Date(checkOut + 'T00:00:00Z');
  const nights = Math.round((end - start) / 86400000);

  const segments = [
    {
      kind: 'full',
      label: `Full Stay (${formatShortDate(checkIn)} – ${formatShortDate(checkOut)}, ${nights} ${nights === 1 ? 'night' : 'nights'})`,
      checkIn,
      checkOut,
      nights
    }
  ];

  if (matchMode === 'both' && nights > 1) {
    for (let i = 0; i < nights; i++) {
      const nStart = addDays(checkIn, i);
      const nEnd = addDays(checkIn, i + 1);
      segments.push({
        kind: 'night',
        label: `Night of ${formatShortDate(nStart)}`,
        checkIn: nStart,
        checkOut: nEnd,
        nights: 1
      });
    }
  }

  return segments;
}

function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function toUsDate(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${m}/${d}/${y}`;
}

function formatShortDate(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function parsePrice(priceText) {
  if (!priceText) return null;
  const cleaned = String(priceText).replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

// Text Yosemite's reservation site shows instead of the search form during maintenance.
const OUTAGE_PATTERN = 'currently offline for maintenance|temporarily (?:offline|unavailable)|ERR:\\s*SCHM';

/** Returns the site's error code (or "maintenance") when the page is an outage notice, otherwise null. */
function detectSiteOutage(pageText) {
  const text = String(pageText || '');
  if (!new RegExp(OUTAGE_PATTERN, 'i').test(text)) return null;
  const code = text.match(/ERR:\s*([A-Z0-9]+)/i);
  return code ? code[1].toUpperCase() : 'maintenance';
}

module.exports = {
  roomMatchesWatch,
  buildDateSegments,
  addDays,
  toUsDate,
  formatShortDate,
  parsePrice,
  OUTAGE_PATTERN,
  detectSiteOutage
};

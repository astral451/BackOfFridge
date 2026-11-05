// Fuzzy name matching between a scanned product's Open Food Facts name and
// the names this household typed or dictated before it had barcodes
// ("Melon medley waterloon" vs "Sparkling Water Melon Medley"). Only ever
// used to suggest a link; the user confirms (routes/products.js).
//
// Words are compared after lowercasing, dropping punctuation and filler
// words, and trimming a plural "s". Two words count as the same when
// they're equal or one starts with the other and the shorter has 4+
// letters, so a misheard "waterloon" still meets "water". The score is
// shared words / all distinct words (Jaccard), 0..1.

const FILLER = new Set(['a', 'an', 'and', 'the', 'of', 'with', 'in', 'for', 'to', 'or', 'by']);
const THRESHOLD = 0.4;
const MAX_MATCHES = 3;

function words(text) {
  return [...new Set(String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 1 && !FILLER.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)))];
}

function sameWord(a, b) {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

function score(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.length || !B.length) return 0;
  const used = new Set();
  let shared = 0;
  for (const w of A) {
    const j = B.findIndex((v, k) => !used.has(k) && sameWord(w, v));
    if (j !== -1) {
      used.add(j);
      shared += 1;
    }
  }
  return shared / (A.length + B.length - shared);
}

// candidates: [{ name, ... }]. Scores each against the product name, and
// against brand + name (people often say the brand: "LaCroix melon"), and
// returns the best few at or over the threshold, best first.
function bestMatches(productName, brand, candidates) {
  const withBrand = brand ? `${brand} ${productName}` : productName;
  return candidates
    .map((c) => ({ ...c, score: Math.max(score(c.name, productName), score(c.name, withBrand)) }))
    .filter((c) => c.score >= THRESHOLD)
    .sort((x, y) => y.score - x.score)
    .slice(0, MAX_MATCHES);
}

module.exports = { words, score, bestMatches, THRESHOLD };

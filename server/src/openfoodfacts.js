// Product lookup on Open Food Facts (https://world.openfoodfacts.org): free,
// open data, no API key. Called by the server (never the browser), and only
// for barcodes this household hasn't seen before - results are cached in the
// products table (see routes/products.js).
//
// OFF_BASE_URL overrides the host, for tests.

const BASE_URL = process.env.OFF_BASE_URL || 'https://world.openfoodfacts.org';
const TIMEOUT_MS = 6000;
// OFF asks API clients to identify themselves with an app name.
const USER_AGENT = 'BackOfFridge/1.0 (self-hosted home inventory app)';
const FIELDS = 'product_name,generic_name,brands,quantity,image_front_small_url';

// Returns { name, brand, package, image_url } for a known product, or null
// if Open Food Facts doesn't have it. Throws if the lookup itself failed
// (network down, timeout, server error), so the caller can tell "not in the
// database" apart from "couldn't ask".
async function lookup(barcode) {
  const url = `${BASE_URL}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${FIELDS}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // An unknown product is a 404 with { status: 0 } in the body.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Open Food Facts returned HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== 1 || !body.product) return null;

  const p = body.product;
  const name = (p.product_name || p.generic_name || '').trim();
  if (!name) return null;
  return {
    name,
    brand: (p.brands || '').split(',')[0].trim(),
    package: (p.quantity || '').trim(),
    image_url: p.image_front_small_url || '',
  };
}

// Open Food Facts' free-text package size ("quantity") -> what the form's
// Qty and Unit fields hold. The app's convention (as in quick add: "two, 24
// ounces") is Qty = how many, Unit = the size of each:
//   "330 ml" -> { count: null, size: '330 ml' }
//   "12 x 12 fl oz" -> { count: 12, size: '12 fl oz' }
//   "18 oz (510 g)" -> '18 oz'; "400 g e" -> '400 g' (the EU estimated sign)
//   "12 cans" -> { count: 12, size: 'cans' }
// Anything without a number gives an empty size. count is null unless the
// text names one.
const COUNT_WORDS = /^(\d+)\s*(pack|pk|count|ct|cans?|bottles?|bars?|pieces?|pcs|pouches?|cups?|packets?|rolls?|eggs?)$/;

function parsePackage(text) {
  let t = String(text || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // "(510 g)": the same size in other units
    .replace(/℮/g, ' ')
    .replace(/(\d),(\d)/g, '$1.$2') // "1,5 l"
    .split(/\s*[,/;]\s*/)[0] // "1.5 l / 50.7 fl oz": first one only
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+e$/, '')
    .replace(/\.$/, '')
    .trim();

  let count = null;
  const multi = t.match(/^(\d+)\s*[x×*]\s*(.+)$/);
  if (multi) {
    count = Number(multi[1]);
    t = multi[2].trim();
  }
  const counted = !multi && t.match(COUNT_WORDS);
  if (counted) {
    const word = counted[2];
    return { count: Number(counted[1]), size: /^(pack|pk|count|ct)$/.test(word) ? '' : word };
  }
  if (!/\d/.test(t) || t.length > 30) return { count, size: '' };
  return { count, size: t.replace(/(\d)(?=[a-z])/, '$1 ') }; // "330ml" -> "330 ml"
}

module.exports = { lookup, parsePackage };

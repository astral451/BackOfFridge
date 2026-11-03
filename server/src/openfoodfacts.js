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

module.exports = { lookup };

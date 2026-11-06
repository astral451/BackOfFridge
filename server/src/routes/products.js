// Barcode scanning and product lookup (features.md, "Barcode/visual
// scanning").
//
//   POST /api/scan               body: a photo (raw image bytes, any image
//                                Content-Type) -> reads the barcode in it
//   GET  /api/products/:barcode  a typed or wedge-scanner barcode
//   POST /api/products/:barcode/link  { name }: "yes, this is my <name>"
//
// All three answer with the same shape:
//   { barcode, expiration_date, codes: [{ text, format }], product, lookup_error, matches }
// - barcode: the normalised product number (13-digit EAN form, or 8), or
//   null when the code isn't a product number (e.g. a website QR code).
// - expiration_date: only from 2D GS1 codes that carry one, else null.
// - product: what to pre-fill, or null when nothing is known yet. Its
//   `source` says where it came from: 'local' (bought here before - carries
//   this household's own name, location, tag, unit, quantity and tracking
//   mode) or 'openfoodfacts' (name, brand, package and image only).
// - lookup_error: set when Open Food Facts couldn't be reached; the
//   barcode is still returned so the user can type the name.
//
// - matches: when the product came from Open Food Facts (this household
//   hasn't linked the barcode to anything yet), names it entered earlier
//   without a barcode that look like the same thing:
//   [{ name, count, last_bought }], best first, at most 3. Empty otherwise.
//   The page asks "same as your ...?"; yes calls /link.
// - linked (only from /link): how many earlier items got the barcode.
//
// Lookup order: this household's products table, then Open Food Facts
// (cached into products on success).
//
// Once linked, the barcode is the product's identity in this household:
// every item with it is the same product, whatever it was called. Items
// without one (never scanned, or nothing to scan) are identified by name.

const express = require('express');
const store = require('../store');
const barcode = require('../barcode');
const openfoodfacts = require('../openfoodfacts');
const namematch = require('../namematch');
const { requirePermission } = require('../permissions');
const { log } = require('../logger');

const router = express.Router();

// Phone photos are a few MB; 25MB leaves room for a full-resolution shot.
const MAX_UPLOAD = '25mb';

// For a product only Open Food Facts knows, unit and purchase_quantity are
// read from its package text, so the form's Qty and Unit fill in too. (The
// household's own products carry the ones it chose.)
function productView(row) {
  if (!row) return null;
  if (row.source === 'openfoodfacts') {
    const { count, size } = openfoodfacts.parsePackage(row.package);
    row = { ...row, unit: size || null, purchase_quantity: count };
  }
  return {
    source: row.source,
    name: row.name,
    brand: row.brand,
    package: row.package,
    image_url: row.image_url,
    category: row.category,
    location: row.location,
    tag: row.tag,
    unit: row.unit,
    purchase_quantity: row.purchase_quantity,
    tracking_mode: row.tracking_mode,
  };
}

// Earlier barcode-less names that look like this Open Food Facts product.
function suggestMatches(householdId, product) {
  if (!product || product.source !== 'openfoodfacts') return [];
  return namematch.bestMatches(product.name, product.brand, store.unlinkedNames(householdId))
    .map(({ name, count, last_bought }) => ({ name, count, last_bought }));
}

async function lookupProduct(householdId, code) {
  const known = store.getProduct(householdId, code);
  if (known) return { product: productView(known), lookup_error: null };
  try {
    const found = await openfoodfacts.lookup(code);
    if (!found) return { product: null, lookup_error: null };
    return { product: productView(store.cacheProductLookup(householdId, code, found)), lookup_error: null };
  } catch (err) {
    log(`OPEN FOOD FACTS LOOKUP FAILED for ${code}: ${err.message}`);
    return { product: null, lookup_error: 'Open Food Facts could not be reached' };
  }
}

async function findProduct(householdId, code) {
  const result = await lookupProduct(householdId, code);
  return { ...result, matches: suggestMatches(householdId, result.product) };
}

router.post(
  '/scan',
  requirePermission('items:write'),
  express.raw({ type: () => true, limit: MAX_UPLOAD }),
  async (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json({ error: 'send a photo as the request body' });
    }
    if (barcode.isHeic(buf)) {
      return res.status(415).json({ error: 'This photo is in HEIC format, which can\'t be read. Take the photo from the Scan button, or set the camera to "Most Compatible".' });
    }

    let codes;
    try {
      codes = await barcode.decodeImage(buf);
    } catch (err) {
      log(`SCAN FAILED for ${req.username}: ${err.message}`);
      return res.status(422).json({ error: 'That image couldn\'t be read.' });
    }
    if (codes.length === 0) {
      return res.status(422).json({ error: 'No barcode found. Try again closer, with the barcode flat and well lit, or type the number.' });
    }

    // Prefer the first code that's a product number.
    const read = codes.map((c) => barcode.interpret(c.text, c.format));
    const i = Math.max(0, read.findIndex((r) => r.barcode));
    const { barcode: code, expiration_date } = read[i];
    const lookup = code ? await findProduct(req.householdId, code) : { product: null, lookup_error: null, matches: [] };
    log(`SCANNED ${codes.map((c) => `${c.format} ${c.text}`).join(', ')} by ${req.username}${lookup.product ? ` -> "${lookup.product.name}" (${lookup.product.source})` : ''}`);
    res.json({ barcode: code, expiration_date, codes, ...lookup });
  }
);

router.get('/products/:barcode', requirePermission('items:write'), async (req, res) => {
  const { barcode: code, expiration_date } = barcode.interpret(req.params.barcode);
  if (!code) {
    return res.status(400).json({ error: 'A barcode is 8, 12, 13 or 14 digits.' });
  }
  const lookup = await findProduct(req.householdId, code);
  res.json({ barcode: code, expiration_date, codes: [], ...lookup });
});

// "Yes, this is my <name>": the barcode joins the items entered under that
// name without one, and their latest choices (name, location, unit...)
// become what this barcode pre-fills, as if it had been bought with it.
router.post('/products/:barcode/link', requirePermission('items:write'), (req, res) => {
  const { barcode: code } = barcode.interpret(req.params.barcode);
  if (!code) return res.status(400).json({ error: 'A barcode is 8, 12, 13 or 14 digits.' });
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name is required' });
  const result = store.linkBarcodeToName(req.householdId, code, name, req.username);
  if (!result) return res.status(404).json({ error: `Nothing called "${name}" without a barcode.` });
  log(`LINKED barcode ${code} to "${name}" (${result.linked} item${result.linked === 1 ? '' : 's'}) by ${req.username}`);
  res.json({
    barcode: code, expiration_date: null, codes: [],
    product: productView(result.product), lookup_error: null, matches: [], linked: result.linked,
  });
});

module.exports = router;

// Barcode scanning and product lookup (features.md, "Barcode/visual
// scanning").
//
//   POST /api/scan               body: a photo (raw image bytes, any image
//                                Content-Type) -> reads the barcode in it
//   GET  /api/products/:barcode  a typed or wedge-scanner barcode
//
// Both answer with the same shape:
//   { barcode, expiration_date, codes: [{ text, format }], product, lookup_error }
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
// Lookup order: this household's products table, then Open Food Facts
// (cached into products on success).

const express = require('express');
const store = require('../store');
const barcode = require('../barcode');
const openfoodfacts = require('../openfoodfacts');
const { requirePermission } = require('../permissions');
const { log } = require('../logger');

const router = express.Router();

// Phone photos are a few MB; 25MB leaves room for a full-resolution shot.
const MAX_UPLOAD = '25mb';

function productView(row) {
  if (!row) return null;
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

async function findProduct(householdId, code) {
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
    const lookup = code ? await findProduct(req.householdId, code) : { product: null, lookup_error: null };
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

module.exports = router;

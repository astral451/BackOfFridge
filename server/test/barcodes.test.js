// Barcode scanning and product lookup: decoding real barcode images, the
// GS1 parsing, the lookup order (this household's products, then Open Food
// Facts, cached), and learning a barcode from a purchase. Open Food Facts is
// replaced by a local stub server; the items/products routes are the real
// ones behind a stub login.
// Run from server/: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bof-barcodes-'));
process.env.DB_PATH = path.join(dir, 'inventory.db');
process.env.LOG_PATH = path.join(dir, 'app.log');

// --- Stub Open Food Facts ------------------------------------------------
// Answers the way the live API did when checked on 2026-11-04 (products
// below are real responses, trimmed to the fields openfoodfacts.js asks for):
// - found: HTTP 200, { status: 1, product }
// - unknown product: HTTP 404, { status: 0, status_verbose: 'product not found' }
// - a code OFF rejects outright (e.g. all zeros): HTTP 200 (not 404),
//   { status: 0, status_verbose: 'no code or invalid code' }
// `brands` is comma-separated with the consumer brand first.
const offHits = [];
let offMode = 'normal'; // 'normal' | 'down'
const OFF_PRODUCTS = {
  5449000000996: {
    product_name: 'Coca-Cola Original', generic_name: 'Bebida refrescante aromatizada', brands: 'COCA-COLA SERVICES SA/NV', quantity: '330 ml',
    image_front_small_url: 'https://images.openfoodfacts.org/images/products/544/900/000/0996/front_en.1129.200.jpg',
  },
  '0049000028911': {
    product_name: 'Diet Coke Soft Drink', generic_name: '', brands: 'Coke', quantity: '144 fl oz',
    image_front_small_url: 'https://images.openfoodfacts.org/images/products/004/900/002/8911/front_en.24.200.jpg',
  },
  3017620422003: {
    product_name: 'Nutella', generic_name: 'Hazelnut And Cocoa Spread', brands: 'Nutella, Ferrero', quantity: '400 g e',
    image_front_small_url: 'https://images.openfoodfacts.org/images/products/301/762/042/2003/front_en.879.200.jpg',
  },
};
const off = http.createServer((req, res) => {
  const m = req.url.match(/^\/api\/v2\/product\/(\d+)\.json/);
  offHits.push(m && m[1]);
  if (offMode === 'down') { res.writeHead(503); return res.end(); }
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (!m || /^0+$/.test(m[1])) return json(200, { code: '', status: 0, status_verbose: 'no code or invalid code' });
  const product = OFF_PRODUCTS[m[1]];
  if (!product) return json(404, { code: m[1], status: 0, status_verbose: 'product not found' });
  json(200, { code: m[1], product, status: 1, status_verbose: 'product found' });
});

let server;
let base;
let db;
let barcode;
let full;

before(async () => {
  off.listen(0);
  await new Promise((resolve) => off.once('listening', resolve));
  process.env.OFF_BASE_URL = `http://127.0.0.1:${off.address().port}`;

  db = require('../src/db');
  barcode = require('../src/barcode');
  full = require('zxing-wasm/full');
  full.prepareZXingModule({
    overrides: { wasmBinary: fs.readFileSync(require.resolve('zxing-wasm/full/zxing_full.wasm')) },
    fireImmediately: true,
  });

  db.prepare("INSERT INTO households (id, name, invite_code) VALUES (1, 'Home', 'ABCDEFGH'), (2, 'Other', 'HGFEDCBA')").run();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const h = Number(req.headers['x-test-household'] || 1);
    req.user = { status: 'active', householdId: h };
    req.householdId = h;
    req.username = 'tester';
    next();
  });
  app.use('/api/items', require('../src/routes/items'));
  app.use('/api', require('../src/routes/products'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  off.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(method, url, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': isBuf ? 'image/png' : 'application/json', ...headers },
    body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function image(text, format) {
  const w = await full.writeBarcode(text, { format, scale: 3 });
  assert.ok(!w.error, w.error);
  return Buffer.from(await w.image.arrayBuffer());
}

// --- Parsing -----------------------------------------------------------

test('every way of writing a product number ends up as one key', () => {
  const key = (t, f) => barcode.interpret(t, f).barcode;
  assert.strictEqual(key('049000028911'), '0049000028911');          // UPC-A, typed or wedge
  assert.strictEqual(key('0049000028911'), '0049000028911');         // EAN-13 form
  assert.strictEqual(key('00049000028911'), '0049000028911');        // GTIN-14
  assert.strictEqual(key('0 49000 02891 1'), '0049000028911');       // spaces
  assert.strictEqual(key('01234565', 'UPCE'), '0012345000065');      // UPC-E expanded
  assert.strictEqual(key('96385074'), '96385074');                   // EAN-8 kept
  assert.strictEqual(key('https://example.com/menu', 'QRCode'), null);
  assert.strictEqual(key('12345'), null);
});

test('GS1 codes give the product number and the expiry date', () => {
  assert.deepStrictEqual(barcode.interpret('(01)00049000028911(17)270200(10)A1', 'DataMatrix'),
    { barcode: '0049000028911', expiration_date: '2027-02-28' }); // day 00 = end of month
  assert.deepStrictEqual(barcode.interpret('<GS>0105449000000996172612311012345', 'DataMatrix'),
    { barcode: '5449000000996', expiration_date: '2026-12-31' });
  assert.deepStrictEqual(barcode.interpret('https://id.gs1.org/01/05449000000996/10/ABC?17=261231', 'QRCode'),
    { barcode: '5449000000996', expiration_date: '2026-12-31' });
  assert.deepStrictEqual(barcode.interpret('https://brand.example/01/05449000000996/17/260715', 'QRCode'),
    { barcode: '5449000000996', expiration_date: '2026-07-15' });
  assert.strictEqual(barcode.gs1Date('261332'), null);
});

// --- Scanning and lookup -----------------------------------------------

test('scanning an unknown product looks it up on Open Food Facts once, then uses the cache', async () => {
  offHits.length = 0;
  const png = await image('5449000000996', 'EAN13');
  const first = await call('POST', '/api/scan', png);
  assert.strictEqual(first.status, 200, JSON.stringify(first.body));
  assert.strictEqual(first.body.barcode, '5449000000996');
  assert.deepStrictEqual(first.body.codes, [{ text: '5449000000996', format: 'EAN13' }]);
  assert.strictEqual(first.body.product.source, 'openfoodfacts');
  assert.strictEqual(first.body.product.name, 'Coca-Cola Original');
  assert.strictEqual(first.body.product.brand, 'COCA-COLA SERVICES SA/NV');
  assert.strictEqual(first.body.product.package, '330 ml');

  const again = await call('POST', '/api/scan', png);
  assert.strictEqual(again.body.product.name, 'Coca-Cola Original');
  assert.deepStrictEqual(offHits, ['5449000000996'], 'second scan is answered from the cache');
});

test('a 2D code with an expiry date fills it in', async () => {
  const res = await call('POST', '/api/scan', await image('https://id.gs1.org/01/05449000000996/10/ABC?17=261231', 'QRCode'));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.barcode, '5449000000996');
  assert.strictEqual(res.body.expiration_date, '2026-12-31');
});

test('buying with a barcode teaches it: the next lookup brings back this household\'s choices', async () => {
  const bought = await call('POST', '/api/items', {
    name: 'Coke', barcode: '5449000000996', quantity: 12, unit: 'cans', location: 'Pantry', tag: 'Drinks', category: 'nonperishable',
  });
  assert.strictEqual(bought.status, 201, JSON.stringify(bought.body));
  assert.strictEqual(bought.body.barcode, '5449000000996');

  const res = await call('GET', '/api/products/5449000000996');
  assert.deepStrictEqual(
    { ...res.body.product, image_url: undefined },
    {
      source: 'local', name: 'Coke', brand: 'COCA-COLA SERVICES SA/NV', package: '330 ml', image_url: undefined,
      category: 'nonperishable', location: 'Pantry', tag: 'Drinks', unit: 'cans', purchase_quantity: 12, tracking_mode: 'count',
    }
  );
});

test('a typed UPC-A finds the same product as the scanned EAN-13 form', async () => {
  const res = await call('GET', '/api/products/049000028911');
  assert.strictEqual(res.body.barcode, '0049000028911');
  assert.strictEqual(res.body.product.name, 'Diet Coke Soft Drink');
});

test('a product Open Food Facts doesn\'t know comes back empty, not as an error', async () => {
  const res = await call('GET', '/api/products/2900000001237');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual([res.body.barcode, res.body.product, res.body.lookup_error], ['2900000001237', null, null]);
});

test('a code Open Food Facts rejects (HTTP 200, status 0) is also just "not found"', async () => {
  const res = await call('GET', '/api/products/0000000000000');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual([res.body.barcode, res.body.product, res.body.lookup_error], ['0000000000000', null, null]);
});

test('with several brands listed, the first (the consumer brand) is used', async () => {
  const res = await call('GET', '/api/products/3017620422003');
  assert.deepStrictEqual([res.body.product.name, res.body.product.brand, res.body.product.package], ['Nutella', 'Nutella', '400 g e']);
});

test('if Open Food Facts is down the barcode still comes back, with a note', async () => {
  offMode = 'down';
  try {
    const res = await call('GET', '/api/products/4012345678901');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.barcode, '4012345678901');
    assert.strictEqual(res.body.product, null);
    assert.match(res.body.lookup_error, /could not be reached/);
  } finally {
    offMode = 'normal';
  }
});

test('adding a barcode to an existing item through Edit teaches it too', async () => {
  const item = (await call('POST', '/api/items', { name: 'Mustard', location: 'Fridge' })).body;
  assert.strictEqual(item.barcode, null);
  const edited = await call('PATCH', `/api/items/${item.id}`, { barcode: '0 12345 67890 5' });
  assert.strictEqual(edited.body.barcode, '0012345678905');
  const res = await call('GET', '/api/products/012345678905');
  assert.deepStrictEqual([res.body.product.source, res.body.product.name, res.body.product.location], ['local', 'Mustard', 'Fridge']);
  const cleared = await call('PATCH', `/api/items/${item.id}`, { barcode: '' });
  assert.strictEqual(cleared.body.barcode, null);
});

test('products are per household', async () => {
  const res = await call('GET', '/api/products/012345678905', undefined, { 'x-test-household': '2' });
  assert.strictEqual(res.body.product, null, "household 2 doesn't see household 1's Mustard");
});

test('bad input gets a clear answer', async () => {
  assert.strictEqual((await call('POST', '/api/scan', Buffer.alloc(0))).status, 400);
  // A 1x1 PNG: a valid image with no barcode in it.
  const onePixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
  const blank = await call('POST', '/api/scan', onePixel);
  assert.strictEqual(blank.status, 422);
  assert.match(blank.body.error, /No barcode found/);
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(64)]);
  assert.strictEqual((await call('POST', '/api/scan', heic)).status, 415);
  assert.strictEqual((await call('GET', '/api/products/12345')).status, 400);
  assert.strictEqual((await call('POST', '/api/items', { name: 'X', barcode: 'abc' })).status, 400);
});

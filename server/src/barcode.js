// Barcode decoding and normalisation (features.md, "Barcode/visual
// scanning"). The browser only uploads a photo; everything here runs on the
// server.
//
// Decoding uses zxing-wasm (zxing-cpp compiled to WebAssembly). Its .wasm
// file is read from node_modules rather than fetched from a CDN, so scanning
// works with no outbound network access.

const fs = require('fs');
const zxing = require('zxing-wasm/reader');

let ready = null;
function init() {
  if (!ready) {
    const wasmPath = require.resolve('zxing-wasm/reader/zxing_reader.wasm');
    ready = zxing.prepareZXingModule({
      overrides: { wasmBinary: fs.readFileSync(wasmPath) },
      fireImmediately: true,
    });
  }
  return ready;
}

// iPhones store photos as HEIC. Safari normally converts to JPEG when
// uploading through a file input, but if a HEIC file does arrive zxing can't
// read it, and a specific message beats "no barcode found".
function isHeic(buf) {
  if (buf.length < 12 || buf.toString('latin1', 4, 8) !== 'ftyp') return false;
  return /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(buf.toString('latin1', 8, 12));
}

// Returns every barcode found in an encoded image (JPEG/PNG/...), as
// [{ text, format }]. GS1 codes come back in human-readable form, e.g.
// "(01)05449000000996(17)261231".
async function decodeImage(buf) {
  await init();
  const results = await zxing.readBarcodes(buf, {
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDownscale: true,
    textMode: 'HRI',
    maxNumberOfSymbols: 4,
  });
  return results.filter((r) => r.isValid).map((r) => ({ text: r.text, format: r.format }));
}

// UPC-E (8 digits, zero-suppressed) -> UPC-A (12 digits).
function expandUpcE(code) {
  if (!/^[01]\d{7}$/.test(code)) return null;
  const ns = code[0];
  const d = code.slice(1, 7);
  const check = code[7];
  let body;
  switch (d[5]) {
    case '0': case '1': case '2': body = d.slice(0, 2) + d[5] + '0000' + d.slice(2, 5); break;
    case '3': body = d.slice(0, 3) + '00000' + d.slice(3, 5); break;
    case '4': body = d.slice(0, 4) + '00000' + d[4]; break;
    default: body = d.slice(0, 5) + '0000' + d[5];
  }
  return ns + body + check;
}

// One canonical key per product, whichever way it was read: UPC-A's 12
// digits and the GTIN-14 inside GS1 codes are both stored as the 13-digit
// EAN form ("0" + UPC-A), which is also what Open Food Facts uses. EAN-8
// stays 8 digits. Returns null for anything that isn't a product number.
function normalizeGtin(raw, format) {
  let digits = String(raw || '').replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  if (format === 'UPCE') digits = expandUpcE(digits) || digits;
  if (digits.length === 14 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 12) digits = '0' + digits;
  if (digits.length === 13 || digits.length === 8) return digits;
  return null;
}

// GS1 date (YYMMDD) -> "YYYY-MM-DD". DD of 00 means the end of the month.
function gs1Date(yymmdd) {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const year = 2000 + Number(yymmdd.slice(0, 2));
  const month = Number(yymmdd.slice(2, 4));
  let day = Number(yymmdd.slice(4, 6));
  if (month < 1 || month > 12) return null;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day === 0) day = lastDay;
  if (day > lastDay) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Fixed-length GS1 application identifiers, for element strings that
// arrive without parentheses ("01054490000009961726123110ABC").
const GS1_FIXED = { '00': 18, '01': 14, '02': 14, 11: 6, 12: 6, 13: 6, 15: 6, 16: 6, 17: 6, 20: 2 };

// Splits a GS1 element string into { ai: value }. Handles the human-readable
// form "(01)...(17)..." and the raw form with <GS> separators.
function parseGs1Elements(text) {
  const out = {};
  if (text.startsWith('(')) {
    const re = /\((\d{2,4})\)([^(]*)/g;
    let m;
    while ((m = re.exec(text))) out[m[1]] = m[2];
    return out;
  }
  let s = text.replace(/^(\]d2|\]C1|\]Q3)/, '').replace(/<GS>/g, '\x1d').replace(/^\x1d/, '');
  while (s.length >= 2) {
    const ai = s.slice(0, 2);
    if (GS1_FIXED[ai] !== undefined) {
      out[ai] = s.slice(2, 2 + GS1_FIXED[ai]);
      s = s.slice(2 + GS1_FIXED[ai]).replace(/^\x1d/, '');
    } else {
      const end = s.indexOf('\x1d');
      out[ai] = end === -1 ? s.slice(2) : s.slice(2, end);
      if (end === -1) break;
      s = s.slice(end + 1);
    }
  }
  return out;
}

// GS1 Digital Link: a URL with the GTIN in the path ("/01/<gtin>") and
// optionally the expiry date as a path segment or query parameter ("17").
function parseDigitalLink(text) {
  let url;
  try { url = new URL(text); } catch { return null; }
  const m = url.pathname.match(/\/(?:01|gtin)\/(\d{8,14})/);
  if (!m) return null;
  const pathExpiry = url.pathname.match(/\/17\/(\d{6})/);
  return { gtin: m[1], expiry: url.searchParams.get('17') || (pathExpiry && pathExpiry[1]) };
}

// Turns one decoded barcode (or a typed number) into what the app needs:
// { barcode, expiration_date }. barcode is null when the code isn't a
// product number (a QR code pointing at a website, say).
function interpret(text, format) {
  const t = String(text || '').trim();
  const link = parseDigitalLink(t);
  if (link) return { barcode: normalizeGtin(link.gtin), expiration_date: link.expiry ? gs1Date(link.expiry) : null };

  const looksGs1 = t.startsWith('(01)') || /^(\]d2|\]C1|\]Q3)/.test(t) || t.startsWith('<GS>') || t.startsWith('\x1d')
    || (['DataMatrix', 'DataBar', 'DataBarExpanded', 'DataBarLimited', 'Code128'].includes(format) && /^01\d{14}/.test(t));
  if (looksGs1) {
    const el = parseGs1Elements(t);
    return { barcode: normalizeGtin(el['01']), expiration_date: el['17'] ? gs1Date(el['17']) : null };
  }

  return { barcode: normalizeGtin(t, format), expiration_date: null };
}

module.exports = { decodeImage, isHeic, interpret, normalizeGtin, expandUpcE, gs1Date, parseGs1Elements };

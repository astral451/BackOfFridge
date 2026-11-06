// Migration 005: barcodes (features.md, "Barcode/visual scanning").
//
// - items.barcode: the product number an item was bought under (13-digit
//   EAN form, or 8 for EAN-8), NULL when there isn't one.
// - products: what this household knows about a barcode, so scanning it
//   again pre-fills the purchase form. A row comes from one of two places:
//   - 'openfoodfacts': a lookup result, cached so the same barcode isn't
//     looked up twice. Name/brand/package/image only.
//   - 'local': saved when an item is bought with that barcode, so it also
//     carries this household's own choices (name as they typed it,
//     location, tag, unit, how many they usually buy, tracking mode).
//   Per household, like all other household data, so one household's names
//   and locations never show up for another.

module.exports = function barcodes(db) {
  db.exec(`
    ALTER TABLE items ADD COLUMN barcode TEXT;
    CREATE INDEX idx_items_barcode ON items(household_id, barcode);

    CREATE TABLE products (
      household_id INTEGER NOT NULL REFERENCES households(id),
      barcode TEXT NOT NULL,
      name TEXT NOT NULL,
      brand TEXT NOT NULL DEFAULT '',
      package TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      category TEXT,
      location TEXT,
      tag TEXT,
      unit TEXT,
      purchase_quantity REAL,
      tracking_mode TEXT,
      source TEXT NOT NULL CHECK (source IN ('local', 'openfoodfacts')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (household_id, barcode)
    );
  `);
};

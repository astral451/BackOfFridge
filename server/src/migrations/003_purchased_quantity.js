// Migration 003: purchased_quantity. The amount originally bought (a
// 12-pack of Coke is 12), kept separately from `quantity`, which goes down
// as things get consumed. "Buy again" pre-fills from it, so re-buying a
// 12-pack with 3 cans left suggests 12, not 3 (features.md, "Quantity
// model", step 1).
//
// Set once when an item is created and left alone by consume, throw-out,
// undo, the +/- stepper and recounts.
//
// Backfill for existing items: the quantity from the item's earliest
// 'purchased' event where one was recorded (events were added after items,
// so older items may have none), otherwise the item's current quantity -
// the best guess available.

module.exports = function purchasedQuantity(db) {
  db.exec('ALTER TABLE items ADD COLUMN purchased_quantity REAL');

  db.exec(`
    UPDATE items SET purchased_quantity = COALESCE(
      (SELECT json_extract(e.detail, '$.quantity') FROM item_events e
        WHERE e.item_id = items.id AND e.event_type = 'purchased'
          AND json_valid(e.detail) AND json_extract(e.detail, '$.quantity') > 0
        ORDER BY e.id LIMIT 1),
      quantity
    )
  `);
};

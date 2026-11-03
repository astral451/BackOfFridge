// Migration 004: prev_fill_percent. Part of the one-level undo slot
// (alongside prev_status and prev_quantity). For a fill-level item with
// more than one unit, finishing the open unit drops the quantity by one and
// starts the next unit at 100% (features.md, "Quantity model", step 2), so
// undoing that has to put the old percentage back as well as the quantity.
// NULL means there's no fill level to restore (count items, and any undo
// slot written before this migration).

module.exports = function prevFillPercent(db) {
  db.exec('ALTER TABLE items ADD COLUMN prev_fill_percent REAL');
};

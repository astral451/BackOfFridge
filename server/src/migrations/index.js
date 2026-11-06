// Every schema migration, in order. To change the schema, add a new file
// (next number) and append it here - never edit one that has shipped, since
// databases that already ran it won't run it again.
module.exports = [
  { version: 1, name: 'baseline', up: require('./001_baseline') },
  { version: 2, name: 'households', up: require('./002_households') },
  { version: 3, name: 'purchased_quantity', up: require('./003_purchased_quantity') },
  { version: 4, name: 'prev_fill_percent', up: require('./004_prev_fill_percent') },
  { version: 5, name: 'barcodes', up: require('./005_barcodes') },
];

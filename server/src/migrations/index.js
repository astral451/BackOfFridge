// Every schema migration, in order. To change the schema, add a new file
// (next number) and append it here - never edit one that has shipped, since
// databases that already ran it won't run it again.
module.exports = [
  { version: 1, name: 'baseline', up: require('./001_baseline') },
];

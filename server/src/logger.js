const fs = require('fs');
const path = require('path');

const LOG_PATH = process.env.LOG_PATH || path.join(__dirname, '..', 'data', 'app.log');
fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFile(LOG_PATH, line + '\n', () => {});
}

module.exports = { log };

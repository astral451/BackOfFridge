const path = require('path');
const express = require('express');

const itemsRouter = require('./routes/items');
const metaRouter = require('./routes/meta');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

app.use(express.json());

if (!API_KEY) {
  console.warn('WARNING: API_KEY is not set. The API is unauthenticated. Set API_KEY in your environment before exposing this beyond localhost.');
}

app.use('/api', (req, res, next) => {
  if (!API_KEY) return next();
  if (req.get('x-api-key') === API_KEY) return next();
  res.status(401).json({ error: 'unauthorized' });
});

app.use('/api/items', itemsRouter);
app.use('/api', metaRouter);

app.use(express.static(path.join(__dirname, '..', '..', 'public')));

app.listen(PORT, () => {
  console.log(`BackOfFridge server listening on port ${PORT}`);
});

const path = require('path');
const express = require('express');

const itemsRouter = require('./routes/items');
const metaRouter = require('./routes/meta');
const authRouter = require('./routes/auth');
const auth = require('./auth');
const { log } = require('./logger');

const app = express();
const PORT = process.env.PORT || 3000;

// Needed for req.secure to reflect X-Forwarded-Proto from a TLS-terminating
// proxy in front of the app (e.g. Cloudflare Tunnel), so session cookies get
// marked Secure correctly even though the app itself only speaks plain HTTP.
app.set('trust proxy', 1);

app.use(express.json());

app.use('/api/auth', authRouter);

app.use('/api', (req, res, next) => {
  const session = auth.verifySessionToken(auth.getSessionTokenFromReq(req));
  if (!session) {
    log(`ACCESS DENIED ${req.method} ${req.originalUrl} from ${req.ip}`);
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.userId = session.userId;
  req.username = session.username;
  log(`ACCESS ${req.method} ${req.originalUrl} from ${req.ip} as ${session.username}`);
  next();
});

app.use('/api/items', itemsRouter);
app.use('/api', metaRouter);

app.use(express.static(path.join(__dirname, '..', '..', 'public')));

app.listen(PORT, () => {
  console.log(`BackOfFridge server listening on port ${PORT}`);
});

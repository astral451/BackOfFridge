const path = require('path');
const express = require('express');

const itemsRouter = require('./routes/items');
const metaRouter = require('./routes/meta');
const authRouter = require('./routes/auth');
const householdRouter = require('./routes/household');
const adminRouter = require('./routes/admin');
const auth = require('./auth');
const { isActiveMember } = require('./permissions');
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
  req.user = session;
  req.userId = session.userId;
  req.username = session.username;
  // The household always comes from the session, never from anything the
  // client sends. Only an active member has one to act in.
  req.householdId = isActiveMember(session) ? session.householdId : null;
  const who = req.householdId ? `${session.username} (household ${req.householdId})`
    : `${session.username} (${session.isAdmin ? 'admin' : session.status})`;
  log(`ACCESS ${req.method} ${req.originalUrl} from ${req.ip} as ${who}`);
  next();
});

// Household data (items, locations, tags, stats, the household itself) needs
// an active member. Pending accounts and the admin account (which has no
// household) get a 403 saying why, so the front end can send them to the
// right page.
function requireMember(req, res, next) {
  if (req.householdId) return next();
  if (req.user.status === 'pending') {
    return res.status(403).json({ error: 'your account is waiting for approval', reason: 'pending' });
  }
  if (req.user.isAdmin) {
    return res.status(403).json({ error: 'the admin account has no household data', reason: 'admin' });
  }
  return res.status(403).json({ error: 'no household', reason: 'no_household' });
}

function requireAdmin(req, res, next) {
  if (req.user.isAdmin && req.user.status === 'active') return next();
  log(`ADMIN DENIED ${req.method} ${req.originalUrl} as ${req.username}`);
  return res.status(403).json({ error: 'admin only' });
}

app.use('/api/admin', requireAdmin, adminRouter);
app.use('/api/household', requireMember, householdRouter);
app.use('/api/items', requireMember, itemsRouter);
app.use('/api', requireMember, metaRouter);

app.use(express.static(path.join(__dirname, '..', '..', 'public')));

// Started directly (node src/index.js) it listens; required (by the tests) it
// just provides the app.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`BackOfFridge server listening on port ${PORT}`);
  });
}

module.exports = app;

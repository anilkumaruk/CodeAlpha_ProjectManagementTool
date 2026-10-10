const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function signToken(user) {
  return jwt.sign({ id: user.id, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  req.user = header.startsWith('Bearer ') ? verifyToken(header.slice(7)) : null;
  if (!req.user) return res.status(401).json({ error: 'Please log in to continue' });
  next();
}

module.exports = { signToken, verifyToken, requireAuth };

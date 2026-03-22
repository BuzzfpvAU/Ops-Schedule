import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

export function requireAuth(req, res, next) {
  const token = req.cookies?.auth_token;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Look up current user state from DB (handles demotion/deactivation in real-time)
    const user = req.db.prepare(
      'SELECT id, name, email, is_admin, is_viewer, active, must_change_password FROM team_members WHERE id = ?'
    ).get(payload.memberId);

    if (!user || !user.active) {
      res.clearCookie('auth_token');
      return res.status(401).json({ error: 'Account deactivated' });
    }

    req.user = {
      memberId: user.id,
      name: user.name,
      email: user.email,
      isAdmin: user.is_admin === 1,
      isViewer: user.is_viewer === 1,
      mustChangePassword: user.must_change_password === 1,
    };
    next();
  } catch (err) {
    res.clearCookie('auth_token');
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

export function signToken(memberId, isAdmin) {
  return jwt.sign({ memberId, isAdmin }, JWT_SECRET, { expiresIn: '7d' });
}

export function setAuthCookie(res, token) {
  const isProduction = process.env.NODE_ENV === 'production';
  res.cookie('auth_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
}

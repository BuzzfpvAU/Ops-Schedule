import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { requireAuth, requireAdmin, signToken, setAuthCookie } from '../middleware/auth.js';
import { sendPasswordResetEmail, isEmailConfigured } from '../utils/email.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

const router = Router();
const BCRYPT_ROUNDS = 12;

const loginAttempts = new Map();
const resetAttempts = new Map();

function checkRateLimit(map, key, maxAttempts, windowMs) {
  const now = Date.now();
  const record = map.get(key);
  if (!record || now > record.resetAt) {
    map.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (record.count >= maxAttempts) return false;
  record.count++;
  return true;
}

router.post('/setup', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const existing = req.db.prepare('SELECT COUNT(*) as c FROM team_members WHERE email IS NOT NULL AND password_hash IS NOT NULL').get();
    if (existing.c > 0) return res.status(400).json({ error: 'Setup already completed' });

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    let member = req.db.prepare('SELECT id FROM team_members WHERE name = ? AND active = 1 AND is_equipment = 0').get(name);

    if (member) {
      req.db.prepare('UPDATE team_members SET email = ?, password_hash = ?, is_admin = 1 WHERE id = ?').run(email, passwordHash, member.id);
    } else {
      const id = crypto.randomUUID();
      req.db.prepare('INSERT INTO team_members (id, name, email, password_hash, is_admin) VALUES (?, ?, ?, ?, 1)').run(id, name || 'Admin', email, passwordHash);
      member = { id };
    }

    const token = signToken(member.id, true);
    setAuthCookie(res, token);
    res.json({ success: true, user: { memberId: member.id, isAdmin: true } });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) return res.status(400).json({ error: 'Email already in use' });
    res.status(500).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (!checkRateLimit(loginAttempts, req.ip, 5, 15 * 60 * 1000)) return res.status(429).json({ error: 'Too many login attempts. Try again later.' });

  const user = req.db.prepare('SELECT id, name, email, password_hash, is_admin, active, must_change_password FROM team_members WHERE email = ? COLLATE NOCASE').get(email);
  if (!user || !user.password_hash) return res.status(401).json({ error: 'Invalid email or password' });
  if (!user.active) return res.status(401).json({ error: 'Account deactivated' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

  const token = signToken(user.id, user.is_admin === 1);
  setAuthCookie(res, token);
  res.json({ success: true, user: { memberId: user.id, name: user.name, email: user.email, isAdmin: user.is_admin === 1, mustChangePassword: user.must_change_password === 1 } });
});

router.post('/logout', (req, res) => {
  res.clearCookie('auth_token', { path: '/' });
  res.json({ success: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

router.get('/status', (req, res) => {
  const hasCredentials = req.db.prepare('SELECT COUNT(*) as c FROM team_members WHERE email IS NOT NULL AND password_hash IS NOT NULL').get();
  res.json({ needsSetup: hasCredentials.c === 0, emailConfigured: isEmailConfigured() });
});

// Combined init endpoint: returns status + user in one call
router.get('/init', (req, res) => {
  const hasCredentials = req.db.prepare('SELECT COUNT(*) as c FROM team_members WHERE email IS NOT NULL AND password_hash IS NOT NULL').get();
  const needsSetup = hasCredentials.c === 0;
  const emailConfigured = isEmailConfigured();

  if (needsSetup) {
    return res.json({ needsSetup: true, emailConfigured, user: null });
  }

  // Try to get user from cookie
  const token = req.cookies?.auth_token;
  if (!token) {
    return res.json({ needsSetup: false, emailConfigured, user: null });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = req.db.prepare(
      'SELECT id, name, email, is_admin, active, must_change_password FROM team_members WHERE id = ?'
    ).get(payload.memberId);

    if (!user || !user.active) {
      res.clearCookie('auth_token');
      return res.json({ needsSetup: false, emailConfigured, user: null });
    }

    res.json({
      needsSetup: false,
      emailConfigured,
      user: {
        memberId: user.id,
        name: user.name,
        email: user.email,
        isAdmin: user.is_admin === 1,
        mustChangePassword: user.must_change_password === 1,
      }
    });
  } catch {
    res.clearCookie('auth_token');
    res.json({ needsSetup: false, emailConfigured, user: null });
  }
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const user = req.db.prepare('SELECT password_hash FROM team_members WHERE id = ?').get(req.user.memberId);
  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  req.db.prepare('UPDATE team_members SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(newHash, req.user.memberId);
  res.json({ success: true });
});

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  if (!checkRateLimit(resetAttempts, email, 3, 60 * 60 * 1000)) return res.status(429).json({ error: 'Too many reset requests. Try again later.' });

  const user = req.db.prepare('SELECT id FROM team_members WHERE email = ? COLLATE NOCASE AND active = 1').get(email);
  if (user) {
    const token = crypto.randomUUID();
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    // Use SQLite-compatible datetime format (no T separator, no Z suffix)
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
    req.db.prepare('INSERT INTO password_reset_tokens (id, team_member_id, token_hash, expires_at) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), user.id, tokenHash, expiresAt);
    try {
      await sendPasswordResetEmail(email, token);
    } catch (err) {
      console.error('Failed to send reset email:', err.message);
      return res.status(500).json({ error: 'Failed to send reset email. Please try again later.' });
    }
  }
  res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
});

router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  // Check for valid token - compare dates as strings in SQLite format
  const resetToken = req.db.prepare("SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used = 0").get(tokenHash);
  if (!resetToken) {
    console.error('Reset token not found or already used. Hash:', tokenHash.substring(0, 8) + '...');
    return res.status(400).json({ error: 'Invalid or expired reset token' });
  }
  // Check expiry manually for better logging
  const now = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  const expired = resetToken.expires_at < now;
  if (expired) {
    console.error(`Reset token expired. Expires: ${resetToken.expires_at}, Now: ${now}`);
    return res.status(400).json({ error: 'Reset token has expired. Please request a new one.' });
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  req.db.prepare('UPDATE team_members SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(passwordHash, resetToken.team_member_id);
  req.db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(resetToken.id);
  res.json({ success: true });
});

router.post('/admin-reset-password', requireAuth, requireAdmin, async (req, res) => {
  const { memberId, tempPassword } = req.body;
  if (!memberId || !tempPassword) return res.status(400).json({ error: 'Member ID and temporary password required' });
  if (tempPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const member = req.db.prepare('SELECT id FROM team_members WHERE id = ? AND active = 1').get(memberId);
  if (!member) return res.status(404).json({ error: 'Team member not found' });

  const passwordHash = await bcrypt.hash(tempPassword, BCRYPT_ROUNDS);
  req.db.prepare('UPDATE team_members SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(passwordHash, memberId);
  res.json({ success: true });
});

export default router;

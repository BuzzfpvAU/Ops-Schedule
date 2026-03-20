import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// GET notifications for a team member (unread first)
router.get('/member/:memberId', (req, res) => {
  if (!req.user.isAdmin && req.params.memberId !== req.user.memberId) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const notifications = req.db.prepare(`
    SELECT * FROM notifications
    WHERE team_member_id = ?
    ORDER BY read ASC, created_at DESC
    LIMIT 50
  `).all(req.params.memberId);
  res.json(notifications);
});

// GET unread count for a team member
router.get('/member/:memberId/unread', (req, res) => {
  if (!req.user.isAdmin && req.params.memberId !== req.user.memberId) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const result = req.db.prepare(
    'SELECT COUNT(*) as count FROM notifications WHERE team_member_id = ? AND read = 0'
  ).get(req.params.memberId);
  res.json({ count: result.count });
});

// POST create a notification (called internally when schedule changes)
router.post('/', (req, res) => {
  const { team_member_id, type, message, date, job_code } = req.body;
  if (!team_member_id || !message) {
    return res.status(400).json({ error: 'team_member_id and message required' });
  }

  const id = uuidv4();
  req.db.prepare(`
    INSERT INTO notifications (id, team_member_id, type, message, date, job_code)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, team_member_id, type || 'info', message, date || null, job_code || null);

  const notification = req.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
  res.status(201).json(notification);
});

// PUT mark notification as read
router.put('/:id/read', (req, res) => {
  req.db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// PUT mark all as read for a member
router.put('/member/:memberId/read-all', (req, res) => {
  if (!req.user.isAdmin && req.params.memberId !== req.user.memberId) {
    return res.status(403).json({ error: 'Access denied' });
  }
  req.db.prepare('UPDATE notifications SET read = 1 WHERE team_member_id = ?').run(req.params.memberId);
  res.json({ success: true });
});

export default router;

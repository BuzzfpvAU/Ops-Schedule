import { Router } from 'express';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { requireAuth, signToken, setAuthCookie } from '../middleware/auth.js';

const router = Router();
const APP_URL = process.env.APP_URL || 'http://localhost:5173';
const rpName = 'Ops Schedule';
const rpID = new URL(APP_URL).hostname;
const origin = APP_URL;

const challenges = new Map();

function storeChallenge(key, challenge) {
  challenges.set(key, { challenge, expiresAt: Date.now() + 5 * 60 * 1000 });
  for (const [k, v] of challenges) {
    if (Date.now() > v.expiresAt) challenges.delete(k);
  }
}

function getChallenge(key) {
  const record = challenges.get(key);
  challenges.delete(key);
  if (!record || Date.now() > record.expiresAt) return null;
  return record.challenge;
}

router.post('/register-options', requireAuth, async (req, res) => {
  try {
    const existingCreds = req.db.prepare('SELECT id FROM passkey_credentials WHERE team_member_id = ?').all(req.user.memberId);
    const options = await generateRegistrationOptions({
      rpName, rpID,
      userID: new TextEncoder().encode(req.user.memberId),
      userName: req.user.email,
      userDisplayName: req.user.name,
      excludeCredentials: existingCreds.map(c => ({ id: c.id })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    storeChallenge(`reg:${req.user.memberId}`, options.challenge);
    res.json(options);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/register-verify', requireAuth, async (req, res) => {
  try {
    const expectedChallenge = getChallenge(`reg:${req.user.memberId}`);
    if (!expectedChallenge) return res.status(400).json({ error: 'Challenge expired. Please try again.' });

    const verification = await verifyRegistrationResponse({ response: req.body, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID });
    if (!verification.verified || !verification.registrationInfo) return res.status(400).json({ error: 'Verification failed' });

    const { credential } = verification.registrationInfo;
    req.db.prepare('INSERT INTO passkey_credentials (id, team_member_id, public_key, counter) VALUES (?, ?, ?, ?)').run(
      credential.id, req.user.memberId, Buffer.from(credential.publicKey).toString('base64'), credential.counter
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/login-options', async (req, res) => {
  try {
    const { email } = req.body;
    let allowCredentials = [];
    if (email) {
      const user = req.db.prepare('SELECT id FROM team_members WHERE email = ? COLLATE NOCASE AND active = 1').get(email);
      if (user) {
        const creds = req.db.prepare('SELECT id FROM passkey_credentials WHERE team_member_id = ?').all(user.id);
        allowCredentials = creds.map(c => ({ id: c.id }));
      }
    }
    const options = await generateAuthenticationOptions({ rpID, allowCredentials, userVerification: 'preferred' });
    const challengeKey = email ? `auth:${email}` : `auth:${options.challenge}`;
    storeChallenge(challengeKey, options.challenge);
    res.json({ ...options, _challengeKey: challengeKey });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/login-verify', async (req, res) => {
  try {
    const { challengeKey, ...body } = req.body;
    const expectedChallenge = getChallenge(challengeKey);
    if (!expectedChallenge) return res.status(400).json({ error: 'Challenge expired. Please try again.' });

    const credRecord = req.db.prepare('SELECT pc.*, tm.id as member_id, tm.name, tm.email, tm.is_admin, tm.active FROM passkey_credentials pc JOIN team_members tm ON pc.team_member_id = tm.id WHERE pc.id = ?').get(body.id);
    if (!credRecord || !credRecord.active) return res.status(401).json({ error: 'Invalid credential or account deactivated' });

    const verification = await verifyAuthenticationResponse({
      response: body, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID,
      credential: { id: credRecord.id, publicKey: Buffer.from(credRecord.public_key, 'base64'), counter: credRecord.counter },
    });
    if (!verification.verified) return res.status(401).json({ error: 'Verification failed' });

    req.db.prepare('UPDATE passkey_credentials SET counter = ? WHERE id = ?').run(verification.authenticationInfo.newCounter, credRecord.id);
    const token = signToken(credRecord.member_id, credRecord.is_admin === 1);
    setAuthCookie(res, token);
    res.json({ success: true, user: { memberId: credRecord.member_id, name: credRecord.name, email: credRecord.email, isAdmin: credRecord.is_admin === 1 } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/list', requireAuth, (req, res) => {
  try {
    const creds = req.db.prepare('SELECT id, created_at FROM passkey_credentials WHERE team_member_id = ? ORDER BY created_at DESC').all(req.user.memberId);
    res.json(creds);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', requireAuth, (req, res) => {
  try {
    const cred = req.db.prepare('SELECT id FROM passkey_credentials WHERE id = ? AND team_member_id = ?').get(req.params.id, req.user.memberId);
    if (!cred) return res.status(404).json({ error: 'Passkey not found' });
    req.db.prepare('DELETE FROM passkey_credentials WHERE id = ? AND team_member_id = ?').run(req.params.id, req.user.memberId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;

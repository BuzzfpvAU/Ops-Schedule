import { useState, useEffect } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { passkeyRegisterOptions, passkeyRegisterVerify } from '../api.js';

const API = '/api';

async function getPasskeys() {
  const res = await fetch(`${API}/auth/passkey/list`, { credentials: 'include' });
  if (!res.ok) return [];
  return res.json();
}

async function deletePasskey(id) {
  const res = await fetch(`${API}/auth/passkey/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to delete passkey');
  }
  return res.json();
}

export default function PasskeyManager({ onClose, showToast }) {
  const [passkeys, setPasskeys] = useState([]);
  const [loading, setLoading] = useState(false);
  const [registering, setRegistering] = useState(false);

  const isHttps = window.location.protocol === 'https:' || window.location.hostname === 'localhost';

  useEffect(() => {
    loadPasskeys();
  }, []);

  async function loadPasskeys() {
    setLoading(true);
    try {
      const list = await getPasskeys();
      setPasskeys(list);
    } catch {
      // ignore - endpoint might not exist yet
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister() {
    setRegistering(true);
    try {
      const options = await passkeyRegisterOptions();
      const registration = await startRegistration({ optionsJSON: options });
      await passkeyRegisterVerify(registration);
      showToast('Passkey registered successfully!', 'success');
      loadPasskeys();
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        showToast('Passkey registration was cancelled', 'info');
      } else {
        showToast(err.message || 'Failed to register passkey', 'error');
      }
    } finally {
      setRegistering(false);
    }
  }

  async function handleDelete(id) {
    if (!confirm('Remove this passkey? You won\'t be able to sign in with it anymore.')) return;
    try {
      await deletePasskey(id);
      showToast('Passkey removed', 'success');
      setPasskeys(prev => prev.filter(p => p.id !== id));
    } catch (err) {
      showToast(err.message || 'Failed to remove passkey', 'error');
    }
  }

  if (!isHttps) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" onClick={e => e.stopPropagation()}>
          <h2>Passkeys</h2>
          <p style={{ color: 'var(--text-secondary)', margin: '16px 0' }}>
            Passkeys require a secure (HTTPS) connection. Please access this site via HTTPS to manage passkeys.
          </p>
          <div className="modal-actions">
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>Passkeys</h2>
        <p style={{ color: 'var(--text-secondary)', margin: '4px 0 16px' }}>
          Sign in faster with fingerprint, face, or security key — no password needed.
        </p>

        {loading ? (
          <p style={{ color: 'var(--text-secondary)' }}>Loading...</p>
        ) : passkeys.length > 0 ? (
          <div style={{ marginBottom: 16 }}>
            {passkeys.map(pk => (
              <div key={pk.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 12px', background: 'var(--bg-secondary, #f5f5f5)',
                borderRadius: 8, marginBottom: 8,
              }}>
                <div>
                  <div style={{ fontWeight: 500, fontSize: 14 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ verticalAlign: 'middle', marginRight: 6 }}>
                      <path d="M12 2C9.24 2 7 4.24 7 7s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zm0 2c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3z" fill="currentColor"/>
                      <path d="M15.5 14h-7C6.01 14 4 16.01 4 18.5V20h2v-1.5c0-1.38 1.12-2.5 2.5-2.5h7c.47 0 .91.13 1.29.36l1.45-1.45A4.47 4.47 0 0015.5 14z" fill="currentColor"/>
                      <path d="M20 16l-2 2-1-1-1.41 1.41L18 20.83 21.41 17.41 20 16z" fill="currentColor"/>
                    </svg>
                    Passkey
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                    Added {new Date(pk.created_at).toLocaleDateString()}
                  </div>
                </div>
                <button
                  className="btn"
                  style={{ padding: '4px 10px', fontSize: 12, color: '#ef4444' }}
                  onClick={() => handleDelete(pk.id)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ color: 'var(--text-secondary)', margin: '0 0 16px', fontSize: 14 }}>
            No passkeys registered yet.
          </p>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Close</button>
          <button
            className="btn btn-primary"
            onClick={handleRegister}
            disabled={registering}
          >
            {registering ? 'Registering...' : '+ Add Passkey'}
          </button>
        </div>
      </div>
    </div>
  );
}

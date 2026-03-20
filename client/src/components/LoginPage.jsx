import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { startAuthentication } from '@simplewebauthn/browser';
import { passkeyLoginOptions, passkeyLoginVerify } from '../api.js';

export default function LoginPage({ onForgotPassword }) {
  const { login, emailConfigured } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handlePasskey = async () => {
    setError('');
    setLoading(true);
    try {
      const options = await passkeyLoginOptions(email || undefined);
      const assertion = await startAuthentication({ optionsJSON: options });
      const result = await passkeyLoginVerify({ ...assertion, challengeKey: options._challengeKey });
      if (result.user) {
        window.location.reload();
      }
    } catch (err) {
      setError(err.message || 'Passkey authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const isHttps = window.location.protocol === 'https:' || window.location.hostname === 'localhost';

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <h1>OPS SCHEDULE</h1>
          <p>Team Operations Planner</p>
        </div>
        <form onSubmit={handleSubmit}>
          {error && <div className="login-error">{error}</div>}
          <div className="login-field">
            <label>EMAIL</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
              autoFocus
            />
          </div>
          <div className="login-field">
            <label>PASSWORD</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>
          <button type="submit" className="login-btn primary" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
        {isHttps && (
          <>
            <div className="login-divider"><span>or</span></div>
            <button className="login-btn secondary" onClick={handlePasskey} disabled={loading}>
              Sign in with Passkey
            </button>
          </>
        )}
        {emailConfigured && (
          <div className="login-footer">
            <button className="login-link" onClick={onForgotPassword}>Forgot password?</button>
          </div>
        )}
      </div>
    </div>
  );
}

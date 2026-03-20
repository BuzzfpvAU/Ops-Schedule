import { useState } from 'react';
import { authForgotPassword } from '../api.js';

export default function ForgotPassword({ onBack }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await authForgotPassword(email);
      setSent(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <h1>OPS SCHEDULE</h1>
          <p>Reset Password</p>
        </div>
        {sent ? (
          <div className="login-success">
            <p>If that email is registered, a reset link has been sent. Check your inbox.</p>
            <button className="login-btn secondary" onClick={onBack}>Back to login</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            {error && <div className="login-error">{error}</div>}
            <div className="login-field">
              <label>EMAIL</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required autoFocus />
            </div>
            <button type="submit" className="login-btn primary" disabled={loading}>
              {loading ? 'Sending...' : 'Send Reset Link'}
            </button>
            <div className="login-footer">
              <button className="login-link" onClick={onBack}>Back to login</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { authSetup } from '../api.js';

export default function SetupPage() {
  const { setUser, setNeedsSetup } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setLoading(true);
    try {
      const result = await authSetup(email, password, name);
      setUser(result.user);
      setNeedsSetup(false);
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
          <p>Create Admin Account</p>
        </div>
        <form onSubmit={handleSubmit}>
          {error && <div className="login-error">{error}</div>}
          <div className="login-field">
            <label>YOUR NAME</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Admin name" required />
          </div>
          <div className="login-field">
            <label>EMAIL</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@company.com" required />
          </div>
          <div className="login-field">
            <label>PASSWORD</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min 8 characters" required />
          </div>
          <div className="login-field">
            <label>CONFIRM PASSWORD</label>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" required />
          </div>
          <button type="submit" className="login-btn primary" disabled={loading}>
            {loading ? 'Creating...' : 'Create Admin Account'}
          </button>
        </form>
      </div>
    </div>
  );
}

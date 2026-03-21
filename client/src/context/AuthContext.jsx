import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authInit, authMe, authLogin, authLogout } from '../api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [emailConfigured, setEmailConfigured] = useState(false);

  const checkAuth = useCallback(async () => {
    try {
      // Single API call instead of status + me
      const result = await authInit();
      setNeedsSetup(result.needsSetup);
      setEmailConfigured(result.emailConfigured);
      if (result.user) {
        setUser(result.user);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const login = async (email, password) => {
    const result = await authLogin(email, password);
    setUser(result.user);
    return result;
  };

  const logout = async () => {
    await authLogout();
    setUser(null);
  };

  const refreshUser = useCallback(async () => {
    try {
      const { user } = await authMe();
      setUser(user);
    } catch {
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider value={{
      user,
      loading,
      needsSetup,
      emailConfigured,
      login,
      logout,
      refreshUser,
      setUser,
      setNeedsSetup,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

import React, { useState, useEffect, useRef } from 'react';
import { getNotifications, markNotificationRead, markAllRead } from '../api.js';

export default function NotificationBell({ memberId }) {
  const [notifications, setNotifications] = useState([]);
  const [showPanel, setShowPanel] = useState(false);
  const panelRef = useRef(null);

  const unreadCount = notifications.filter(n => !n.read).length;

  const loadNotifications = async () => {
    try {
      const data = await getNotifications(memberId);
      setNotifications(data);
    } catch {
      // silently fail
    }
  };

  useEffect(() => {
    loadNotifications();
    // Poll every 30 seconds for new notifications
    const interval = setInterval(loadNotifications, 30000);
    return () => clearInterval(interval);
  }, [memberId]);

  useEffect(() => {
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        setShowPanel(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleMarkRead = async (id) => {
    await markNotificationRead(id);
    loadNotifications();
  };

  const handleMarkAllRead = async () => {
    await markAllRead(memberId);
    loadNotifications();
  };

  const formatTime = (dateStr) => {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
  };

  return (
    <div className="notification-bell" ref={panelRef}>
      <button
        className="btn-icon"
        onClick={() => {
          setShowPanel(!showPanel);
          if (!showPanel) loadNotifications();
        }}
        style={{ color: 'white', fontSize: 18 }}
      >
        🔔
        {unreadCount > 0 && (
          <span className="notification-badge">{unreadCount}</span>
        )}
      </button>

      {showPanel && (
        <div className="notification-panel">
          <div className="notification-panel-header">
            <span>Notifications</span>
            {unreadCount > 0 && (
              <button className="btn btn-sm" onClick={handleMarkAllRead}>
                Mark all read
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <div className="notification-empty">No notifications yet</div>
          ) : (
            notifications.map(n => (
              <div
                key={n.id}
                className={`notification-item ${!n.read ? 'unread' : ''}`}
                onClick={() => !n.read && handleMarkRead(n.id)}
              >
                <div className="notif-message">{n.message}</div>
                <div className="notif-time">{formatTime(n.created_at)}</div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

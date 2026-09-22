import React, { useEffect, useRef, useState } from 'react';

export function Drawer({ title, subtitle, onClose, children, footer }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={typeof title === 'string' ? title : 'Details'}>
        <header className="drawer-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="drawer-title">{title}</div>
            {subtitle && <div className="drawer-sub">{subtitle}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-foot">{footer}</footer>}
      </aside>
    </>
  );
}

export function Section({ title, children }) {
  return (
    <section className="dsec">
      <div className="dsec-title">{title}</div>
      {children}
    </section>
  );
}

export function KV({ label, children }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <dl className="kv">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </dl>
  );
}

export function Toggle({ checked, onChange, children }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      <span>{children}</span>
    </label>
  );
}

export function ButtonGroup({ value, options, onChange }) {
  return (
    <div className="tgroup" role="group">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={value === o.value ? 'is-active' : ''}
          onClick={() => onChange(o.value)}
          title={o.title}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Avatar({ name, color }) {
  const initials = String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return <span className="avatar" style={{ background: color || '#475569' }}>{initials}</span>;
}

export function Toasts({ toasts }) {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type || ''}`}>{t.message}</div>
      ))}
    </div>
  );
}

/**
 * The search field used by every view, so they look and behave alike.
 * `found` / `total` render a count only while a query is active — a count on
 * an empty box is noise, and its absence is what makes "no matches" obvious.
 */
export function SearchBox({ value, onChange, placeholder, found, total, autoFocusKey }) {
  const ref = useRef(null);

  // Focus on "/" the way most list UIs do, unless you are already typing
  // somewhere else.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
      e.preventDefault();
      ref.current?.focus();
      ref.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [autoFocusKey]);

  const active = !!value;
  const none = active && found === 0;

  return (
    <div className={`searchbox${none ? ' is-empty' : ''}`}>
      <svg className="searchbox-icon" width="13" height="13" viewBox="0 0 16 16" fill="none"
           stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5L14 14" strokeLinecap="round" />
      </svg>
      <input
        ref={ref}
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape' && value) { e.stopPropagation(); onChange(''); } }}
        aria-label={placeholder}
      />
      {active && (
        <>
          <span className="searchbox-count">
            {found === 0 ? 'none' : `${found}/${total}`}
          </span>
          <button
            type="button"
            className="searchbox-clear"
            onClick={() => { onChange(''); ref.current?.focus(); }}
            aria-label="Clear search"
            title="Clear (Esc)"
          >
            ✕
          </button>
        </>
      )}
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import { Section } from './ui.jsx';
import { getInvites, createInvite, cancelInvite } from '../api.js';
import { inviteStatusText, INVITE_TONE } from '../lib/tracker.js';

// One-time links that let someone add their tags from their phone through
// the portal on the tracker Mac. A link is shown once, works once, and
// expires after 24 hours.
export default function TrackerInvites({ showToast }) {
  const [invites, setInvites] = useState(null);
  const [label, setLabel] = useState('');
  const [link, setLink] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => getInvites().then(setInvites).catch((e) => showToast?.(e.message, 'error'));
  useEffect(() => { load(); }, []);

  const create = async () => {
    setBusy(true);
    try {
      const r = await createInvite(label.trim());
      setLink({ label: label.trim(), url: r.url });
      setLabel('');
      await load();
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link.url);
      showToast?.('Link copied — send it to them by text', 'success');
    } catch {
      showToast?.('Copy failed — select the link and copy it', 'error');
    }
  };

  return (
    <Section title="Add tags from a phone">
      <p className="settings-lead" style={{ margin: '0 0 10px' }}>
        Send someone a one-time link. They sign in to their Apple ID on their phone,
        pick which tags to share, and the tags appear above as “Not included”.
      </p>
      <div className="inv-new">
        <input
          value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60}
          placeholder="Who is it for? e.g. Sam – WA" aria-label="Invite label"
        />
        <button className="btn btn-primary" disabled={busy || !label.trim()} onClick={create}>Create link</button>
      </div>
      {link && (
        <div className="banner banner-warn inv-link">
          <div>Link for <strong>{link.label}</strong> — shown once, works once, expires in 24 hours:</div>
          <code className="inv-url">{link.url}</code>
          <button className="btn" onClick={copy}>Copy</button>
        </div>
      )}
      {invites && invites.length > 0 && (
        <div className="inv-list">
          {invites.map((inv) => (
            <div className="entry-row" key={inv.id}>
              <span className="entry-name">{inv.label}</span>
              <span className={`tag tag-${INVITE_TONE[inv.status] || 'mute'}`}>{inviteStatusText(inv)}</span>
              {inv.note && <span className="rl-sub">{inv.note}</span>}
              {inv.status === 'pending' && (
                <button className="btn" disabled={busy}
                  onClick={() => cancelInvite(inv.id).then(load).catch((e) => showToast?.(e.message, 'error'))}>
                  Cancel
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

import React, { useEffect, useMemo, useState } from 'react';
import { Section } from './ui.jsx';
import { getEquipmentLocations, getTrackingStatus } from '../api.js';

// ── Settings: Find My / AirTag tracking ─────────────────────────────────
//
// The Apple side of this cannot happen in a browser. Signing in needs 2FA at a
// real terminal and the key export needs the Mac's iCloud keychain, so a form
// here would be a lie. What the app CAN do is tell you which step you are
// stuck on — that is the part the README cannot do, and it is usually where
// the time goes.

const STEPS = [
  {
    title: 'Install the tracker dependencies',
    body: 'On the Mac that will do the polling, inside the repo:',
    cmd: 'cd tracker\npython3 -m venv .venv\n.venv/bin/pip install findmy requests',
  },
  {
    title: 'Build the key exporter',
    body: 'export_keys.sh shells out to the stek29 fork of export-findmy. It pulls the accessory keys straight from iCloud, which is what makes this work on current macOS.',
    cmd: 'git clone https://github.com/stek29/export-findmy ~/Dev/export-findmy\ncd ~/Dev/export-findmy && cargo build --release',
  },
  {
    title: 'Sign in to the Apple ID',
    body: 'Run this in a real terminal — it prompts for the password and a 2FA code. One directory per Apple ID; the name you pick is the <acct> used from here on. A hardware key as the only 2FA method will not work.',
    cmd: '.venv/bin/python findmy_login.py droneops',
  },
  {
    title: 'Export the accessory keys',
    body: 'Asks for the Apple ID password, a 2FA method, then an escrow password — choose "Generate a random password". Needs the Apple ID to have iCloud Keychain escrow, which any iPhone with a passcode provides.',
    cmd: './export_keys.sh droneops you@example.com',
  },
  {
    title: 'Point the tracker at this server',
    body: 'Copy the template and set both values. TRACKER_INGEST_KEY must match the one set on the server — the status above says whether the server has one at all.',
    cmd: 'cp .env.example .env\n# API_URL=https://taskz.id\n# TRACKER_INGEST_KEY=<the server’s key>',
  },
  {
    title: 'Run it once by hand',
    body: 'Check it reports positions before automating. Anything it could not match to a piece of equipment is listed in the output.',
    cmd: '.venv/bin/python sync_airtags.py',
  },
  {
    title: 'Poll every 20 minutes',
    body: 'Edit the paths and the key inside the plist first, then load it.',
    cmd: 'mkdir -p logs\ncp com.buzzbot.airtag-tracker.plist ~/Library/LaunchAgents/\nlaunchctl load ~/Library/LaunchAgents/com.buzzbot.airtag-tracker.plist',
  },
  {
    title: 'Name each tag in this app',
    body: 'Equipment tab → click an item → AirTag name. It must match the tag’s name in Find My exactly, and names must be unique across all Apple IDs, because matching is by name alone. Unmatched items show up in the list above.',
    cmd: null,
  },
];

function Copy({ text }) {
  const [done, setDone] = useState(false);
  if (!text) return null;
  return (
    <button
      className="btn copy-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className={`stat${tone ? ` is-${tone}` : ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function ago(iso) {
  if (!iso) return null;
  const then = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(then.getTime())) return iso;
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 90) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

export default function Settings({ onClose, showToast }) {
  const [status, setStatus] = useState(null);
  const [locations, setLocations] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [st, locs] = await Promise.all([getTrackingStatus(), getEquipmentLocations()]);
      setStatus(st);
      setLocations(locs);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => { load(); }, []);

  // The two failure modes worth naming: kit with no tag at all, and kit with a
  // tag name that has never produced a position — which almost always means
  // the name does not match Find My.
  const { untagged, silent, reporting } = useMemo(() => {
    const rows = locations || [];
    return {
      untagged: rows.filter((r) => !String(r.airtag_name || '').trim()),
      silent: rows.filter((r) => String(r.airtag_name || '').trim() && !r.seen_at),
      reporting: rows.filter((r) => r.seen_at),
    };
  }, [locations]);

  const keyOk = status?.ingest_key_configured;

  return (
    <div className="settings">
      <div className="toolbar" style={{ borderTop: '1px solid var(--line-soft)' }}>
        <button className="btn" onClick={onClose}>‹ Back</button>
        <strong style={{ fontSize: 13 }}>Settings</strong>
        <div className="toolbar-spacer" />
        <button className="btn" onClick={load}>Refresh</button>
      </div>

      <div className="settings-body">
        <h2 className="settings-title">Equipment tracking — Find My / AirTags</h2>
        <p className="settings-lead">
          A Mac polls Apple&rsquo;s Find My network every 20 minutes and pushes
          positions here. Tags only report when an Apple device passes near them,
          so remote sites show a last-seen time rather than a live position.
        </p>

        {error && <div className="banner banner-danger">{error}</div>}

        {status && (
          <>
            <div className="stat-row">
              <Stat
                label="Server ingest key"
                value={keyOk ? 'Set' : 'Missing'}
                tone={keyOk ? 'ok' : 'danger'}
              />
              <Stat
                label="Equipment with a tag name"
                value={`${status.equipment_with_tag} / ${status.equipment_total}`}
                tone={status.equipment_with_tag === 0 ? 'warn' : undefined}
              />
              <Stat
                label="Items ever reported"
                value={status.reporting_items}
                tone={status.reporting_items === 0 ? 'warn' : 'ok'}
              />
              <Stat
                label="Last position"
                value={ago(status.last_seen_at) || 'never'}
                tone={status.last_seen_at ? undefined : 'warn'}
              />
            </div>

            {!keyOk && (
              <div className="banner banner-danger">
                <strong>The server has no TRACKER_INGEST_KEY set.</strong> Every push
                from the tracker will be rejected with a 401 until it does. Set it in
                the server environment and restart, then use the same value in
                <code> tracker/.env</code>.
              </div>
            )}

            {keyOk && status.pings_total === 0 && (
              <div className="banner banner-warn">
                The key is set but nothing has ever been received, so the Mac side
                has not run successfully yet. Work through the steps below.
              </div>
            )}
          </>
        )}

        {locations && (
          <Section title="What is mapped">
            {silent.length > 0 && (
              <div className="banner banner-warn">
                <strong>
                  {silent.length === 1
                    ? '1 item has a tag name but has never reported.'
                    : `${silent.length} items have a tag name but have never reported.`}
                </strong>{' '}
                Usually the name here does not match the tag&rsquo;s name in Find My exactly.
                <div style={{ marginTop: 6 }}>
                  {silent.map((r) => (
                    <div key={r.id} className="mono-line">{r.name} → “{r.airtag_name}”</div>
                  ))}
                </div>
              </div>
            )}

            {reporting.length > 0 && (
              <div className="track-list">
                {reporting.map((r) => (
                  <div className="entry-row" key={r.id}>
                    <span className="opt-dot" style={{ background: 'var(--ok)' }} />
                    <span className="entry-name">{r.name}</span>
                    <span className="rl-sub">{r.airtag_name}</span>
                    <span className="rl-sub">{ago(r.seen_at)}</span>
                  </div>
                ))}
              </div>
            )}

            {untagged.length > 0 && (
              <details className="untagged">
                <summary>{untagged.length} item{untagged.length === 1 ? '' : 's'} with no tag name</summary>
                <div style={{ marginTop: 8 }}>
                  {untagged.map((r) => (
                    <div key={r.id} className="mono-line">{r.name}</div>
                  ))}
                </div>
              </details>
            )}
          </Section>
        )}

        <Section title="Adding an Apple ID">
          <div className="banner banner-warn">
            These steps run on the Mac, not here. Signing in to Apple needs a 2FA
            prompt at a real terminal and the key export needs that Mac&rsquo;s
            iCloud keychain, so none of it can be done from a browser.
          </div>

          <ol className="steps">
            {STEPS.map((s, i) => (
              <li className="step" key={s.title}>
                <div className="step-head">
                  <span className="step-num">{i + 1}</span>
                  <span className="step-title">{s.title}</span>
                  <Copy text={s.cmd} />
                </div>
                <p className="step-body">{s.body}</p>
                {s.cmd && <pre className="step-cmd">{s.cmd}</pre>}
              </li>
            ))}
          </ol>
        </Section>

        <Section title="Known limits">
          <ul className="notes">
            <li>Tags report only when an Apple device passes near them — remote sites go quiet until someone walks past.</li>
            <li>Matching is by name only, and names must be unique across every Apple ID you add.</li>
            <li>Equipment marked inactive stops matching, so its tag goes quiet with no error.</li>
            <li>FindMy.py is unofficial. If a session stops working, re-run step 3 for that account.</li>
          </ul>
        </Section>
      </div>
    </div>
  );
}

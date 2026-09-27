import React, { useEffect, useState } from 'react';
import { Section } from './ui.jsx';
import { getTrackingStatus } from '../api.js';
import TrackerTags from './TrackerTags.jsx';

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
    body: 'On the Mac that will do the polling, inside the repo. FindMy 0.10.2 or newer — Apple refuses 0.10.1 sign-ins with a GSA 503.',
    cmd: 'cd tracker\npython3.11 -m venv .venv\n.venv/bin/pip install \'findmy>=0.10.2\'',
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
    body: 'Asks for the Apple ID password, a 2FA method, the passcode of one of that Apple ID\'s devices (iPhone PIN or Mac login password), then an escrow password — choose "Generate a random password". Everything on the account is exported, phones and Macs included; nothing is located until you include it in Tags above.',
    cmd: './export_keys.sh droneops you@example.com',
  },
  {
    title: 'Set the ingest key',
    body: 'The server reads TRACKER_INGEST_KEY from a SetEnv line in its .htaccess. Generate one with openssl rand -hex 32; put the same value only in the installed launchd plist, never in the repo (it is public). .env holds just API_URL.',
    cmd: 'openssl rand -hex 32\n# server .htaccess:  SetEnv TRACKER_INGEST_KEY <key>',
  },
  {
    title: 'Run it once by hand',
    body: 'Check it reports positions before automating. Anything it could not match to a piece of equipment is listed in the output.',
    cmd: '.venv/bin/python sync_airtags.py',
  },
  {
    title: 'Poll every 20 minutes',
    body: 'Copy the plist, set TRACKER_INGEST_KEY in the installed copy only, then load it.',
    cmd: 'mkdir -p ~/Library/Logs/airtag-tracker\ncp com.buzzbot.airtag-tracker.plist ~/Library/LaunchAgents/\nchmod 600 ~/Library/LaunchAgents/com.buzzbot.airtag-tracker.plist\nlaunchctl load ~/Library/LaunchAgents/com.buzzbot.airtag-tracker.plist',
  },
  {
    title: 'Include and link tags',
    body: 'Each sync lists every item under Tags above. Tick the ones to track and pick the equipment each one is. Changes apply on the next sync.',
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
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setStatus(await getTrackingStatus());
      setError('');
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => { load(); }, []);

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
                label="Tags tracked"
                value={`${status.tags_tracked} / ${status.tags_total}`}
                tone={status.tags_tracked === 0 ? 'warn' : undefined}
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
              <Stat
                label="Tracker Mac last reported"
                value={ago(status.tracker_last_report_at) || 'never'}
                tone={!status.tracker_last_report_at ? 'warn'
                  : Date.now() - Date.parse(status.tracker_last_report_at) > 3600000 ? 'danger' : 'ok'}
              />
            </div>

            {!keyOk && (
              <div className="banner banner-danger">
                <strong>The server has no TRACKER_INGEST_KEY set.</strong> Every push
                from the tracker will be rejected with a 401 until it does. Add
                <code> SetEnv TRACKER_INGEST_KEY …</code> to the server&rsquo;s .htaccess,
                then use the same value in the installed launchd plist.
              </div>
            )}

            {keyOk && status.pings_total === 0 && (status.tags_total || 0) === 0 && (
              <div className="banner banner-warn">
                The key is set but nothing has ever been received, so the Mac side
                has not run successfully yet. See Tracker Mac setup at the bottom of this page.
              </div>
            )}

            {keyOk && status.pings_total === 0 && status.tags_total > 0 && (
              <div className="banner banner-warn">
                The tracker Mac is reporting its tags, but no positions yet. Include
                and link tags below; positions arrive on the next sync once a
                tracked tag has been near an Apple device.
              </div>
            )}
          </>
        )}

        <TrackerTags showToast={showToast} />

        <details className="admin-setup">
          <summary>Tracker Mac setup (admins)</summary>
          <p className="settings-lead" style={{ margin: '8px 0 0' }}>
            Only needed by whoever looks after the tracker Mac. Full notes are in
            <code> tracker/README.md</code>.
          </p>
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
              <li>Items are matched by their permanent Find My identifier, so renaming a tag in Find My changes nothing here.</li>
              <li>Equipment marked inactive stops matching, so its tag goes quiet with no error.</li>
              <li>FindMy.py is unofficial. If a session stops working, re-run step 3 for that account.</li>
            </ul>
          </Section>
        </details>
      </div>
    </div>
  );
}

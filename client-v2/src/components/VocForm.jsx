import React, { useState } from 'react';
import { Drawer, Section } from './ui.jsx';
import { submitVoc, removeVocEquipment } from '../api.js';
import { blankResult, outcomeOf, formProblems, submission, mergeEquipment } from '../lib/voc.js';
import { today as todayIso } from '../lib/dates.js';

// ── Validation of Competency webform ────────────────────────────────
// Records one VOC for one person. Each category ticked in becomes a block:
// the equipment assessed (picked from the list built up by earlier VOCs,
// or typed in and added to it), the task checklist, and the theory and
// practical results. The date defaults to today and can be set earlier to
// record a VOC that was done before.

const OUTCOME = { competent: 'Competent', nyc: 'Not yet competent' };

function Toggle2({ value, options, onChange, label }) {
  return (
    <div className="insp-yn" role="radiogroup" aria-label={label}>
      {options.map(([v, text, tone]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          className={`insp-yn-btn${value === v ? ` on-${tone}` : ''}`}
          onClick={() => onChange(v)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

const COMPETENCY = [['competent', 'Competent', 'no'], ['nyc', 'NYC', 'yes'], ['na', 'N/A', 'na']];
const PASS_FAIL = [['pass', 'Pass', 'no'], ['fail', 'Fail', 'yes']];

export default function VocForm({ member, categories, equipment, currentUser, isAdmin, onClose, onSubmitted, onEquipmentChanged, showToast }) {
  const today = todayIso();
  const [assessedOn, setAssessedOn] = useState(today);
  const [assessorName, setAssessorName] = useState(currentUser?.name || '');
  const [results, setResults] = useState({}); // category key → result, for those ticked in
  const [lists, setLists] = useState(() => Object.fromEntries(
    categories.map((c) => [c.key, (equipment[c.key] || []).map((e) => e.name)]),
  ));
  const [typed, setTyped] = useState({});
  const [comments, setComments] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);

  const problems = formProblems(categories, { assessedOn, assessorName, results, today });
  const touched = Object.keys(results).length > 0 || comments.trim();

  const setResult = (key, patch) => setResults((all) => ({ ...all, [key]: { ...all[key], ...patch } }));
  const toggleCategory = (key, on) => setResults((all) => {
    const next = { ...all };
    if (on) next[key] = blankResult();
    else delete next[key];
    return next;
  });
  const toggleEquipment = (key, name, on) => {
    const cur = results[key].equipment;
    setResult(key, { equipment: on ? [...cur, name] : cur.filter((n) => n !== name) });
  };
  const addTyped = (key) => {
    const { list, name } = mergeEquipment(lists[key], typed[key]);
    if (!name) return;
    setLists((l) => ({ ...l, [key]: list }));
    if (!results[key].equipment.includes(name)) toggleEquipment(key, name, true);
    setTyped((t) => ({ ...t, [key]: '' }));
  };
  // Take a model off the shared pick-list (only ones saved by earlier VOCs).
  const forget = async (key, name) => {
    const saved = (equipment[key] || []).find((e) => e.name === name);
    if (!saved || !window.confirm(`Remove “${name}” from the list for next time? Certificates that name it keep it.`)) return;
    try {
      await removeVocEquipment(saved.id);
      setLists((l) => ({ ...l, [key]: l[key].filter((n) => n !== name) }));
      onEquipmentChanged?.();
    } catch (e) {
      showToast?.(e.message, 'error');
    }
  };
  const markAll = (c) => setResult(c.key, { tasks: Object.fromEntries(c.tasks.map((t) => [t.key, 'competent'])) });

  const close = () => {
    if (touched && !window.confirm('Discard this VOC?')) return;
    onClose();
  };

  const submit = async () => {
    setTried(true);
    if (problems.count) {
      showToast?.(`${problems.count} item${problems.count === 1 ? '' : 's'} still need${problems.count === 1 ? 's' : ''} attention`, 'error');
      document.querySelector('.voc-cat.is-invalid, .form-row.is-invalid')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setBusy(true);
    try {
      const saved = await submitVoc(submission({ member, categories, assessedOn, assessorName, results, comments }));
      onSubmitted?.(saved);
    } catch (e) {
      showToast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      title="New VOC"
      subtitle={`${member.name} · Validation of Competency`}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Save & issue certificate'}
          </button>
        </>
      }
    >
      <fieldset className="form-set" disabled={busy}>
        <Section title="Assessment">
          <label className={`form-row${tried && problems.general.assessedOn ? ' is-invalid' : ''}`}>
            <span className="form-label">Date of assessment *</span>
            <input type="date" value={assessedOn} max={today} onChange={(e) => setAssessedOn(e.target.value)} />
          </label>
          <label className={`form-row${tried && problems.general.assessorName ? ' is-invalid' : ''}`}>
            <span className="form-label">Assessor *</span>
            <input type="text" value={assessorName} onChange={(e) => setAssessorName(e.target.value)} />
          </label>
          <div className="voc-hint">Valid for one year from the date of assessment.</div>
        </Section>

        <Section title="Categories assessed">
          <div className="opt-list">
            {categories.map((c) => (
              <label className="opt" key={c.key} style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={!!results[c.key]} onChange={(e) => toggleCategory(c.key, e.target.checked)} />
                <span className="opt-name">{c.title}</span>
                <span className="opt-hint">{c.tasks.length} tasks</span>
              </label>
            ))}
          </div>
          {tried && problems.general.categories && <div className="insp-error" style={{ marginLeft: 0 }}>{problems.general.categories}</div>}
        </Section>

        {categories.filter((c) => results[c.key]).map((c) => {
          const r = results[c.key];
          const outcome = outcomeOf(c, r);
          const invalid = tried && problems.categories[c.key];
          return (
            <Section title={c.title} key={c.key}>
              <div className={`voc-cat${invalid ? ' is-invalid' : ''}`}>
                <div className="voc-sub">{c.equipmentLabel} assessed</div>
                <div className="voc-equip">
                  {lists[c.key].length === 0 && <span className="rl-sub">None on the list yet – add below.</span>}
                  {lists[c.key].map((name) => {
                    const on = r.equipment.includes(name);
                    const saved = (equipment[c.key] || []).some((e) => e.name === name);
                    return (
                      <span key={name} className={`voc-chip${on ? ' is-on' : ''}`}>
                        <label>
                          <input type="checkbox" checked={on} onChange={(e) => toggleEquipment(c.key, name, e.target.checked)} />
                          {name}
                        </label>
                        {isAdmin && saved && !on && (
                          <button type="button" className="voc-chip-x" aria-label={`Remove ${name} from the list`} title="Remove from the list" onClick={() => forget(c.key, name)}>✕</button>
                        )}
                      </span>
                    );
                  })}
                </div>
                <div className="np-link voc-add">
                  <input
                    className="np-select"
                    value={typed[c.key] || ''}
                    placeholder={`Add ${c.equipmentLabel.toLowerCase()}, e.g. ${c.key === 'payload' ? 'Zenmuse L2' : c.key === 'confined-space' ? 'Scout' : 'DJI M350 RTK'}`}
                    onChange={(e) => setTyped((t) => ({ ...t, [c.key]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTyped(c.key); } }}
                  />
                  <button type="button" className="btn" disabled={!String(typed[c.key] || '').trim()} onClick={() => addTyped(c.key)}>Add</button>
                </div>

                <div className="voc-sub voc-sub-row">
                  <span>Tasks</span>
                  <button type="button" className="btn-link" onClick={() => markAll(c)}>Mark all competent</button>
                </div>
                {c.tasks.map((t, i) => (
                  <React.Fragment key={t.key}>
                    {t.section && t.section !== c.tasks[i - 1]?.section && (
                      <div className="voc-section">{t.section}</div>
                    )}
                    <div className="voc-task">
                      <span className="insp-num">{i + 1}</span>
                      <span className="voc-task-label">{t.label}</span>
                      <Toggle2
                        label={t.label}
                        value={r.tasks[t.key]}
                        options={COMPETENCY}
                        onChange={(v) => setResult(c.key, { tasks: { ...r.tasks, [t.key]: v } })}
                      />
                    </div>
                  </React.Fragment>
                ))}

                <div className="voc-task">
                  <span className="insp-num" />
                  <span className="voc-task-label">
                    Theory
                    <input
                      className="voc-score"
                      type="number"
                      inputMode="decimal"
                      min="0"
                      max="100"
                      placeholder="score %"
                      value={r.theory_score}
                      onChange={(e) => setResult(c.key, { theory_score: e.target.value })}
                    />
                  </span>
                  <Toggle2 label="Theory result" value={r.theory} options={PASS_FAIL} onChange={(v) => setResult(c.key, { theory: v })} />
                </div>
                <div className="voc-task">
                  <span className="insp-num" />
                  <span className="voc-task-label">Practical</span>
                  <Toggle2 label="Practical result" value={r.practical} options={PASS_FAIL} onChange={(v) => setResult(c.key, { practical: v })} />
                </div>

                <textarea
                  className="note-input voc-notes"
                  rows={2}
                  value={r.notes}
                  onChange={(e) => setResult(c.key, { notes: e.target.value })}
                  placeholder={outcome === 'nyc' ? 'What still needs to be demonstrated (required)' : 'Assessor notes (optional)'}
                />
                <div className="voc-outcome">
                  Outcome:{' '}
                  {outcome
                    ? <span className={`tag ${outcome === 'competent' ? 'tag-ok' : 'tag-danger'}`}>{OUTCOME[outcome]}</span>
                    : <span className="rl-sub">answer every item</span>}
                </div>
                {invalid && <div className="insp-error" style={{ marginLeft: 0 }}>{problems.categories[c.key]}</div>}
              </div>
            </Section>
          );
        })}

        <Section title="Comments">
          <textarea
            className="note-input"
            rows={3}
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            placeholder="Anything else worth recording (optional)"
          />
        </Section>
      </fieldset>
    </Drawer>
  );
}

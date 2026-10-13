import { useState, useEffect, useMemo } from 'react';
import type { Node, Edge } from '@xyflow/react';
import type { Incident } from '../types';
import { pageRootStyle } from './ProjectSections';
import { IncidentRulesPanel } from './IncidentRulesPanel';
import { ArrowRight, Check, CheckCircle2, CircleDot, Copy, RadioTower } from 'lucide-react';

interface RCAViewProps {
  nodes: Node[];
  edges: Edge[];
  selectedProject: string;
  /** Rendered inside a per-project stack: the wrapper owns scroll + height. */
  embedded?: boolean;
}

export function RCAView({ nodes, edges: _edges, selectedProject, embedded = false }: RCAViewProps) {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);

  const targetId = useMemo(() => {
    return selectedProject === 'ALL' ? 'sock-shop' : selectedProject.toLowerCase();
  }, [selectedProject]);

  useEffect(() => {
    fetch(`/api/incidents?targetId=${targetId}`)
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) setIncidents(data);
      })
      .catch(() => setIncidents([]));
  }, [targetId, nodes]);

  const activeIncident = useMemo(() => {
    return incidents.find(i => i.targetId === targetId) || incidents[0] || null;
  }, [incidents, targetId]);

  const selectedCandidate = useMemo(() => {
    if (!activeIncident || !activeIncident.candidateCauses.length) return null;
    if (selectedCandidateId) {
      return activeIncident.candidateCauses.find(c => c.serviceId === selectedCandidateId) || activeIncident.candidateCauses[0];
    }
    return activeIncident.candidateCauses[0];
  }, [activeIncident, selectedCandidateId]);

  const getCleanName = (name: string) => {
    if (!name) return '';
    return name.replace(new RegExp(`^(${targetId}|sock-shop|vertikal)-`, 'i'), '');
  };

  const [copied, setCopied] = useState<string | null>(null);
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(text);
      setTimeout(() => setCopied(c => (c === text ? null : c)), 1400);
    }).catch(() => { /* clipboard blocked: the command is still selectable */ });
  };

  const sinceText = (iso: string) => {
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    return mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)} h ${mins % 60} min ago`;
  };
  const cap = (v: string | undefined) => (v ? v.charAt(0) + v.slice(1).toLowerCase() : '');
  const confTone = (c: string) => (c === 'HIGH' ? 'var(--color-text-main)' : c === 'MEDIUM' ? 'var(--color-degraded)' : 'var(--color-text-muted)');
  // Scores are z-scores on each service's own noise scale (core/algo.py), not 0..1 probabilities: show the number itself.
  const fmtScore = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
  const maxScore = activeIncident ? Math.max(...activeIncident.candidateCauses.map(c => c.score), 0.0001) : 1;
  const root = activeIncident?.candidateCauses[0];

  // The engine walks outward from the root over callers, hop by hop; show it as columns, not a fake single chain.
  const hops = useMemo(() => {
    if (!activeIncident) return [] as string[][];
    const nameOf = new Map(nodes.map(n => [n.id, String((n.data as any)?.name ?? n.id)]));
    const label = (id: string) => getCleanName(nameOf.get(id) ?? id.replace(/^[^:]+:/, ''));
    const steps = (activeIncident.propagation ?? []) as { sourceId: string; targetId: string }[];
    const path = activeIncident.explanation?.propagationPath ?? [];
    if (!steps.length) return path.length ? [[getCleanName(path[0])], ...(path.length > 1 ? [path.slice(1).map(getCleanName)] : [])] : [];
    const depth = new Map<string, number>([[steps[0].sourceId, 0]]);
    for (const st of steps) if (!depth.has(st.targetId)) depth.set(st.targetId, (depth.get(st.sourceId) ?? 0) + 1);
    const cols: string[][] = [];
    for (const [id, d] of depth) (cols[d] ??= []).push(label(id));
    return cols.filter(Boolean);
  }, [activeIncident, nodes]);

  const Command = ({ cmd }: { cmd: string }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#0c0d10', border: '1px solid var(--color-border)', borderRadius: 8, padding: '0 6px 0 12px', height: 34 }}>
      <span style={{ color: 'var(--color-text-dim)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>$</span>
      <code style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--color-text-main)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cmd}</code>
      <button className="mm-icon-btn" style={{ width: 26, height: 26 }} onClick={() => copy(cmd)} title="Copy command" aria-label="Copy command">
        {copied === cmd ? <Check size={14} color="var(--color-healthy)" /> : <Copy size={14} strokeWidth={1.75} />}
      </button>
    </div>
  );

  const card: React.CSSProperties = { padding: 20 };
  const h3: React.CSSProperties = { margin: 0, fontSize: 14, fontWeight: 600, letterSpacing: '-0.005em' };
  const sub: React.CSSProperties = { fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4, lineHeight: 1.5 };

  return (
    <div style={pageRootStyle(embedded)}>
      {activeIncident ? (
        <section className="mm-card" style={{ padding: 0, overflow: 'hidden', flexShrink: 0, borderColor: 'rgba(239,95,103,0.28)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 24, padding: '20px 24px', alignItems: 'start',
            background: 'linear-gradient(180deg, rgba(239,95,103,0.07), rgba(239,95,103,0) 70%)' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-text-muted)' }}>
                <span className="mm-dot" style={{ background: 'var(--color-critical)', animation: 'pulse-critical 2.4s infinite' }} />
                <span style={{ color: '#ffb3b7', fontWeight: 550 }}>Active incident</span>
                <span style={{ color: 'var(--color-text-dim)' }}>·</span>
                <span>started {new Date(activeIncident.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}, {sinceText(activeIncident.startedAt)}</span>
              </div>
              <h2 style={{ margin: '10px 0 0', fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.25 }}>
                {root ? <><span style={{ color: '#fff' }}>{getCleanName(root.serviceName)}</span><span style={{ color: 'var(--color-text-muted)', fontWeight: 500 }}> is the most likely root cause</span></>
                  : activeIncident.monitoringGap ? 'Telemetry stopped arriving' : 'Something is wrong, no single cause yet'}
              </h2>
              {activeIncident.explanation?.whatHappened && (
                <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--color-text-muted)', lineHeight: 1.55, maxWidth: 760 }}>{activeIncident.explanation.whatHappened}</p>
              )}
              {activeIncident.remediationGuide?.[0] && (
                <div style={{ marginTop: 16, maxWidth: 560 }}>
                  <div className="mm-eyebrow" style={{ marginBottom: 6 }}>Try first, on the host</div>
                  <Command cmd={activeIncident.remediationGuide[0]} />
                </div>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', gap: '14px 28px', alignItems: 'baseline', paddingTop: 2 }}>
              <div>
                <div className="mm-eyebrow">Confidence</div>
                <div style={{ fontSize: 20, fontWeight: 600, marginTop: 4, color: confTone(activeIncident.confidence) }}>{cap(activeIncident.confidence)}</div>
              </div>
              <div>
                <div className="mm-eyebrow">Severity</div>
                <div style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>{cap(activeIncident.severity)}</div>
              </div>
              <div>
                <div className="mm-eyebrow">Affected</div>
                <div style={{ fontSize: 20, fontWeight: 600, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{activeIncident.affectedServices?.length ?? 0}</div>
              </div>
              <div>
                <div className="mm-eyebrow">Incident</div>
                <div style={{ fontSize: 12, marginTop: 8, fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)' }} title={activeIncident.id}>{activeIncident.id.slice(0, 12)}</div>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section className="mm-card" style={{ padding: '20px 24px', display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(62,207,142,0.1)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
            <CheckCircle2 size={18} color="var(--color-healthy)" strokeWidth={1.75} />
          </div>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>All clear</h2>
            <div style={sub}>No active incident on <b style={{ color: 'var(--color-text-main)', fontWeight: 550 }}>{targetId}</b>. Every service is within its learned baseline.</div>
          </div>
        </section>
      )}

      {activeIncident && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <section className="mm-card" style={card}>
              <h3 style={h3}>Ranking</h3>
              <div style={sub}>Services ordered by how much of the trouble they explain. A service whose errors are explained by a broken dependency drops down.</div>
              <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column' }}>
                {activeIncident.candidateCauses.map((candidate, idx) => {
                  const isSelected = selectedCandidate?.serviceId === candidate.serviceId;
                  return (
                    <div
                      key={candidate.serviceId}
                      onClick={() => setSelectedCandidateId(candidate.serviceId)}
                      style={{
                        display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr) 120px 52px', gap: 12, alignItems: 'center',
                        padding: '10px 12px', margin: '0 -12px', borderRadius: 8, cursor: 'pointer',
                        background: isSelected ? 'rgba(138,180,255,0.07)' : 'transparent',
                        boxShadow: isSelected ? 'inset 2px 0 0 var(--color-accent-cyan)' : 'none',
                        transition: 'background var(--transition-fast)',
                      }}
                      onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.025)'; }}
                      onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                    >
                      <span style={{ fontSize: 12, color: 'var(--color-text-dim)', fontVariantNumeric: 'tabular-nums' }}>{idx + 1}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 550, display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{getCleanName(candidate.serviceName)}</span>
                          {idx === 0 && <span className="mm-chip" style={{ background: 'rgba(239,95,103,0.12)', color: '#ffb3b7', height: 20 }}>Likely root</span>}
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--color-text-dim)', marginTop: 2 }}>
                          {candidate.primaryAnomalyMetric ? `Strongest signal: ${candidate.primaryAnomalyMetric}` : 'No direct signal'} · {cap(candidate.confidence)} confidence
                        </div>
                      </div>
                      <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ width: `${Math.max(2, (candidate.score / maxScore) * 100)}%`, height: '100%', borderRadius: 2,
                          background: idx === 0 ? 'var(--color-critical)' : '#9aa3b0', transition: 'width var(--transition-normal)' }} />
                      </div>
                      <span style={{ textAlign: 'right', fontSize: 13, fontWeight: 550, fontVariantNumeric: 'tabular-nums' }}>{fmtScore(candidate.score)}</span>
                    </div>
                  );
                })}
              </div>
            </section>

            {selectedCandidate && (
              <section className="mm-card" style={card}>
                <h3 style={h3}>Why {getCleanName(selectedCandidate.serviceName)} scores {selectedCandidate.score.toFixed(2)}</h3>
                <div style={sub}>Every number is a z-score on the service's own noise scale. Hard evidence (paused, exited, restarted) adds a fixed bonus.</div>
                {selectedCandidate.own !== undefined && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1, marginTop: 14, background: 'var(--color-border)', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--color-border)' }}>
                    {[
                      ['Own evidence', selectedCandidate.own, 'Its own CPU, memory or silence'],
                      ['Symptoms', selectedCandidate.symptoms, 'Errors, latency, traffic; can be inherited'],
                      ['Explained away', selectedCandidate.explained, 'Accounted for by a broken service it calls'],
                    ].map(([label, v, hint]) => (
                      <div key={label as string} style={{ background: 'var(--color-bg-panel)', padding: '12px 14px' }}>
                        <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>{label as string}</div>
                        <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{Number(v ?? 0).toFixed(1)}</div>
                        <div style={{ fontSize: 11, color: 'var(--color-text-dim)', marginTop: 2, lineHeight: 1.4 }}>{hint as string}</div>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ marginTop: 14 }}>
                  {selectedCandidate.scoreBreakdown.map((b, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, padding: '9px 0', borderTop: i ? '1px solid var(--color-border)' : 'none', fontSize: 12.5 }}>
                      <span style={{ color: 'var(--color-text-muted)', lineHeight: 1.45 }}>{b.reason}</span>
                      <span style={{ fontWeight: 550, color: b.score < 0 ? 'var(--color-critical)' : 'var(--color-text-main)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                        {b.score < 0 ? '−' : '+'}{Math.abs(b.score).toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {activeIncident.monitoringGap && (
              <section className="mm-card" style={{ ...card, borderColor: 'rgba(232,163,61,0.3)', background: 'rgba(232,163,61,0.05)' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <RadioTower size={16} color="var(--color-degraded)" strokeWidth={1.75} style={{ marginTop: 2, flexShrink: 0 }} />
                  <div>
                    <h3 style={{ ...h3, color: '#f3cf94' }}>Monitoring outage, not a service fault</h3>
                    <div style={sub}>
                      Most services stopped reporting at the same moment. Independent services do not all freeze together; a broken telemetry
                      path (SSH session, collector, Docker daemon) does. No service is blamed until data comes back.
                    </div>
                  </div>
                </div>
              </section>
            )}

            {hops.length > 0 && (
              <section className="mm-card" style={card}>
                <h3 style={h3}>How it spread</h3>
                <div style={sub}>{activeIncident.explanation.why}</div>
                <div style={{ display: 'flex', alignItems: 'stretch', gap: 10, marginTop: 14, overflowX: 'auto', paddingBottom: 2 }}>
                  {hops.map((names, h) => (
                    <div key={h} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      {h > 0 && <ArrowRight size={13} color="var(--color-text-dim)" style={{ flexShrink: 0 }} />}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span style={{ fontSize: 11, color: 'var(--color-text-dim)' }}>{h === 0 ? 'Source' : h === 1 ? 'Calls it directly' : `${h} hops away`}</span>
                        {names.map(n => (
                          <span key={n} className="mm-chip" style={{ height: 26, padding: '0 10px', fontSize: 12.5, whiteSpace: 'nowrap',
                            background: h === 0 ? 'rgba(239,95,103,0.12)' : 'rgba(255,255,255,0.04)',
                            color: h === 0 ? '#ffb3b7' : 'var(--color-text-main)',
                            border: `1px solid ${h === 0 ? 'rgba(239,95,103,0.3)' : 'var(--color-border)'}` }}>
                            {h === 0 && <i className="mm-dot" style={{ background: 'var(--color-critical)' }} />}
                            {n}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {activeIncident.atRisk && activeIncident.atRisk.length > 0 && (
              <section className="mm-card" style={card}>
                <h3 style={h3}>At risk next</h3>
                <div style={sub}>Healthy services that call a broken one. A ranking of who to watch, not a calibrated probability.</div>
                <div style={{ marginTop: 12 }}>
                  {activeIncident.atRisk.slice(0, 6).map(r => (
                    <div key={r.serviceId} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 110px 40px', gap: 12, alignItems: 'center', padding: '8px 0', fontSize: 12.5 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`calls ${r.via.join(', ')}`}>
                        <span style={{ fontWeight: 550 }}>{getCleanName(r.serviceName)}</span>
                        <span style={{ color: 'var(--color-text-dim)' }}> calls {r.via.map(getCleanName).join(', ')}</span>
                      </span>
                      <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ width: `${Math.round(r.risk * 100)}%`, height: '100%', background: 'var(--color-degraded)', borderRadius: 2 }} />
                      </div>
                      <span style={{ textAlign: 'right', color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums' }}>{Math.round(r.risk * 100)}%</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {(activeIncident.remediationGuide?.length > 1 || activeIncident.explanation?.recommendedInvestigation?.length > 0) && (
              <section className="mm-card" style={card}>
                <h3 style={h3}>Next steps</h3>
                {activeIncident.remediationGuide?.length > 1 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
                    {activeIncident.remediationGuide.slice(1).map((c, i) => <Command key={i} cmd={c} />)}
                  </div>
                )}
                {activeIncident.explanation?.recommendedInvestigation?.length > 0 && (
                  <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {activeIncident.explanation.recommendedInvestigation.map((rec, i) => (
                      <li key={i} style={{ display: 'flex', gap: 10, fontSize: 12.5, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
                        <CircleDot size={13} color="var(--color-text-dim)" style={{ marginTop: 3, flexShrink: 0 }} />{rec}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            <section className="mm-card" style={card}>
              <h3 style={h3}>Evidence</h3>
              <div style={sub}>The raw observations behind the ranking, newest first.</div>
              <div style={{ marginTop: 12, position: 'relative' }}>
                {[...activeIncident.evidence].reverse().map((ev, i, arr) => (
                  <div key={ev.id} style={{ display: 'grid', gridTemplateColumns: '14px minmax(0,1fr)', gap: 12, paddingBottom: i < arr.length - 1 ? 14 : 0, position: 'relative' }}>
                    <div style={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
                      <i className="mm-dot" style={{ background: '#9aa3b0', marginTop: 5 }} />
                      {i < arr.length - 1 && <div style={{ position: 'absolute', top: 16, bottom: -4, width: 1, background: 'var(--color-border)' }} />}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12.5 }}>
                        <span style={{ fontWeight: 550 }}>{ev.metric}</span>
                        <span style={{ fontSize: 11, color: 'var(--color-text-dim)' }}>{ev.source}</span>
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-text-dim)', fontVariantNumeric: 'tabular-nums' }}>
                          {ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2, lineHeight: 1.5 }}>{ev.description}</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      )}

      {/* What actually fires an incident: visible and editable here rather than living as literals in the detector. */}
      <IncidentRulesPanel />
    </div>
  );
}

import React from 'react';

function MiningLog({
  log,
  probeLog = [],
  onClearLog,
  onClearSearchCache,
  onResetHardware,
  hwResetOnCooldown = false,
  hwResetCooldownRemainingMs = 0,
  searchCacheOnCooldown = false,
  searchCacheCooldownRemainingMs = 0,
}) {
  const getSeverityLabel = (entry) => {
    if (entry.type === 'error') return 'Error';
    if (entry.type === 'block') return 'Block';
    if (entry.type === 'warn') return 'Warning';
    return 'Info';
  };

  const extractJitterPercent = (entry) => {
    const directRatio = Number(entry && entry.jitterRatio);
    if (Number.isFinite(directRatio) && directRatio >= 0) {
      return directRatio * 100;
    }

    const msg = String(entry && entry.msg ? entry.msg : '');
    const match = msg.match(/jitter\s+([0-9]+(?:\.[0-9]+)?)%/i);
    if (!match) return null;

    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const isBenchmarkEntry = (entry) => {
    const msg = String(entry && entry.msg ? entry.msg : '').toLowerCase();
    if (msg.includes('benchmark')) return true;
    if (msg.includes('telemetry trigger')) return true;
    if (msg.includes('laptop power') || msg.includes('laptop-power:')) return true;

    return false;
  };

  const getEntryPalette = (entry) => {
    const isBenchmark = isBenchmarkEntry(entry);
    if (isBenchmark) {
      const jitterPercent = extractJitterPercent(entry);
      if (jitterPercent !== null) {
        if (jitterPercent <= 10) {
          return {
            background: '#0f2a12',
            border: '#4ade80',
            accent: '#86efac',
            text: '#e8f5e8',
          };
        }
        if (jitterPercent <= 20) {
          return {
            background: '#2f2a10',
            border: '#fde68a',
            accent: '#fef08a',
            text: '#fff8db',
          };
        }
        return {
          background: '#3b1a06',
          border: '#f97316',
          accent: '#fb923c',
          text: '#fff1e6',
        };
      }
    }

    if (entry.type === 'error') {
      return { background: '#2d1a1a', border: '#e57373', accent: '#e57373', text: '#ffe1e1' };
    }
    if (entry.type === 'block') {
      return { background: '#1a2d1a', border: '#4ade80', accent: '#4ade80', text: '#e8f5e8' };
    }
    if (entry.type === 'warn') {
      return { background: '#2d2a1a', border: '#facc15', accent: '#facc15', text: '#fff4c2' };
    }
    return { background: '#0d1a0d', border: '#1e3a1e', accent: '#4ade80', text: '#e8f5e8' };
  };

  const benchmarkLog = React.useMemo(() => (Array.isArray(log) ? log.filter(isBenchmarkEntry) : []), [log]);
  const miningLog = React.useMemo(
    () => (Array.isArray(log) ? log.filter((entry) => !isBenchmarkEntry(entry)) : []),
    [log],
  );

  const renderLogList = (entries) => {
    if (entries.length === 0) {
      return <div style={{ color: '#a0c8a0', fontSize: 14 }}>No entries yet.</div>;
    }

    return (
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {entries.map((entry, i) => {
          const palette = getEntryPalette(entry);
          const label = getSeverityLabel(entry);
          return (
            <li
              key={i}
              style={{
                marginBottom: 12,
                background: palette.background,
                border: `1px solid ${palette.border}`,
                borderRadius: 8,
                padding: '12px 14px',
              }}
            >
              <div style={{ fontSize: 12, color: palette.accent, marginBottom: 4 }}>{entry.time}</div>
              <div style={{ fontSize: 14, wordBreak: 'break-word', color: palette.text }}>
                {label && <b style={{ color: palette.accent }}>{label}: </b>}
                {entry.msg}
              </div>
            </li>
          );
        })}
      </ul>
    );
  };

  // ── Probe column helpers ────────────────────────────────────────────────────
  const TYPE_LABEL = { cpu: 'CPU', memory: 'MEM', 'gpu-pow': 'GPU-PoW' };
  const TYPE_COLOR = { cpu: '#38bdf8', memory: '#a78bfa', 'gpu-pow': '#fb923c' };

  const getProbeStatus = (entry) => {
    if (entry.timedOut) return { label: 'TIMEOUT', bg: '#2d2a1a', color: '#fbbf24', border: '#92400e' };
    const allPassed = !!entry.ok && !!entry.vdfVerified && (!entry.issues || entry.issues.length === 0);
    if (allPassed) return { label: 'PASS', bg: '#0f2a12', color: '#4ade80', border: '#166534' };
    return { label: 'FAIL', bg: '#2d1a1a', color: '#f87171', border: '#7f1d1d' };
  };

  const renderProbeEntry = (entry, i) => {
    const status = getProbeStatus(entry);
    const typeColor = TYPE_COLOR[entry.type] || '#94a3b8';
    const typeLabel = TYPE_LABEL[entry.type] || (entry.type || '?').toUpperCase();
    const isAttested = entry.role === 'attested' && status.label === 'PASS';
    const roleBg = isAttested ? '#1e1a2d' : '#0d1a0d';
    const roleBorder = isAttested ? '#4c1d95' : status.border;
    const probeId = typeof entry.id === 'string' ? entry.id : '';
    const verifierAddress = typeof entry.verifierAddress === 'string' ? entry.verifierAddress : '';
    const compactVerifier = verifierAddress ? `${verifierAddress.slice(0, 6)}...${verifierAddress.slice(-4)}` : '?';
    const peerLabel = isAttested
      ? `Attested worker ${entry.workerId ? entry.workerId.slice(0, 6) + '...' + entry.workerId.slice(-4) : '?'}`
      : entry.source === 'peer'
        ? `Verified by ${compactVerifier}`
        : 'Local';

    return (
      <li
        key={i}
        style={{
          marginBottom: 10,
          background: roleBg,
          border: `1px solid ${roleBorder}`,
          borderRadius: 8,
          padding: '10px 12px',
          fontSize: 13,
        }}
      >
        {/* Row 1: time + trust delta + load % on the right */}
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 5 }}>
          <span style={{ fontSize: 11, color: '#6b7280' }}>{entry.time}</span>
          {entry.trustDelta != null && entry.trustDelta !== 0 && (
            <span
              style={{
                color: entry.trustDelta > 0 ? '#4ade80' : '#f87171',
                fontSize: 11,
                fontWeight: 700,
                marginLeft: 6,
              }}
            >
              Trust {entry.trustDelta > 0 ? `+${entry.trustDelta}` : entry.trustDelta}
            </span>
          )}
          {(typeof entry.version === 'string' && entry.version) || typeof entry.loadPercent === 'number' ? (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              {typeof entry.version === 'string' && entry.version && (
                <span style={{ color: '#6b7280', fontSize: 11 }}>{entry.version}</span>
              )}
              <span
                style={{
                  background: status.bg,
                  color: status.color,
                  border: `1px solid ${status.border}`,
                  borderRadius: 3,
                  padding: '0 4px',
                  fontSize: 10,
                  fontWeight: 600,
                }}
              >
                {status.label}
              </span>
              {typeof entry.loadPercent === 'number' && (
                <span style={{ color: '#5b8d5b', fontSize: 11 }}>load {entry.loadPercent}%</span>
              )}
            </div>
          ) : null}
        </div>
        {/* Row 2: badges */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap',
            marginBottom: entry.issues && entry.issues.length ? 6 : 0,
          }}
        >
          {/* Type badge */}
          <span
            style={{
              background: typeColor + '22',
              color: typeColor,
              border: `1px solid ${typeColor}55`,
              borderRadius: 4,
              padding: '1px 7px',
              fontWeight: 700,
              fontSize: 11,
              letterSpacing: '0.06em',
            }}
          >
            {typeLabel}
          </span>
          {/* Role / source badge */}
          <span
            style={{
              background: isAttested ? '#2e1065' : '#0f172a',
              color: isAttested ? '#c4b5fd' : '#94a3b8',
              border: `1px solid ${isAttested ? '#5b21b6' : '#334155'}`,
              borderRadius: 4,
              padding: '1px 7px',
              fontSize: 10,
            }}
          >
            {isAttested ? 'Attested' : 'My HW'}
          </span>
          {/* Energy flushed badge */}
          {typeof entry.energyWh === 'number' && entry.energyWh > 0 && (
            <span
              style={{
                background: '#0f2a12',
                color: '#4ade80',
                border: '1px solid #166534',
                borderRadius: 4,
                padding: '1px 7px',
                fontSize: 10,
              }}
            >
              {`${entry.energyWh.toFixed(4)} Wh`}
            </span>
          )}
          {/* Timing + chain (right-aligned) */}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {typeof entry.wallClockMs === 'number' && (
              <span style={{ color: '#64748b', fontSize: 11 }}>{Math.round(entry.wallClockMs)} ms</span>
            )}
            {typeof entry.rttMs === 'number' && (
              <span style={{ color: '#475569', fontSize: 10 }}>net {Math.round(entry.rttMs)}ms</span>
            )}

            {/* Chain index */}
            {typeof entry.chainIndex === 'number' && entry.chainIndex > 0 && (
              <span style={{ color: '#475569', fontSize: 11 }}>chain #{entry.chainIndex}</span>
            )}
          </div>
          {probeId && <span style={{ color: '#64748b', fontSize: 11 }}>id {probeId}</span>}
          {entry.type === 'gpu-pow' && typeof entry.proof === 'string' && entry.proof && (
            <span style={{ color: '#64748b', fontSize: 11 }}>proof {entry.proof}</span>
          )}
          {/* Source label */}
          <span style={{ color: '#4b5563', fontSize: 10 }}>{peerLabel}</span>
        </div>
        {/* Issues */}
        {entry.issues && entry.issues.length > 0 && (
          <div style={{ marginTop: 4, fontSize: 11, color: '#fca5a5', lineHeight: 1.5, wordBreak: 'break-word' }}>
            {entry.issues.join(' · ')}
          </div>
        )}
      </li>
    );
  };

  const renderProbeList = (entries) => {
    if (!entries || entries.length === 0) {
      return (
        <div style={{ color: '#6b7280', fontSize: 13 }}>No probes yet. Probes trigger every ~30s while mining.</div>
      );
    }
    return (
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>{entries.map((e, i) => renderProbeEntry(e, i))}</ul>
    );
  };

  // Split probeLog into self (my HW) and attested sections, both sorted newest first.
  const sortedProbeLog = React.useMemo(
    () => (Array.isArray(probeLog) ? [...probeLog].sort((a, b) => (b.ts || 0) - (a.ts || 0)) : []),
    [probeLog],
  );

  const totalProbes = sortedProbeLog.length;
  const passedProbes = sortedProbeLog.filter((e) => e.ok && !e.timedOut).length;
  const failedProbes = sortedProbeLog.filter((e) => !e.ok && !e.timedOut).length;
  const timedOut = sortedProbeLog.filter((e) => e.timedOut).length;

  return (
    <div
      style={{
        maxWidth: 1600,
        margin: '40px auto',
        padding: '0 20px',
        fontFamily: "'DM Mono', monospace",
        color: '#e8f5e8',
      }}
    >
      {(onClearLog || onClearSearchCache || onResetHardware) && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 10 }}>
          {onClearLog && (
            <button
              onClick={onClearLog}
              style={{
                background: 'transparent',
                border: '1px solid #2e4a2e',
                color: '#4ade80',
                borderRadius: 6,
                padding: '4px 14px',
                fontSize: 12,
                cursor: 'pointer',
                letterSpacing: '0.06em',
                fontFamily: "'DM Mono', monospace",
              }}
            >
              Clear Log
            </button>
          )}
          {onClearSearchCache &&
            (searchCacheOnCooldown ? (
              (() => {
                const days = Math.floor(searchCacheCooldownRemainingMs / (24 * 60 * 60 * 1000));
                const hours = Math.floor((searchCacheCooldownRemainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
                const label = days > 0 ? `Clear Search Cache (${days}d ${hours}h)` : `Clear Search Cache (${hours}h)`;
                return (
                  <button
                    disabled
                    title="Search cache clear is on a 3-day cooldown"
                    style={{
                      background: 'transparent',
                      border: '1px solid #1a3a1a',
                      color: '#2a5a2a',
                      borderRadius: 6,
                      padding: '4px 14px',
                      fontSize: 12,
                      cursor: 'not-allowed',
                      letterSpacing: '0.06em',
                      fontFamily: "'DM Mono', monospace",
                      opacity: 0.5,
                    }}
                  >
                    {label}
                  </button>
                );
              })()
            ) : (
              <button
                onClick={onClearSearchCache}
                style={{
                  background: 'transparent',
                  border: '1px solid #2e4a2e',
                  color: '#4ade80',
                  borderRadius: 6,
                  padding: '4px 14px',
                  fontSize: 12,
                  cursor: 'pointer',
                  letterSpacing: '0.06em',
                  fontFamily: "'DM Mono', monospace",
                }}
              >
                Clear Search Cache
              </button>
            ))}
          {onResetHardware &&
            (hwResetOnCooldown ? (
              (() => {
                const days = Math.floor(hwResetCooldownRemainingMs / (24 * 60 * 60 * 1000));
                const hours = Math.floor((hwResetCooldownRemainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
                const label = days > 0 ? `Reset Hardware (${days}d ${hours}h)` : `Reset Hardware (${hours}h)`;
                return (
                  <button
                    disabled
                    title="Hardware reset is on a 7-day cooldown to prevent abuse"
                    style={{
                      background: 'transparent',
                      border: '1px solid #3a3010',
                      color: '#7a6a20',
                      borderRadius: 6,
                      padding: '4px 14px',
                      fontSize: 12,
                      cursor: 'not-allowed',
                      letterSpacing: '0.06em',
                      fontFamily: "'DM Mono', monospace",
                      opacity: 0.5,
                    }}
                  >
                    {label}
                  </button>
                );
              })()
            ) : (
              <button
                onClick={onResetHardware}
                style={{
                  background: 'transparent',
                  border: '1px solid #5a3a10',
                  color: '#facc15',
                  borderRadius: 6,
                  padding: '4px 14px',
                  fontSize: 12,
                  cursor: 'pointer',
                  letterSpacing: '0.06em',
                  fontFamily: "'DM Mono', monospace",
                }}
              >
                Reset Hardware
              </button>
            ))}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 16 }}>
        {/* Column 1 — Mining */}
        <section style={{ background: '#0b140b', border: '1px solid #1e3a1e', borderRadius: 10, padding: 14 }}>
          <h3 style={{ margin: '0 0 12px 0', color: '#4ade80', fontSize: 16, letterSpacing: '0.04em' }}>Mining</h3>
          {renderLogList(miningLog)}
        </section>
        {/* Column 2 — Benchmarking */}
        <section style={{ background: '#0b140b', border: '1px solid #1e3a1e', borderRadius: 10, padding: 14 }}>
          <h3 style={{ margin: '0 0 12px 0', color: '#4ade80', fontSize: 16, letterSpacing: '0.04em' }}>
            Benchmarking
          </h3>
          {renderLogList(benchmarkLog)}
        </section>
        {/* Column 3 — Probes */}
        <section style={{ background: '#0b140b', border: '1px solid #1e3a1e', borderRadius: 10, padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, color: '#4ade80', fontSize: 16, letterSpacing: '0.04em' }}>Probes</h3>
            {totalProbes > 0 && (
              <span style={{ fontSize: 11, color: '#6b7280' }}>
                {passedProbes > 0 && <span style={{ color: '#4ade80' }}>{passedProbes} pass </span>}
                {failedProbes > 0 && <span style={{ color: '#f87171' }}>{failedProbes} fail </span>}
                {timedOut > 0 && <span style={{ color: '#fbbf24' }}>{timedOut} timeout </span>}
              </span>
            )}
          </div>
          {renderProbeList(sortedProbeLog)}
        </section>
      </div>
    </div>
  );
}

export default React.memo(MiningLog);

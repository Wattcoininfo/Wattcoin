export function FadeIn({ children }) {
  return <>{children}</>;
}

export function Section({ id, children, style }) {
  return (
    <section id={id} style={{ padding: '80px 0', borderBottom: '1px solid #1a2a1a', ...style }}>
      {children}
    </section>
  );
}

export function SectionTitle({ number, title }) {
  return (
    <FadeIn>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 48 }}>
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: '#4ade80', letterSpacing: '0.12em' }}>
          {String(number).padStart(2, '0')}
        </span>
        <h2
          style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: 34,
            fontWeight: 700,
            color: '#e8f5e8',
            margin: 0,
            letterSpacing: '-0.02em',
          }}
        >
          {title}
        </h2>
      </div>
    </FadeIn>
  );
}

export function Pill({ children, color = '#4ade80' }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '3px 12px',
        borderRadius: 99,
        border: `1px solid ${color}50`,
        color,
        fontSize: 11,
        fontFamily: "'DM Mono', monospace",
        letterSpacing: '0.08em',
      }}
    >
      {children}
    </span>
  );
}

export function MetricCard({ label, value, sub }) {
  return (
    <div style={{ background: '#0a160a', border: '1px solid #1e3a1e', borderRadius: 12, padding: '20px 24px' }}>
      <div
        style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: 10,
          color: '#4ade80',
          letterSpacing: '0.12em',
          marginBottom: 8,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: 24,
          fontWeight: 700,
          color: '#e8f5e8',
          lineHeight: 1.2,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: '#3d5c3d', marginTop: 6, fontFamily: "'DM Mono', monospace" }}>{sub}</div>
      )}
    </div>
  );
}

export function InfoCard({ title, children }) {
  return (
    <div style={{ padding: '16px 20px', background: '#0a160a', borderRadius: 10, borderLeft: '2px solid #4ade80' }}>
      <div
        style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: 10,
          color: '#4ade80',
          letterSpacing: '0.08em',
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: 13, color: '#7aaa7a', lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

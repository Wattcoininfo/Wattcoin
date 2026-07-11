export default function Row({ label, value, mono, extra }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <span style={{ color: '#9ac79f', minWidth: 70, flexShrink: 0 }}>{label}:</span>
      <span
        style={{
          color: '#d7ffd9',
          fontFamily: mono ? 'monospace' : undefined,
          fontSize: mono ? 11 : 12,
          wordBreak: 'break-all',
        }}
      >
        {String(value ?? '-')}
      </span>
      {extra || null}
    </div>
  );
}

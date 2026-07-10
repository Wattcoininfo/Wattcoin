import { useState, useEffect, useCallback } from 'react';

export default function DocsView({ selectedWalletAddress, nfts }) {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [formTitle, setFormTitle] = useState('');
  const [formContent, setFormContent] = useState('');
  const [formCategory, setFormCategory] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [msg, setMsg] = useState('');
  const [msgType, setMsgType] = useState('info');

  const hasNft = nfts.length > 0;
  const isVhpn1 = nfts.some((n) => n.nftId === 'vhpn-1');

  const loadDocs = useCallback(() => {
    if (!window.wattcoinHardware?.invoke || !hasNft) return;
    window.wattcoinHardware
      .invoke('wattcoin-docs-list', selectedWalletAddress)
      .then((res) => {
        if (res && res.ok) setDocs(res.docs || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [selectedWalletAddress, hasNft]);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  const handleUpload = () => {
    const title = formTitle.trim();
    const content = formContent.trim();
    if (!title) {
      setMsgType('error');
      setMsg('Title is required');
      return;
    }
    if (!content) {
      setMsgType('error');
      setMsg('Content is required');
      return;
    }
    window.wattcoinHardware
      .invoke('wattcoin-docs-upload', selectedWalletAddress, { title, content, category: formCategory.trim() })
      .then((res) => {
        if (res && res.ok) {
          setDocs((prev) => [...prev, res.doc]);
          setFormTitle('');
          setFormContent('');
          setFormCategory('');
          setShowUpload(false);
          setMsgType('info');
          setMsg('Documentation uploaded.');
          setTimeout(() => setMsg(''), 3000);
        } else {
          setMsgType('error');
          setMsg(res.error || 'Failed');
        }
      })
      .catch((e) => {
        setMsgType('error');
        setMsg(String(e && e.message));
      });
  };

  const handleDelete = (docId) => {
    window.wattcoinHardware
      .invoke('wattcoin-docs-delete', selectedWalletAddress, docId)
      .then((res) => {
        if (res && res.ok) {
          setDocs((prev) => prev.filter((d) => d.id !== docId));
          setExpanded((prev) => (prev === docId ? null : prev));
          setMsgType('info');
          setMsg('Documentation deleted.');
          setTimeout(() => setMsg(''), 3000);
        } else {
          setMsgType('error');
          setMsg(res.error || 'Failed');
        }
      })
      .catch((e) => {
        setMsgType('error');
        setMsg(String(e && e.message));
      });
  };

  if (!hasNft) return null;

  if (loading)
    return (
      <div style={{ fontSize: 13, color: '#7aaa7a', textAlign: 'center', marginTop: 40 }}>Loading documentation...</div>
    );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#4ade80' }}>Documentation ({docs.length})</div>
        {isVhpn1 && (
          <button
            onClick={() => setShowUpload(!showUpload)}
            style={{
              background: showUpload ? '#1e3a1e' : '#4ade80',
              color: showUpload ? '#9ac79f' : '#001008',
              border: 'none',
              borderRadius: 8,
              padding: '7px 14px',
              fontWeight: 700,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {showUpload ? 'Cancel' : 'Upload'}
          </button>
        )}
      </div>

      {msg && (
        <div
          style={{
            fontSize: 12,
            color: msgType === 'error' ? '#fca5a5' : '#86efac',
            marginBottom: 10,
            padding: '6px 10px',
            background: '#0d1a0d',
            borderRadius: 6,
            border: '1px solid #1e3a1e',
          }}
        >
          {msg}
        </div>
      )}

      {showUpload && (
        <div
          style={{ background: '#0d1a0d', border: '1px solid #1e3a1e', borderRadius: 8, padding: 12, marginBottom: 14 }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, color: '#4ade80', marginBottom: 8 }}>Upload Documentation</div>
          <input
            value={formTitle}
            onChange={(e) => setFormTitle(e.target.value)}
            placeholder="Title"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              fontSize: 13,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid #224022',
              background: '#060e06',
              color: '#d7ffd9',
              marginBottom: 6,
            }}
          />
          <input
            value={formCategory}
            onChange={(e) => setFormCategory(e.target.value)}
            placeholder="Category (optional)"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              fontSize: 13,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid #224022',
              background: '#060e06',
              color: '#d7ffd9',
              marginBottom: 6,
            }}
          />
          <textarea
            value={formContent}
            onChange={(e) => setFormContent(e.target.value)}
            placeholder="Content (markdown supported)"
            rows={6}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              fontSize: 13,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid #224022',
              background: '#060e06',
              color: '#d7ffd9',
              marginBottom: 8,
              resize: 'vertical',
              fontFamily: 'inherit',
            }}
          />
          <button
            onClick={handleUpload}
            style={{
              background: '#4ade80',
              color: '#001008',
              border: 'none',
              borderRadius: 6,
              padding: '7px 14px',
              fontWeight: 700,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Upload
          </button>
        </div>
      )}

      {docs.length === 0 && (
        <div style={{ fontSize: 13, color: '#7aaa7a', textAlign: 'center', marginTop: 30 }}>
          No documentation uploaded yet.
        </div>
      )}

      {docs.map((doc) => (
        <div
          key={doc.id}
          style={{
            background: '#0d1a0d',
            border: '1px solid #1e3a1e',
            borderRadius: 8,
            marginBottom: 10,
            overflow: 'hidden',
          }}
        >
          <div
            onClick={() => setExpanded((prev) => (prev === doc.id ? null : doc.id))}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '12px 14px',
              cursor: 'pointer',
              background: expanded === doc.id ? '#122212' : 'transparent',
            }}
          >
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#d7ffd9' }}>{doc.title}</div>
              <div style={{ fontSize: 11, color: '#6b8f6b', marginTop: 2 }}>
                {doc.category && <span style={{ color: '#fbbf24' }}>{doc.category}</span>}
                {doc.category && ' · '}
                {doc.addedAt ? new Date(doc.addedAt).toLocaleDateString() : ''}
              </div>
            </div>
            <div style={{ fontSize: 11, color: '#5a8a5a' }}>{expanded === doc.id ? '▲' : '▼'}</div>
          </div>
          {expanded === doc.id && (
            <div style={{ padding: '0 14px 12px', borderTop: '1px solid #1e3a1e' }}>
              <div
                style={{
                  fontSize: 13,
                  color: '#b7f5bc',
                  lineHeight: 1.6,
                  marginTop: 10,
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'inherit',
                }}
              >
                {doc.content}
              </div>
              {isVhpn1 && (
                <button
                  onClick={() => handleDelete(doc.id)}
                  style={{
                    marginTop: 10,
                    background: 'transparent',
                    color: '#ef4444',
                    border: '1px solid #ef4444',
                    borderRadius: 5,
                    padding: '4px 10px',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

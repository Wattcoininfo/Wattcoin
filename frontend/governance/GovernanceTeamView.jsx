import { useState, useEffect, useCallback } from 'react';

const TIER_ORDER = { gold: 3, silver: 2, bronze: 1 };

export default function TeamView({ selectedWalletAddress, nfts }) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [formName, setFormName] = useState('');
  const [formRole, setFormRole] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formPicture, setFormPicture] = useState('');
  const [editId, setEditId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editPicture, setEditPicture] = useState('');
  const [msg, setMsg] = useState('');
  const [msgType, setMsgType] = useState('info');

  const hasNft = nfts.length > 0;
  const isVhpn1 = nfts.some((n) => n.nftId === 'vhpn-1');
  const usedNftIds = new Set(members.map((m) => m.nftId).filter(Boolean));
  const availableNfts = nfts.filter((n) => !usedNftIds.has(n.nftId));

  const bestAvailableNft =
    availableNfts.length > 0
      ? availableNfts.sort((a, b) => {
          const ta = TIER_ORDER[(a.metadata && a.metadata.tier) || 'bronze'] || 0;
          const tb = TIER_ORDER[(b.metadata && b.metadata.tier) || 'bronze'] || 0;
          if (ta !== tb) return tb - ta;
          const na = parseInt(a.nftId.replace(/\D/g, ''), 10) || 999;
          const nb = parseInt(b.nftId.replace(/\D/g, ''), 10) || 999;
          return na - nb;
        })[0]
      : null;

  const loadMembers = useCallback(() => {
    if (!window.wattcoinHardware?.invoke || !hasNft) return;
    window.wattcoinHardware
      .invoke('wattcoin-team-list', selectedWalletAddress)
      .then((res) => {
        if (res && res.ok) setMembers(res.members || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [selectedWalletAddress, hasNft]);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  const handlePictureFile = (setter) => (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setter(reader.result);
    reader.readAsDataURL(file);
  };

  const handleAdd = () => {
    const name = formName.trim();
    if (!name) {
      setMsgType('error');
      setMsg('Name is required');
      return;
    }
    if (!bestAvailableNft) {
      setMsgType('error');
      setMsg('No available NFT to use');
      return;
    }
    window.wattcoinHardware
      .invoke('wattcoin-team-add', selectedWalletAddress, {
        name,
        role: formRole.trim(),
        description: formDesc.trim(),
        picture: formPicture,
        nftId: bestAvailableNft.nftId,
      })
      .then((res) => {
        if (res && res.ok) {
          setMembers((prev) => [...prev, res.member]);
          setFormName('');
          setFormRole('');
          setFormDesc('');
          setFormPicture('');
          setShowAdd(false);
          setMsgType('info');
          setMsg('Added to team.');
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

  const handleEdit = (member) => {
    setEditId(member.id);
    setEditName(member.name);
    setEditRole(member.role || '');
    setEditDesc(member.description || '');
    setEditPicture(member.picture || '');
  };

  const handleSaveEdit = () => {
    const name = editName.trim();
    if (!name) {
      setMsgType('error');
      setMsg('Name is required');
      return;
    }
    window.wattcoinHardware
      .invoke('wattcoin-team-edit', selectedWalletAddress, editId, {
        name,
        role: editRole.trim(),
        description: editDesc.trim(),
        picture: editPicture,
      })
      .then((res) => {
        if (res && res.ok) {
          setMembers((prev) =>
            prev.map((m) =>
              m.id === editId
                ? {
                    ...m,
                    name: editName.trim(),
                    role: editRole.trim(),
                    description: editDesc.trim(),
                    picture: editPicture,
                  }
                : m,
            ),
          );
          setEditId(null);
          setMsgType('info');
          setMsg('Team member updated.');
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

  const handleDelete = (memberId) => {
    window.wattcoinHardware
      .invoke('wattcoin-team-delete', selectedWalletAddress, memberId)
      .then((res) => {
        if (res && res.ok) {
          setMembers((prev) => prev.filter((m) => m.id !== memberId));
          setMsgType('info');
          setMsg('Team member removed.');
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

  const canEdit = (member) => isVhpn1 || nfts.some((n) => n.nftId === member.nftId);

  if (!hasNft) return null;

  if (loading)
    return <div style={{ fontSize: 13, color: '#7aaa7a', textAlign: 'center', marginTop: 40 }}>Loading team...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#4ade80' }}>Team ({members.length})</div>
        {isVhpn1 && (
          <button
            onClick={() => setShowAdd(!showAdd)}
            style={{
              background: showAdd ? '#1e3a1e' : '#4ade80',
              color: showAdd ? '#9ac79f' : '#001008',
              border: 'none',
              borderRadius: 8,
              padding: '7px 14px',
              fontWeight: 700,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {showAdd ? 'Cancel' : 'Add Member'}
          </button>
        )}
        {!isVhpn1 && availableNfts.length > 0 && (
          <button
            onClick={() => setShowAdd(!showAdd)}
            style={{
              background: showAdd ? '#1e3a1e' : '#4ade80',
              color: showAdd ? '#9ac79f' : '#001008',
              border: 'none',
              borderRadius: 8,
              padding: '7px 14px',
              fontWeight: 700,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {showAdd ? 'Cancel' : 'Add Yourself'}
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

      {showAdd && (
        <div
          style={{ background: '#0d1a0d', border: '1px solid #1e3a1e', borderRadius: 8, padding: 12, marginBottom: 14 }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, color: '#4ade80', marginBottom: 8 }}>
            {isVhpn1 ? 'Add Team Member' : 'Add Yourself'}
          </div>
          {bestAvailableNft && (
            <div style={{ fontSize: 11, color: '#7aaa7a', marginBottom: 8 }}>
              Using NFT:{' '}
              <span style={{ color: '#4ade80', fontWeight: 700 }}>{bestAvailableNft.nftId.toUpperCase()}</span>
              {' · '}
              {(bestAvailableNft.metadata && bestAvailableNft.metadata.tier) || 'bronze'}
            </div>
          )}
          <input
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder="Name"
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
            value={formRole}
            onChange={(e) => setFormRole(e.target.value)}
            placeholder="Role (optional)"
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
            value={formDesc}
            onChange={(e) => setFormDesc(e.target.value)}
            placeholder="Description (optional)"
            rows={3}
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
              resize: 'vertical',
              fontFamily: 'inherit',
            }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <input
              type="file"
              accept="image/*"
              onChange={handlePictureFile(setFormPicture)}
              style={{ fontSize: 12, color: '#7aaa7a', flex: 1 }}
            />
            {formPicture && (
              <img
                src={formPicture}
                alt=""
                style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }}
              />
            )}
          </div>
          <button
            onClick={handleAdd}
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
            {isVhpn1 ? 'Add Member' : 'Add Yourself'}
          </button>
        </div>
      )}

      {members.length === 0 && (
        <div style={{ fontSize: 13, color: '#7aaa7a', textAlign: 'center', marginTop: 30 }}>No team members yet.</div>
      )}

      {members.map((member) => (
        <div
          key={member.id}
          style={{ background: '#0d1a0d', border: '1px solid #1e3a1e', borderRadius: 8, padding: 12, marginBottom: 10 }}
        >
          {editId === member.id ? (
            <div>
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Name"
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
                value={editRole}
                onChange={(e) => setEditRole(e.target.value)}
                placeholder="Role"
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
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                placeholder="Description"
                rows={2}
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
                  resize: 'vertical',
                  fontFamily: 'inherit',
                }}
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handlePictureFile(setEditPicture)}
                  style={{ fontSize: 12, color: '#7aaa7a', flex: 1 }}
                />
                {editPicture && (
                  <img
                    src={editPicture}
                    alt=""
                    style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }}
                  />
                )}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={handleSaveEdit}
                  style={{
                    background: '#4ade80',
                    color: '#001008',
                    border: 'none',
                    borderRadius: 6,
                    padding: '6px 12px',
                    fontWeight: 700,
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  Save
                </button>
                <button
                  onClick={() => setEditId(null)}
                  style={{
                    background: '#1e3a1e',
                    color: '#9ac79f',
                    border: 'none',
                    borderRadius: 6,
                    padding: '6px 12px',
                    fontWeight: 700,
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              {member.picture ? (
                <img
                  src={member.picture}
                  alt=""
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: '50%',
                    objectFit: 'cover',
                    flexShrink: 0,
                    marginTop: 2,
                  }}
                />
              ) : (
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: '50%',
                    background: '#1e3a1e',
                    flexShrink: 0,
                    marginTop: 2,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 16,
                    fontWeight: 700,
                    color: '#4ade80',
                  }}
                >
                  {member.name ? member.name.charAt(0).toUpperCase() : '?'}
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#d7ffd9' }}>{member.name}</div>
                    {member.role && <div style={{ fontSize: 12, color: '#fbbf24', marginTop: 2 }}>{member.role}</div>}
                    {member.nftId && (
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: '#4ade80',
                          background: '#4ade8022',
                          borderRadius: 6,
                          padding: '1px 6px',
                          display: 'inline-block',
                          marginTop: 4,
                        }}
                      >
                        {member.nftId.toUpperCase()}
                      </span>
                    )}
                  </div>
                  {canEdit(member) && (
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      <button
                        onClick={() => handleEdit(member)}
                        style={{
                          background: 'transparent',
                          color: '#38bdf8',
                          border: '1px solid #38bdf8',
                          borderRadius: 5,
                          padding: '3px 8px',
                          fontSize: 11,
                          cursor: 'pointer',
                        }}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(member.id)}
                        style={{
                          background: 'transparent',
                          color: '#ef4444',
                          border: '1px solid #ef4444',
                          borderRadius: 5,
                          padding: '3px 8px',
                          fontSize: 11,
                          cursor: 'pointer',
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
                {member.description && (
                  <div style={{ fontSize: 12, color: '#b7f5bc', marginTop: 6, lineHeight: 1.5 }}>
                    {member.description}
                  </div>
                )}
                <div style={{ fontSize: 10, color: '#6b8f6b', marginTop: 6, wordBreak: 'break-all' }}>
                  {member.address || ''}
                  {member.addedAt ? ` · ${new Date(member.addedAt).toLocaleDateString()}` : ''}
                </div>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

import React from 'react';

// Wallet address display component with dropdown menu
export default function WalletAddressDisplay({ selectedWalletAddress, walletSyncState, onAddressChange }) {
  const address = selectedWalletAddress || '';
  const addresses = Array.isArray(walletSyncState && walletSyncState.addresses) ? walletSyncState.addresses : [];
  const status = address
    ? ''
    : ((walletSyncState && walletSyncState.walletReadiness && walletSyncState.walletReadiness.message) || '').trim() ||
      'Node connecting...';
  const [showDeleteModal, setShowDeleteModal] = React.useState(false);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [deleteMessage, setDeleteMessage] = React.useState('');
  const [dropdownOpen, setDropdownOpen] = React.useState(false);
  const [addressCopied, setAddressCopied] = React.useState(false);
  const [showBackupModal, setShowBackupModal] = React.useState(false);
  const [backupPassphrase, setBackupPassphrase] = React.useState('');
  const [backupBusy, setBackupBusy] = React.useState(false);
  const [backupMessage, setBackupMessage] = React.useState('');
  const [showRestoreModal, setShowRestoreModal] = React.useState(false);
  const [restorePassphrase, setRestorePassphrase] = React.useState('');
  const [restoreBusy, setRestoreBusy] = React.useState(false);
  const [restoreMessage, setRestoreMessage] = React.useState('');
  const [restoreNeedsForce, setRestoreNeedsForce] = React.useState(false);
  const [restoreBackupPath, setRestoreBackupPath] = React.useState('');
  const [createBusy, setCreateBusy] = React.useState(false);
  const [createMessage, setCreateMessage] = React.useState('');
  const [addressNicknames, setAddressNicknames] = React.useState(() => {
    try {
      return JSON.parse(localStorage.getItem('wattcoin-address-nicknames') || '{}');
    } catch (_) {
      return {};
    }
  });
  const [editingNickname, setEditingNickname] = React.useState(null);
  const [nicknameInput, setNicknameInput] = React.useState('');

  function saveNicknames(updated) {
    setAddressNicknames(updated);
    try {
      localStorage.setItem('wattcoin-address-nicknames', JSON.stringify(updated));
    } catch (_) {
      /* istanbul ignore next */
    }
  }
  function startEditingNickname() {
    setNicknameInput(addressNicknames[address] || '');
    setEditingNickname(address);
  }
  function commitNickname() {
    const trimmed = nicknameInput.trim();
    const updated = { ...addressNicknames };
    if (trimmed) updated[address] = trimmed;
    else delete updated[address];
    saveNicknames(updated);
    setEditingNickname(null);
  }

  async function handleCreateAddress() {
    if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) {
      setCreateMessage('Wallet API unavailable.');
      return;
    }
    setCreateBusy(true);
    setCreateMessage('Creating address...');
    try {
      const res = await window.wattcoinHardware.invoke('wattcoin-create-address');
      if (res && res.ok && res.address) {
        if (typeof onAddressChange === 'function') await onAddressChange(res.address);
        setDropdownOpen(false);
        setCreateMessage('');
      } else {
        setCreateMessage(`Error: ${res && res.message ? res.message : 'Failed to create address'}`);
      }
    } catch (e) {
      setCreateMessage(`Error: ${e && e.message ? e.message : 'Unknown error'}`);
    }
    setCreateBusy(false);
  }

  function handleDeleteAddressPrompt() {
    setDeleteMessage('');
    setDeleteBusy(false);
    setShowDeleteModal(true);
  }

  async function doDeleteActiveAddress() {
    const active = (address || '').trim();
    if (!active) {
      setDeleteMessage('No active mining address selected.');
      return;
    }
    if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) {
      setDeleteMessage('Wallet API unavailable.');
      return;
    }

    setDeleteBusy(true);
    setDeleteMessage('Deleting address from wallet list...');
    try {
      const res = await window.wattcoinHardware.invoke('wattcoin-delete-address', active);
      if (res && res.ok) {
        setDeleteMessage('Address removed from wallet list. It is recoverable via wallet backup restore.');
        setDeleteBusy(false);
        return;
      }
      setDeleteMessage(`Delete failed: ${res && res.message ? res.message : 'Unknown error'}`);
    } catch (e) {
      setDeleteMessage(`Delete failed: ${e && e.message ? e.message : 'Unknown error'}`);
    }
    setDeleteBusy(false);
  }

  function handleExportBackup() {
    setBackupPassphrase('');
    setBackupMessage('');
    setBackupBusy(false);
    setShowBackupModal(true);
  }

  async function doExportBackup() {
    if (!(window.wattcoinHardware && window.wattcoinHardware.exportWalletBackup)) {
      setBackupMessage('Wallet backup API unavailable.');
      return;
    }
    if (backupPassphrase.length < 8) {
      setBackupMessage('Passphrase must be at least 8 characters.');
      return;
    }
    setBackupBusy(true);
    setBackupMessage('Exporting…');
    try {
      const res = await window.wattcoinHardware.exportWalletBackup({ passphrase: backupPassphrase });
      if (res && res.ok) {
        setBackupMessage(`Backup exported!\n\nSaved to: ${res.filePath}`);
        setBackupBusy(false);
        return;
      }
      if (res && res.code === 'CANCELED') {
        setShowBackupModal(false);
      } else {
        setBackupMessage(`Backup failed: ${res && res.message ? res.message : 'Unknown error'}`);
      }
    } catch (e) {
      setBackupMessage(`Backup failed: ${e && e.message ? e.message : 'Unknown error'}`);
    }
    setBackupBusy(false);
  }

  function handleRestoreBackup() {
    setRestorePassphrase('');
    setRestoreMessage('');
    setRestoreNeedsForce(false);
    setRestoreBackupPath('');
    setRestoreBusy(false);
    setShowRestoreModal(true);
  }

  async function doRestoreBackup(forceOverwrite) {
    if (!(window.wattcoinHardware && window.wattcoinHardware.restoreWalletBackup)) {
      setRestoreMessage('Wallet restore API unavailable.');
      return;
    }
    if (restorePassphrase.length < 8) {
      setRestoreMessage('Passphrase must be at least 8 characters.');
      return;
    }
    setRestoreBusy(true);
    setRestoreMessage('Restoring…');
    try {
      const res = await window.wattcoinHardware.restoreWalletBackup({
        passphrase: restorePassphrase,
        allowOverwrite: !!forceOverwrite,
        backupPath: restoreBackupPath || undefined,
      });
      if (res && res.code === 'WALLET_EXISTS') {
        if (res.backupPath) {
          setRestoreBackupPath(res.backupPath);
        }
        setRestoreNeedsForce(true);
        setRestoreMessage('A wallet already exists. Click "Overwrite & Restore" to replace it.');
        setRestoreBusy(false);
        return;
      }
      if (res && res.code === 'CANCELED') {
        setRestoreBackupPath('');
        setShowRestoreModal(false);
      } else if (res && res.ok) {
        if (res.filePath) {
          setRestoreBackupPath(res.filePath);
        }
        setRestoreMessage('Wallet restored! Node restarted and wallet reloaded.');
      } else {
        setRestoreMessage(`Restore failed: ${res && res.message ? res.message : 'Unknown error'}`);
      }
    } catch (e) {
      setRestoreMessage(`Restore failed: ${e && e.message ? e.message : 'Unknown error'}`);
    }
    setRestoreBusy(false);
  }

  async function handleAddressSelect(addr) {
    if (typeof onAddressChange === 'function') await onAddressChange(addr);
    setDropdownOpen(false);
  }

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 12, color: '#a7ffb0', fontWeight: 600, marginBottom: 5 }}>Mining address:</div>

      {/* Address row: nickname | dropdown | copy */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
        {/* Nickname column */}
        {address && (
          <div style={{ flexShrink: 0, width: 102, display: 'flex', alignItems: 'flex-start' }}>
            {editingNickname === address ? (
              <div style={{ display: 'flex', gap: 2, width: '100%' }}>
                <input
                  autoFocus
                  value={nicknameInput}
                  onChange={(e) => setNicknameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitNickname();
                    if (e.key === 'Escape') setEditingNickname(null);
                  }}
                  placeholder="Nickname"
                  maxLength={20}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '5px 6px',
                    borderRadius: 6,
                    border: '1px solid #4ade80',
                    background: '#0d1a0d',
                    color: '#d7ffd9',
                    fontSize: 12,
                    outline: 'none',
                  }}
                />
                <button
                  onClick={commitNickname}
                  title="Save"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#4ade80',
                    cursor: 'pointer',
                    padding: '4px 4px',
                    fontSize: 14,
                    lineHeight: 1,
                  }}
                >
                  ✓
                </button>
                <button
                  onClick={() => setEditingNickname(null)}
                  title="Cancel"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#9ac79f',
                    cursor: 'pointer',
                    padding: '4px 2px',
                    fontSize: 14,
                    lineHeight: 1,
                  }}
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                onClick={startEditingNickname}
                title={addressNicknames[address] ? 'Edit nickname' : 'Set nickname'}
                style={{
                  background: addressNicknames[address] ? '#1a351a' : 'none',
                  border: addressNicknames[address] ? '1px solid #2d5a2d' : '1px dashed #3a5a3a',
                  borderRadius: 6,
                  color: addressNicknames[address] ? '#86efac' : '#4a7a4a',
                  padding: '5px 8px',
                  fontSize: 12,
                  cursor: 'pointer',
                  maxWidth: 100,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  width: '100%',
                  textAlign: 'left',
                  lineHeight: 1.3,
                }}
              >
                {addressNicknames[address] || '✎ name'}
              </button>
            )}
          </div>
        )}

        {/* Dropdown column */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            style={{
              fontFamily: 'monospace',
              fontSize: 13,
              background: '#1e3a1e',
              color: '#4ade80',
              padding: '6px 12px',
              borderRadius: 8,
              border: '1px solid #4ade80',
              cursor: 'pointer',
              textAlign: 'left',
              whiteSpace: 'nowrap',
              lineHeight: 1.3,
            }}
          >
            {address || status} ▼
          </button>

          {/* Dropdown menu */}
          {dropdownOpen && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                background: '#0d1a0d',
                border: '2px solid #4ade80',
                borderRadius: 8,
                marginTop: 4,
                zIndex: 1000,
                width: '100%',
                maxHeight: 220,
                overflowY: 'auto',
                boxShadow: '0 4px 16px #0008',
              }}
            >
              {addresses.length > 0 ? (
                addresses.map((addr, idx) => (
                  <div
                    key={idx}
                    onClick={() => handleAddressSelect(addr)}
                    style={{
                      padding: '7px 12px',
                      cursor: 'pointer',
                      background: addr === address ? '#1e3a1e' : 'transparent',
                      borderBottom: idx < addresses.length - 1 ? '1px solid #1a2e1a' : 'none',
                    }}
                  >
                    {addressNicknames[addr] && (
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: addr === address ? '#4ade80' : '#86efac',
                          marginBottom: 2,
                          fontFamily: 'inherit',
                        }}
                      >
                        {addressNicknames[addr]}
                      </div>
                    )}
                    <div
                      style={{
                        fontFamily: 'monospace',
                        fontSize: 11,
                        color: addr === address ? '#a7ffb0' : '#708870',
                        wordBreak: 'break-all',
                        lineHeight: 1.3,
                      }}
                    >
                      {addr}
                    </div>
                  </div>
                ))
              ) : (
                <div style={{ padding: '10px 12px', color: '#9bb09b', fontSize: 12, fontStyle: 'italic' }}>
                  No saved addresses yet. Click + New Address.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Copy address button — ghost icon, no border */}
        {address && (
          <button
            onClick={() => {
              navigator.clipboard
                .writeText(address)
                .then(() => {
                  setAddressCopied(true);
                  setTimeout(() => setAddressCopied(false), 1500);
                })
                .catch(() => {});
            }}
            title="Copy mining address"
            style={{
              flexShrink: 0,
              background: 'none',
              color: addressCopied ? '#86efac' : '#4ade80',
              border: 'none',
              borderRadius: 6,
              padding: '6px 6px',
              fontSize: 16,
              cursor: 'pointer',
              lineHeight: 1,
              transition: 'color 0.2s',
              opacity: addressCopied ? 1 : 0.7,
            }}
          >
            {addressCopied ? '✓' : '⧉'}
          </button>
        )}
      </div>

      {/* Control buttons */}
      <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          onClick={handleCreateAddress}
          disabled={createBusy}
          style={{
            background: createBusy ? '#2d7a50' : '#4ade80',
            color: '#000',
            padding: '6px 12px',
            border: 'none',
            borderRadius: 6,
            cursor: createBusy ? 'default' : 'pointer',
            fontWeight: 600,
            fontSize: 12,
            opacity: createBusy ? 0.7 : 1,
          }}
        >
          {createBusy ? 'Creating...' : '+ New Address'}
        </button>

        <button
          onClick={handleDeleteAddressPrompt}
          style={{
            background: '#f59e0b',
            color: '#1f1100',
            padding: '6px 12px',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: 12,
          }}
        >
          Delete Address
        </button>

        <button
          onClick={handleExportBackup}
          style={{
            background: '#60a5fa',
            color: '#001018',
            padding: '6px 12px',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: 12,
          }}
        >
          Backup Wallet
        </button>

        <button
          onClick={handleRestoreBackup}
          style={{
            background: '#fb7185',
            color: '#2b0000',
            padding: '6px 12px',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: 12,
          }}
        >
          Restore Wallet
        </button>
      </div>

      {createMessage && (
        <div
          style={{
            marginTop: 8,
            fontSize: 12,
            color: createMessage.startsWith('Error') ? '#f87171' : '#86efac',
            padding: '4px 0',
          }}
        >
          {createMessage}
        </div>
      )}

      {showDeleteModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000,
          }}
        >
          <div
            style={{
              background: '#241205',
              border: '2px solid #f59e0b',
              borderRadius: 12,
              padding: 24,
              minWidth: 360,
              maxWidth: 520,
              color: '#fef3c7',
            }}
          >
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 10, color: '#f59e0b' }}>
              Delete Active Mining Address
            </div>
            <div style={{ fontSize: 13, marginBottom: 12, color: '#fde68a', whiteSpace: 'pre-wrap' }}>
              {`Active address:\n${address || '(none)'}`}
            </div>
            <div style={{ fontSize: 13, marginBottom: 12, color: '#fecaca' }}>
              Warning: this removes the currently active mining address from this wallet list. It is recoverable. Make
              sure you have a recovery backup file before continuing.
            </div>
            {deleteMessage && (
              <div
                style={{
                  fontSize: 12,
                  marginBottom: 10,
                  color: deleteMessage.startsWith('Address removed') ? '#4ade80' : '#fca5a5',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {deleteMessage}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowDeleteModal(false)}
                disabled={deleteBusy}
                style={{
                  padding: '7px 16px',
                  borderRadius: 6,
                  border: '1px solid #7c2d12',
                  background: 'transparent',
                  color: '#fcd34d',
                  cursor: deleteBusy ? 'default' : 'pointer',
                  fontWeight: 600,
                  fontSize: 13,
                }}
              >
                {deleteMessage.startsWith('Address removed') ? 'Close' : 'Cancel'}
              </button>
              {!deleteMessage.startsWith('Address removed') && (
                <button
                  onClick={() => doDeleteActiveAddress()}
                  disabled={deleteBusy || !address}
                  style={{
                    padding: '7px 16px',
                    borderRadius: 6,
                    border: 'none',
                    background: deleteBusy || !address ? '#7c2d12' : '#f59e0b',
                    color: deleteBusy || !address ? '#fcd34d' : '#1f1100',
                    cursor: deleteBusy || !address ? 'default' : 'pointer',
                    fontWeight: 700,
                    fontSize: 13,
                  }}
                >
                  {deleteBusy ? 'Deleting...' : 'Delete Address'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Backup Wallet modal */}
      {showBackupModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000,
          }}
        >
          <div
            style={{
              background: '#0a1a2a',
              border: '2px solid #60a5fa',
              borderRadius: 12,
              padding: 28,
              minWidth: 360,
              maxWidth: 460,
              color: '#e8f5e8',
            }}
          >
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 12, color: '#60a5fa' }}>Backup Wallet</div>
            <div style={{ fontSize: 13, marginBottom: 14, color: '#94a3b8' }}>
              Enter a passphrase to encrypt your backup file. You will need this passphrase to restore.
            </div>
            <input
              type="password"
              placeholder="Passphrase (min 8 characters)"
              value={backupPassphrase}
              onChange={(e) => setBackupPassphrase(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !backupBusy) doExportBackup();
              }}
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid #60a5fa',
                background: '#0d2233',
                color: '#e8f5e8',
                fontSize: 13,
                marginBottom: 12,
                boxSizing: 'border-box',
              }}
              autoFocus
              disabled={backupBusy}
            />
            {backupMessage && (
              <div
                style={{
                  fontSize: 12,
                  marginBottom: 10,
                  color: backupMessage.startsWith('Backup exported') ? '#4ade80' : '#f87171',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {backupMessage}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowBackupModal(false)}
                disabled={backupBusy}
                style={{
                  padding: '7px 16px',
                  borderRadius: 6,
                  border: '1px solid #334155',
                  background: 'transparent',
                  color: '#94a3b8',
                  cursor: backupBusy ? 'default' : 'pointer',
                  fontWeight: 600,
                  fontSize: 13,
                }}
              >
                {backupMessage.startsWith('Backup exported') ? 'Close' : 'Cancel'}
              </button>
              {!backupMessage.startsWith('Backup exported') && (
                <button
                  onClick={() => doExportBackup()}
                  disabled={backupBusy || backupPassphrase.length < 8}
                  style={{
                    padding: '7px 16px',
                    borderRadius: 6,
                    border: 'none',
                    background: backupBusy || backupPassphrase.length < 8 ? '#1e3a5a' : '#60a5fa',
                    color: backupBusy || backupPassphrase.length < 8 ? '#4a6a8a' : '#001018',
                    cursor: backupBusy || backupPassphrase.length < 8 ? 'default' : 'pointer',
                    fontWeight: 600,
                    fontSize: 13,
                  }}
                >
                  {backupBusy ? 'Exporting…' : 'Export Backup'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Restore Wallet modal */}
      {showRestoreModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000,
          }}
        >
          <div
            style={{
              background: '#1a0a0a',
              border: '2px solid #fb7185',
              borderRadius: 12,
              padding: 28,
              minWidth: 360,
              maxWidth: 460,
              color: '#e8f5e8',
            }}
          >
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 12, color: '#fb7185' }}>Restore Wallet</div>
            <div style={{ fontSize: 13, marginBottom: 14, color: '#fca5a5' }}>
              ⚠️ This will overwrite your current wallet and restart the node. Make sure you have a backup before
              proceeding.
            </div>
            <input
              type="password"
              placeholder="Backup passphrase"
              value={restorePassphrase}
              onChange={(e) => setRestorePassphrase(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !restoreBusy) doRestoreBackup(restoreNeedsForce);
              }}
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid #fb7185',
                background: '#2b0000',
                color: '#e8f5e8',
                fontSize: 13,
                marginBottom: 12,
                boxSizing: 'border-box',
              }}
              autoFocus
              disabled={restoreBusy}
            />
            {restoreMessage && (
              <div
                style={{
                  fontSize: 12,
                  marginBottom: 10,
                  color: restoreMessage.startsWith('Wallet restored') ? '#4ade80' : '#f87171',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {restoreMessage}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowRestoreModal(false)}
                disabled={restoreBusy}
                style={{
                  padding: '7px 16px',
                  borderRadius: 6,
                  border: '1px solid #334155',
                  background: 'transparent',
                  color: '#94a3b8',
                  cursor: restoreBusy ? 'default' : 'pointer',
                  fontWeight: 600,
                  fontSize: 13,
                }}
              >
                {restoreMessage.startsWith('Wallet restored') ? 'Close' : 'Cancel'}
              </button>
              {!restoreMessage.startsWith('Wallet restored') && (
                <button
                  onClick={() => doRestoreBackup(restoreNeedsForce)}
                  disabled={restoreBusy || restorePassphrase.length < 8}
                  style={{
                    padding: '7px 16px',
                    borderRadius: 6,
                    border: 'none',
                    background: restoreBusy || restorePassphrase.length < 8 ? '#3a1010' : '#fb7185',
                    color: restoreBusy || restorePassphrase.length < 8 ? '#7a4040' : '#2b0000',
                    cursor: restoreBusy || restorePassphrase.length < 8 ? 'default' : 'pointer',
                    fontWeight: 600,
                    fontSize: 13,
                  }}
                >
                  {restoreBusy ? 'Restoring…' : restoreNeedsForce ? 'Overwrite & Restore' : 'Restore Wallet'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

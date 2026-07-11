import React from 'react';

export default function WalletPayModal({ orderId, usdcRequired, wtcAmount, onPaid, onManual, onClose }) {
  const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const SELLER = '0x0ca8cc23d85e5c988828076978c4ca65aa4293e8';
  const [step, setStep] = React.useState('pick'); // pick|connecting|confirm|done|error
  const [errorMsg, setErrorMsg] = React.useState('');
  const [txHash, setTxHash] = React.useState('');
  const [walletLabel, setWalletLabel] = React.useState('');

  // EIP-681 payment request URI — opens in MetaMask, Trust Wallet, Coinbase, etc.
  const _eip681 = `ethereum:${USDC_CONTRACT}@1/transfer?address=${SELLER}&uint256=${Math.round(usdcRequired * 1_000_000)}`;

  function detectInjected() {
    try {
      const eth = window.ethereum;
      if (!eth) return null;
      if (eth.isFrame) return 'Frame';
      if (eth.isCoinbaseWallet) return 'Coinbase Wallet';
      if (eth.isTrust) return 'Trust Wallet';
      if (eth.isMetaMask) return 'MetaMask';
      return 'Browser Wallet';
    } catch (_) {
      return null;
    }
  }

  function encodeTransfer(to, amountUsdc) {
    // transfer(address,uint256) selector = 0xa9059cbb; USDC has 6 decimals
    const amt = BigInt(Math.round(amountUsdc * 1_000_000));
    const toHex = to.replace(/^0x/, '').toLowerCase().padStart(64, '0');
    const amtHex = amt.toString(16).padStart(64, '0');
    return '0xa9059cbb' + toHex + amtHex;
  }

  async function handleInjected() {
    const eth = window.ethereum;
    if (!eth) {
      setErrorMsg('No injected wallet detected.');
      return;
    }
    const label = detectInjected() || 'Browser Wallet';
    setWalletLabel(label);
    setStep('connecting');
    try {
      const accounts = await eth.request({ method: 'eth_requestAccounts' });
      if (!accounts || !accounts[0]) throw new Error('No account returned from wallet');
      const chainId = await eth.request({ method: 'eth_chainId' });
      if (chainId !== '0x1') {
        await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
      }
      setStep('confirm');
      const hash = await eth.request({
        method: 'eth_sendTransaction',
        params: [{ from: accounts[0], to: USDC_CONTRACT, value: '0x0', data: encodeTransfer(SELLER, usdcRequired) }],
      });
      setTxHash(hash);
      if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
        await window.wattcoinHardware.invoke('wattcoin-sale-confirm-payment', { orderId, txHash: hash });
      }
      setStep('done');
      setTimeout(() => onPaid(hash), 1600);
    } catch (e) {
      if (e && e.code === 4001) {
        setStep('pick');
        setErrorMsg('Transaction cancelled.');
      } else {
        setStep('error');
        setErrorMsg(e && e.message ? e.message : 'Unknown error');
      }
    }
  }

  function handleEip681() {
    if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
      window.wattcoinHardware.invoke('wattcoin-open-pay-page', {
        usdcRequired,
        wtcAmount,
        sellerAddress: SELLER,
      });
    }
    onManual();
  }

  const injected = detectInjected();
  const btn = {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    width: '100%',
    padding: '14px 16px',
    borderRadius: 12,
    cursor: 'pointer',
    color: '#e8f5e8',
    textAlign: 'left',
    background: '#0a1a0a',
    border: '1px solid #2d4a2d',
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,6,0,0.84)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          background: '#0d1a0d',
          border: '1px solid #2d4a2d',
          borderRadius: 18,
          padding: '28px 28px',
          maxWidth: 400,
          width: '100%',
          position: 'relative',
        }}
      >
        <button
          onClick={onClose}
          style={{
            position: 'absolute',
            top: 12,
            right: 16,
            background: 'none',
            border: 'none',
            color: '#4a6a4a',
            fontSize: 22,
            cursor: 'pointer',
            lineHeight: 1,
          }}
        >
          ×
        </button>

        {step === 'pick' && (
          <>
            <div style={{ fontSize: 15, color: '#4ade80', fontWeight: 700, marginBottom: 4 }}>Pay with USDC</div>
            <div style={{ fontSize: 13, color: '#6b9b6b', marginBottom: 20 }}>
              Send <span style={{ color: '#fcd34d', fontWeight: 700 }}>${usdcRequired.toFixed(2)} USDC</span> to receive{' '}
              <span style={{ color: '#a7ffb0', fontWeight: 700 }}>{wtcAmount?.toLocaleString()} WTC</span>
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              {injected && (
                <button onClick={handleInjected} style={{ ...btn, border: '1px solid #4ade8050' }}>
                  <span style={{ fontSize: 22, minWidth: 28, textAlign: 'center' }}>🦊</span>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{injected}</div>
                    <div style={{ fontSize: 11, color: '#6b9b6b' }}>Detected — sign directly in app</div>
                  </div>
                </button>
              )}
              <button onClick={handleEip681} style={{ ...btn }}>
                <span style={{ fontSize: 22, minWidth: 28, textAlign: 'center' }}>🔗</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>Open in Wallet App</div>
                  <div style={{ fontSize: 11, color: '#6b9b6b' }}>MetaMask · Trust Wallet · Coinbase · Base</div>
                </div>
              </button>
            </div>
            {errorMsg && <div style={{ color: '#fca5a5', fontSize: 12, marginTop: 12 }}>{errorMsg}</div>}
          </>
        )}

        {(step === 'connecting' || step === 'confirm') && (
          <div style={{ textAlign: 'center', padding: '28px 0' }}>
            <div style={{ fontSize: 36, marginBottom: 14 }}>{step === 'connecting' ? '🔌' : '✍️'}</div>
            <div style={{ fontSize: 14, color: '#4ade80', fontWeight: 700, marginBottom: 8 }}>
              {step === 'connecting' ? `Connecting to ${walletLabel}…` : `Confirm in ${walletLabel}`}
            </div>
            <div style={{ fontSize: 12, color: '#6b9b6b' }}>
              {step === 'connecting'
                ? 'Approve the connection in your wallet'
                : `Review and confirm the $${usdcRequired.toFixed(2)} USDC transfer`}
            </div>
          </div>
        )}

        {step === 'done' && (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
            <div style={{ fontSize: 15, color: '#4ade80', fontWeight: 700, marginBottom: 6 }}>Payment Submitted!</div>
            <div style={{ fontSize: 12, color: '#6b9b6b', marginBottom: 10 }}>
              Your WTC will appear in your wallet once the batch of 10,101 WTC is queued.
            </div>
            <div style={{ fontFamily: 'monospace', fontSize: 10, color: '#3d5c3d', wordBreak: 'break-all' }}>
              {txHash}
            </div>
          </div>
        )}

        {step === 'error' && (
          <>
            <div style={{ fontSize: 14, color: '#fca5a5', fontWeight: 700, marginBottom: 8 }}>Payment Failed</div>
            <div style={{ fontSize: 12, color: '#6b9b6b', marginBottom: 16, lineHeight: 1.5 }}>{errorMsg}</div>
            <button
              onClick={() => {
                setStep('pick');
                setErrorMsg('');
              }}
              style={{
                background: '#1e3a1e',
                color: '#b7f5bc',
                border: 'none',
                borderRadius: 8,
                padding: '9px 18px',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              Try Again
            </button>
          </>
        )}
      </div>
    </div>
  );
}

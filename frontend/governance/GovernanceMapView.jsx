import { useState, useEffect, useRef } from 'react';

export default function MapView({ selectedWalletAddress }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const hoveredRef = useRef(null);
  const transformRef = useRef({ x: 0, y: 0, scale: 1 });
  const nodesDataRef = useRef(null);
  const edgeListRef = useRef([]);
  const settledRef = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [data, setData] = useState(null);
  const [tooltip, setTooltip] = useState(null);
  const [stats, setStats] = useState({
    peerCount: 0,
    attestCount: 0,
    tunnelCount: 0,
    gossipCount: 0,
    roundId: 0,
    totalWh: 0,
    contributors: [],
  });

  useEffect(() => {
    let mounted = true;
    let interval;

    async function fetchData() {
      try {
        const result = await window.wattcoinHardware.invoke('wattcoin-get-peer-topology');
        if (!mounted) return;
        if (result && result.ok) {
          setData(result);
          setLoaded(true);
          setError(false);
        } else {
          setError(true);
        }
      } catch {
        if (mounted) setError(true);
      }
    }

    fetchData();
    interval = setInterval(fetchData, 15000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!data || !data.peers || data.peers.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;
    const cx = w / 2;
    const cy = h / 2;

    const { peers, attestations, tunnels, gossipEdges, contributors, totalWh, localPeerUrls } = data;
    const localUrls = new Set((localPeerUrls || []).map((u) => u.replace(/\/$/, '')));

    const isFirstRun = !nodesDataRef.current;
    const transform = transformRef.current;
    let nodes;
    let edgeList;

    if (isFirstRun) {
      const peerById = {};
      nodes = [];
      const edgeSet = new Set();
      edgeList = [];

      peers.forEach((p) => {
        const id = p.peerIdentity || p.url;
        peerById[id] = p;
        if (p.walletAddress) peerById[p.walletAddress] = p;
        const isOwn =
          localUrls.has(p.url.replace(/\/$/, '')) ||
          (p.peerIdentity && selectedWalletAddress && p.peerIdentity.includes(selectedWalletAddress.slice(6, 16)));
        if (isOwn) return;
        const isOnline = p.reachable === true;
        nodes.push({
          id,
          url: p.url,
          peerIdentity: p.peerIdentity,
          walletAddress: p.walletAddress || '',
          reachable: p.reachable,
          wh: 0,
          lastSeenMs: p.lastSeenMs,
          tipHeight: p.tipHeight,
          isOnline,
          x: isOnline ? Math.random() * w * 0.6 + w * 0.2 : cx + 3000 * (Math.random() - 0.5),
          y: isOnline ? Math.random() * h * 0.6 + h * 0.2 : cy + 3000 * (Math.random() - 0.5),
          vx: 0,
          vy: 0,
        });
      });

      const localWh =
        selectedWalletAddress && contributors
          ? contributors.find((c) => c.address === selectedWalletAddress)?.wh || 0
          : 0;
      nodes.push({
        id: '__local__',
        url: '(you)',
        peerIdentity: '',
        walletAddress: selectedWalletAddress || '',
        reachable: true,
        wh: localWh,
        lastSeenMs: 0,
        tipHeight: 0,
        isOnline: true,
        x: cx + (Math.random() - 0.5) * 40,
        y: cy + (Math.random() - 0.5) * 40,
        vx: 0,
        vy: 0,
        isLocal: true,
      });

      attestations.forEach((a) => {
        if (!peerById[a.verifier] || !peerById[a.worker]) return;
        const key = a.verifier + '>' + a.worker;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edgeList.push({ source: a.verifier, target: a.worker, type: 'attest' });
        }
      });

      if (gossipEdges) {
        gossipEdges.forEach((g) => {
          if (!peerById[g.source] || !peerById[g.target]) return;
          const key = g.source + '~' + g.target;
          if (!edgeSet.has(key)) {
            edgeSet.add(key);
            edgeList.push({ source: g.source, target: g.target, type: 'gossip' });
          }
        });
      }

      peers.forEach((p) => {
        const id = p.peerIdentity || p.url;
        if (!peerById[id]) return;
        if (p.reachable !== true) return;
        const isTunnel = tunnels.some((t) => t.peerIdentity === id);
        const key = '__local__>' + id;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edgeList.push({ source: '__local__', target: id, type: isTunnel ? 'tunnel' : 'direct' });
        }
      });

      nodesDataRef.current = nodes;
      edgeListRef.current = edgeList;
    } else {
      nodes = nodesDataRef.current;
      edgeList = edgeListRef.current;

      const peerById = {};
      peers.forEach((p) => {
        const id = p.peerIdentity || p.url;
        peerById[id] = p;
        if (p.walletAddress) peerById[p.walletAddress] = p;
      });

      nodes.forEach((n) => {
        const p = peerById[n.id];
        if (p) {
          n.reachable = p.reachable;
          n.wh = 0;
          n.lastSeenMs = p.lastSeenMs;
          n.tipHeight = p.tipHeight;
          n.walletAddress = p.walletAddress || '';
          n.isOnline = p.reachable === true;
        }
        if (n.isLocal && selectedWalletAddress && contributors) {
          const found = contributors.find((c) => c.address === selectedWalletAddress);
          n.wh = found ? found.wh : 0;
          n.walletAddress = selectedWalletAddress || '';
        }
      });
    }

    setStats({
      peerCount: nodes.filter((n) => !n.isLocal).length,
      attestCount: edgeList.filter((e) => e.type === 'attest').length,
      tunnelCount: data.tunnels ? data.tunnels.length : 0,
      gossipCount: gossipEdges ? gossipEdges.length : 0,
      roundId: data.roundId,
      totalWh: data.totalWh,
      contributors: data.contributors || [],
    });

    let animId;
    let tick = 0;
    const maxTicks = 400;

    function simulate() {
      tick++;
      const alpha = Math.max(0.01, 1 - tick / maxTicks);
      const repulsion = 12000 * alpha;
      const attraction = 0.003 * alpha;
      const centerForce = 0.015 * alpha;
      const onlineNodes = nodes.filter((n) => n.isOnline);

      for (const a of onlineNodes) {
        for (const b of onlineNodes) {
          if (a.id >= b.id) continue;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = repulsion / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx -= fx;
          a.vy -= fy;
          b.vx += fx;
          b.vy += fy;
        }

        const cx2 = cx - a.x;
        const cy2 = cy - a.y;
        a.vx += cx2 * centerForce;
        a.vy += cy2 * centerForce;
      }

      for (const e of edgeList) {
        const src = nodes.find((n) => n.id === e.source);
        const tgt = nodes.find((n) => n.id === e.target);
        if (!src || !tgt) continue;
        let dx = tgt.x - src.x;
        let dy = tgt.y - src.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const desired = e.type === 'attest' ? 130 : 180;
        const f = (dist - desired) * attraction;
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;
        src.vx += fx;
        src.vy += fy;
        tgt.vx -= fx;
        tgt.vy -= fy;
      }

      for (const n of nodes) {
        if (n.isOnline) {
          n.vx *= 0.85;
          n.vy *= 0.85;
          n.x += n.vx;
          n.y += n.vy;
          n.x = Math.max(40, Math.min(w - 40, n.x));
          n.y = Math.max(40, Math.min(h - 40, n.y));
        }
      }

      draw();
      if (tick < maxTicks) {
        animId = requestAnimationFrame(simulate);
      } else {
        settledRef.current = true;
      }
    }

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w * dpr, h * dpr);

      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.7);
      grad.addColorStop(0, '#0a1a0a');
      grad.addColorStop(1, '#060e06');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      ctx.setTransform(transform.scale * dpr, 0, 0, transform.scale * dpr, transform.x * dpr, transform.y * dpr);

      const hoveredId = hoveredRef.current;

      for (const e of edgeList) {
        const src = nodes.find((n) => n.id === e.source);
        const tgt = nodes.find((n) => n.id === e.target);
        if (!src || !tgt) continue;
        if (!src.isOnline && !tgt.isOnline) continue;
        const isHl = hoveredId && (hoveredId === src.id || hoveredId === tgt.id);

        if (e.type === 'attest') {
          ctx.beginPath();
          ctx.moveTo(src.x, src.y);
          ctx.lineTo(tgt.x, tgt.y);
          ctx.strokeStyle = isHl ? 'rgba(251, 191, 36, 0.7)' : 'rgba(74, 222, 128, 0.2)';
          ctx.lineWidth = isHl ? 2.5 : 1.5;
          ctx.stroke();

          const angle = Math.atan2(tgt.y - src.y, tgt.x - src.x);
          const ax = tgt.x - 14 * Math.cos(angle);
          const ay = tgt.y - 14 * Math.sin(angle);
          ctx.beginPath();
          ctx.moveTo(tgt.x, tgt.y);
          ctx.lineTo(ax - 7 * Math.cos(angle - Math.PI / 2), ay - 7 * Math.sin(angle - Math.PI / 2));
          ctx.lineTo(ax + 7 * Math.cos(angle - Math.PI / 2), ay + 7 * Math.sin(angle - Math.PI / 2));
          ctx.closePath();
          ctx.fillStyle = isHl ? 'rgba(251, 191, 36, 0.8)' : 'rgba(74, 222, 128, 0.35)';
          ctx.fill();
        } else if (e.type === 'gossip') {
          ctx.beginPath();
          ctx.setLineDash([4, 4]);
          ctx.moveTo(src.x, src.y);
          ctx.lineTo(tgt.x, tgt.y);
          ctx.strokeStyle = isHl ? 'rgba(34, 211, 238, 0.6)' : 'rgba(34, 211, 238, 0.2)';
          ctx.lineWidth = isHl ? 2.5 : 1.5;
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          ctx.beginPath();
          ctx.moveTo(src.x, src.y);
          ctx.lineTo(tgt.x, tgt.y);
          ctx.strokeStyle = isHl ? 'rgba(251, 191, 36, 0.5)' : 'rgba(74, 222, 128, 0.15)';
          ctx.lineWidth = isHl ? 2.5 : 1.5;
          ctx.stroke();
        }
      }

      for (const n of nodes) {
        if (n.isLocal) {
          ctx.beginPath();
          const s = 12;
          ctx.rect(n.x - s, n.y - s, s * 2, s * 2);
          ctx.fillStyle = hoveredId === n.id ? '#fbbf24' : '#4ade80';
          ctx.fill();
          continue;
        }

        if (!n.isOnline && transform.scale >= 0.8) continue;

        const r = Math.max(7, Math.min(24, 7 + Math.sqrt(n.wh / (totalWh || 1)) * 50));
        const isHovered = hoveredId === n.id;

        let color;
        if (n.isOnline) color = '#4ade80';
        else if (n.reachable === false) color = '#ef4444';
        else color = '#6b7280';

        if (isHovered) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(251, 191, 36, 0.1)';
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = isHovered ? '#fbbf24' : color;
        ctx.globalAlpha = isHovered ? 1 : n.isOnline ? 0.8 : 0.4;
        ctx.fill();
        ctx.globalAlpha = 1;

        if (isHovered) {
          ctx.strokeStyle = '#fbbf24';
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        if (r > 11) {
          ctx.fillStyle = '#fbbf24';
          ctx.font = 'bold 9px monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const label = n.walletAddress
            ? '..' + n.walletAddress.slice(-6)
            : n.wh > 0
              ? Math.round(n.wh) + 'W'
              : n.id.slice(0, 6);
          ctx.fillText(label, n.x, n.y);
        }
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function screenToWorld(sx, sy) {
      return { x: (sx - transform.x) / transform.scale, y: (sy - transform.y) / transform.scale };
    }

    function handleMouseMove(e) {
      const rect2 = canvas.getBoundingClientRect();
      const sx = e.clientX - rect2.left;
      const sy = e.clientY - rect2.top;
      const world = screenToWorld(sx, sy);
      let found = null;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (!n.isOnline && transform.scale >= 0.8) continue;
        const r2 = Math.max(7, Math.min(24, 7 + Math.sqrt(n.wh / (totalWh || 1)) * 50));
        const dx = world.x - n.x;
        const dy = world.y - n.y;
        if (dx * dx + dy * dy <= (r2 + 5) * (r2 + 5)) {
          found = n;
          break;
        }
      }
      const prevId = hoveredRef.current;
      const newId = found ? found.id : null;
      if (prevId !== newId) {
        hoveredRef.current = newId;
        if (settledRef.current) draw();
      }
      if (found) {
        const myEdges = edgeList.filter((e) => e.source === found.id || e.target === found.id);
        const connCount = myEdges.length;
        const myContrib = contributors && contributors.find((c) => c.address === found.walletAddress);
        const wh = myContrib ? myContrib.wh : 0;
        setTooltip({
          x: Math.min(sx + 14, rect2.width - 300),
          y: Math.min(sy + 14, rect2.height - 220),
          id: found.id,
          url: found.url,
          peerIdentity: found.peerIdentity,
          walletAddress: found.walletAddress || '',
          reachable: found.reachable,
          wh,
          lastSeenMs: found.lastSeenMs,
          tipHeight: found.tipHeight,
          connCount,
        });
      } else {
        setTooltip(null);
      }
    }

    let isDragging = false;
    const dragStart = { x: 0, y: 0 };
    const dragTransform = { x: 0, y: 0 };

    function handleWheel(e) {
      e.preventDefault();
      const rect2 = canvas.getBoundingClientRect();
      const mx = e.clientX - rect2.left;
      const my = e.clientY - rect2.top;
      const world = screenToWorld(mx, my);
      const factor = e.deltaY > 0 ? 0.88 : 1 / 0.88;
      const newScale = Math.max(0.1, Math.min(10, transform.scale * factor));
      transform.x = mx - world.x * newScale;
      transform.y = my - world.y * newScale;
      transform.scale = newScale;
      draw();
    }

    function handleMouseDown(e) {
      if (e.button !== 0) return;
      isDragging = true;
      dragStart.x = e.clientX;
      dragStart.y = e.clientY;
      dragTransform.x = transform.x;
      dragTransform.y = transform.y;
      canvas.style.cursor = 'grabbing';
    }

    function handleMouseMoveWrap(e) {
      if (isDragging) {
        transform.x = dragTransform.x + (e.clientX - dragStart.x);
        transform.y = dragTransform.y + (e.clientY - dragStart.y);
        draw();
        return;
      }
      handleMouseMove(e);
    }

    function handleMouseUp() {
      if (!isDragging) return;
      isDragging = false;
      canvas.style.cursor = 'pointer';
    }

    function handleMouseLeave() {
      hoveredRef.current = null;
      setTooltip(null);
      if (settledRef.current) draw();
      isDragging = false;
      canvas.style.cursor = 'pointer';
    }

    canvas.onmousemove = handleMouseMoveWrap;
    canvas.onmouseleave = handleMouseLeave;
    canvas.onwheel = handleWheel;
    canvas.onmousedown = handleMouseDown;
    canvas.onmouseup = handleMouseUp;
    canvas.style.cursor = 'pointer';

    if (isFirstRun) {
      animId = requestAnimationFrame(simulate);
    } else {
      draw();
    }

    return () => {
      if (animId) cancelAnimationFrame(animId);
    };
  }, [data, selectedWalletAddress]);

  if (!loaded) {
    return <div style={{ padding: 20, color: '#6b7280' }}>Loading peer topology...</div>;
  }

  if (error) {
    return (
      <div style={{ padding: 20, color: '#ef4444' }}>Could not load peer data. Make sure the miner is running.</div>
    );
  }

  if (!data || !data.peers || data.peers.length === 0) {
    return (
      <div style={{ padding: 20, color: '#6b7280' }}>No peers discovered yet. Start mining to see the network map.</div>
    );
  }

  return (
    <div ref={containerRef} style={{ display: 'flex', flex: 1, height: '100%', width: '100%', overflow: 'hidden' }}>
      <div
        style={{
          width: 300,
          flexShrink: 0,
          padding: '10px 0 10px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          overflowY: 'auto',
        }}
      >
        <div
          style={{
            background: 'rgba(6, 14, 6, 0.9)',
            border: '1px solid rgba(74, 222, 128, 0.25)',
            borderRadius: 6,
            padding: '10px 14px',
            color: '#e8f5e8',
            fontSize: 12,
            fontFamily: 'monospace',
            lineHeight: 1.8,
            whiteSpace: 'nowrap',
          }}
        >
          <div style={{ color: '#9ca3af' }}>
            Peers: {stats.peerCount} &nbsp; Attest: {stats.attestCount} &nbsp; Tunnels: {stats.tunnelCount} &nbsp;
            Gossip: {stats.gossipCount}
          </div>
          <div style={{ color: '#4ade80' }}>
            Round #{stats.roundId} &nbsp; {Math.round(stats.totalWh)} Wh total
          </div>
          <div style={{ color: '#6b7280', fontSize: 11, lineHeight: 1.6 }}>
            <span style={{ color: '#4ade80' }}>Green</span>=Online &nbsp;
            <span style={{ color: '#ef4444' }}>Red</span>=Offline &nbsp;
            <span style={{ color: '#6b7280' }}>Gray</span>=Unknown
          </div>
          <div style={{ color: '#9ca3af', fontSize: 11 }}>Scroll to zoom &nbsp; Drag to pan</div>
        </div>
        {stats.contributors.length > 0 && (
          <div
            style={{
              background: 'rgba(6, 14, 6, 0.9)',
              border: '1px solid rgba(74, 222, 128, 0.25)',
              borderRadius: 6,
              padding: '10px 14px',
              color: '#e8f5e8',
              fontSize: 12,
              fontFamily: 'monospace',
              lineHeight: 1.8,
              whiteSpace: 'nowrap',
            }}
          >
            <div style={{ color: '#fbbf24', marginBottom: 4 }}>Contributing Wallets</div>
            {stats.contributors
              .slice()
              .sort((a, b) => b.wh - a.wh)
              .map((c) => {
                const shortAddr =
                  c.address.length > 16 ? c.address.slice(0, 8) + '..' + c.address.slice(-4) : c.address;
                return (
                  <div key={c.address} style={{ color: '#9ca3af' }}>
                    {shortAddr} &nbsp; {Math.round(c.wh)} Wh
                  </div>
                );
              })}
          </div>
        )}
      </div>
      <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
        <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%', borderRadius: 0 }} />
        {tooltip && (
          <div
            style={{
              position: 'absolute',
              left: tooltip.x,
              top: tooltip.y,
              background: '#0f1a0f',
              border: '1px solid rgba(74, 222, 128, 0.4)',
              borderRadius: 6,
              padding: '10px 14px',
              color: '#e8f5e8',
              fontSize: 12,
              fontFamily: 'monospace',
              pointerEvents: 'none',
              zIndex: 10,
              maxWidth: 300,
              lineHeight: 1.6,
              overflow: 'hidden',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 4 }}>{tooltip.id}</div>
            <div style={{ color: '#9ca3af', fontSize: 10, wordBreak: 'break-all', lineHeight: 1.3, marginBottom: 2 }}>
              {tooltip.url}
            </div>
            {tooltip.peerIdentity && <div>Device: {tooltip.peerIdentity.slice(0, 20)}...</div>}
            <div
              style={{
                color: tooltip.reachable === true ? '#4ade80' : tooltip.reachable === false ? '#ef4444' : '#6b7280',
              }}
            >
              {tooltip.reachable === true ? 'Online' : tooltip.reachable === false ? 'Offline' : 'Unknown'}
            </div>
            <div>Wallet: {tooltip.walletAddress || 'Unknown'}</div>
            <div>Contribution: {tooltip.wh > 0 ? Math.round(tooltip.wh) + ' Wh' : 'None this round'}</div>
            {tooltip.tipHeight != null && <div>Chain tip: #{tooltip.tipHeight}</div>}
            {tooltip.lastSeenMs > 0 && <div>Last seen: {new Date(tooltip.lastSeenMs).toLocaleTimeString()}</div>}
            <div>Connections: {tooltip.connCount}</div>
          </div>
        )}
      </div>
    </div>
  );
}

import React from 'react';

const COINS_PER_TIER = 1_000_000;
const TOTAL_TIERS = 21;
const TIER0_ENERGY = 1;
const TIER1_ENERGY = 20_000;
const BASE_REWARD = 1000;
const MAX_HARDWARE_LOAD_PERCENT = 85;
const LOAD_PERCENT_STORAGE_KEY = 'wattcoin-load-percent';
const STARTUP_BENCHMARK_DONE_STORAGE_KEY = 'wattcoin-startup-benchmark-done-v1';
const BENCHMARK_DRIFT_THRESHOLD = 0.3; // 30% drift on any metric: triggers immediate 2x extended retry
const BENCHMARK_HOLD_DURATION_MS = 5 * 60 * 1000; // 5 minutes on-hold after retry also fails
const HW_HOLD_STORAGE_KEY = 'wattcoin-hw-hold-until-v1';
const ENABLE_HARDWARE_HOLD = true;
const ENABLE_BACKGROUND_BENCHMARKS = true;
const SUSPICIOUS_BENCH_EVAL_INTERVAL_MS = 30_000; // evaluate surprise benchmark chance every 30 s while mining

const FINGERPRINT_HASH_STORAGE_KEY = 'wattcoin-fingerprint-hash-v2';
const FINGERPRINT_SIG_STORAGE_KEY = 'wattcoin-fingerprint-sig-v2';
const FINGERPRINT_SECRET_STORAGE_KEY = 'wattcoin-fingerprint-secret-v2';
const BENCH_BASELINE_OPS_KEY = 'wattcoin-bench-baseline-ops-v1';
const BENCH_BASELINE_GPS_KEY = 'wattcoin-bench-baseline-gps-v1';
const BENCH_BASELINE_SIG_KEY = 'wattcoin-bench-baseline-sig-v1';
const TRUST_SCORE_STORAGE_KEY = 'wattcoin-trust-score-v1';
const HARDWARE_COLUMN_WIDTH_PX = 240;
const PX_PER_MM = 96 / 25.4;
const CARD_HEIGHT_INCREASE_MM = 5;
const CARD_HEIGHT_INCREASE_PX = Math.round(CARD_HEIGHT_INCREASE_MM * PX_PER_MM);
const CARD_HEIGHT_REDUCTION_PX = Math.round((4 * 96) / 25.4);
const STATUS_CARD_HEIGHT_PX = 148;
const METRIC_CARD_HEIGHT_PX = 232 - CARD_HEIGHT_REDUCTION_PX + CARD_HEIGHT_INCREASE_PX + 38;
const TOP_SECTION_GAP_PX = 16;
const HARDWARE_CARD_HEIGHT_PX = STATUS_CARD_HEIGHT_PX + TOP_SECTION_GAP_PX + METRIC_CARD_HEIGHT_PX;
const _LOAD_CARD_HEIGHT_PX = 156;

const energyForTier = (n) => (n === 0 ? TIER0_ENERGY : TIER1_ENERGY * Math.pow(2, n - 1));
const rewardForTier = (n) => BASE_REWARD / Math.pow(2, n);

// Compute the global chain tier from the authoritative chain height.
// height < 0  → empty chain (tier 0 not yet premined)
// height === 0 → genesis only (Tier 0 done; energy mining starts at Tier 1)
// height > 0  → count energy blocks to find which tier we're in
function globalTierFromHeight(height) {
  if (height < 0) return 0;
  if (height === 0) return 1; // genesis premined Tier 0 complete
  let remaining = height; // number of energy blocks mined (heights 1..height)
  for (let tier = 1; tier < TOTAL_TIERS; tier++) {
    const blocksThisTier = Math.round(COINS_PER_TIER / rewardForTier(tier));
    if (remaining <= blocksThisTier) return tier;
    remaining -= blocksThisTier;
  }
  return TOTAL_TIERS - 1;
}

const fmtNum = (n, d = 0) => n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });

const simpleHash = (value) => {
  const str = String(value || '');
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

const fmtEnergy = (wh, decimals = 2) => {
  if (wh >= 1e12) return (wh / 1e12).toFixed(decimals) + ' TWh';
  if (wh >= 1e9) return (wh / 1e9).toFixed(decimals) + ' GWh';
  if (wh >= 1e6) return (wh / 1e6).toFixed(decimals) + ' MWh';
  if (wh >= 1e3) return (wh / 1e3).toFixed(decimals) + ' kWh';
  return wh.toFixed(decimals) + ' Wh';
};

const CONFIDENCE_TIER_LABELS = {
  measured: 'Measured (hardware sensor)',
  derived: 'Derived (counter delta)',
  estimated: 'Estimated (model)',
};

function detectMotherboardFormFactor(...values) {
  const haystack = values
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .join(' ');

  if (!haystack) return '';
  if (/(mini[- ]itx|\bitx\b)/i.test(haystack)) return 'ITX';
  if (/(micro[- ]atx|\bm[- ]?atx\b|\bmatx\b)/i.test(haystack)) return 'mATX';
  if (/(extended[- ]atx|\be[- ]?atx\b|\beatx\b)/i.test(haystack)) return 'E-ATX';
  if (/(xl[- ]atx|\bxl[- ]?atx\b)/i.test(haystack)) return 'XL-ATX';
  if (/(mini[- ]dtx|\bdtx\b)/i.test(haystack)) return 'DTX';
  if (/\batx\b/i.test(haystack)) return 'ATX';
  return '';
}

const LAPTOP_MODEL_VENDOR_PRIORITIES = [
  {
    pattern: /lenovo/i,
    fieldScores: { systemModel: 140, systemSku: 110, baseboardModel: 55, baseboardVersion: 10, systemVersion: -180 },
  },
  {
    pattern: /dell/i,
    fieldScores: { systemModel: 140, systemSku: 120, baseboardModel: 45, baseboardVersion: 5, systemVersion: -170 },
  },
  {
    pattern: /hp|hewlett-packard/i,
    fieldScores: { systemModel: 140, systemSku: 125, baseboardModel: 60, baseboardVersion: 15, systemVersion: -170 },
  },
  {
    pattern: /asus/i,
    fieldScores: { systemModel: 140, baseboardModel: 105, systemSku: 80, baseboardVersion: 30, systemVersion: -165 },
  },
  {
    pattern: /acer/i,
    fieldScores: { systemModel: 140, baseboardModel: 95, systemSku: 75, baseboardVersion: 25, systemVersion: -165 },
  },
  {
    pattern: /msi|micro-star/i,
    fieldScores: { systemModel: 140, baseboardModel: 100, systemSku: 70, baseboardVersion: 25, systemVersion: -165 },
  },
  {
    pattern: /microsoft/i,
    fieldScores: { systemModel: 140, systemSku: 115, baseboardModel: 55, baseboardVersion: 10, systemVersion: -170 },
  },
  {
    pattern: /samsung|lg|razer|huawei|xiaomi/i,
    fieldScores: { systemModel: 140, systemSku: 105, baseboardModel: 70, baseboardVersion: 20, systemVersion: -165 },
  },
];

const DEFAULT_LAPTOP_MODEL_FIELD_SCORES = {
  systemModel: 130,
  systemSku: 95,
  baseboardModel: 70,
  baseboardVersion: 25,
  systemVersion: -150,
};

const LAPTOP_COMMERCIAL_MODEL_HINTS =
  /ThinkPad|ThinkBook|IdeaPad|Yoga|Legion|LOQ|MacBook|XPS|Latitude|EliteBook|Spectre|Surface|Aspire|TravelMate|Swift|Nitro|Predator|Zenbook|Vivobook|ExpertBook|ProBook|Pavilion|Omen|MateBook|Gram|Galaxy Book/i;
const DESKTOP_COMMERCIAL_MODEL_HINTS =
  /ThinkCentre|ThinkStation|ThinkServer|OptiPlex|Precision|ProDesk|EliteDesk|Z2|Z4|Z6|Z8|NUC|Mini PC|Workstation/i;
const MINI_PC_COMMERCIAL_MODEL_HINTS =
  /ThinkCentre\s+(?:M\d{3,4}[a-z]?q|Tiny)|OptiPlex\s+(?:Micro|Ultra)|ProDesk\s+Mini|EliteDesk\s+Mini|EliteMini|Mini\s+PC|Mini-PC|NUC|NUCBox|BRIX|Cubi|DeskMini|Veriton\s+N|ExpertCenter\s+PN|Chromebox|TinyMiniMicro|USFF|\bMicro\b(?!-)|\bTiny\b|\bNano\b/i;
const MINI_PC_VENDOR_HINTS =
  /Beelink|Minisforum|Geekom|GMKtec|Zotac|Shuttle|ASUS|MSI|Gigabyte|Acer|Dell|HP|Lenovo|Intel/i;
const MINI_PC_MODEL_SERIES_HINTS =
  /\b(?:PN\d{2,4}|SER\d|UM\d|GK\d|GT\d|NUC\d*|NUCBox|BRIX|Cubi|DeskMini|Tiny|Micro|Mini|Nano|USFF|DM\d{2,4})\b/i;
const INTEGRATED_GPU_MODEL_HINTS =
  /Intel.*(?:HD|UHD|Iris(?!\s*(?:Xe\s*Max|Pro))|Xe(?!\s*Max))|Radeon\(TM\)\s+Graphics|Radeon\s+Graphics|Vega\s*(?:3|5|6|7|8|10|11)|Mali|Adreno/i;
const DISCRETE_GPU_MODEL_HINTS =
  /RTX|GTX|MX\d|Arc\s*(?:A|B)|Quadro|Tesla|Titan|GeForce|Radeon\s*(?:RX|Pro|VII)|FirePro/i;

function isWholeDeviceMiniPc(hardware = {}) {
  if (!hardware || !['PC', 'Desktop', 'Mini PC'].includes(hardware.deviceType)) return false;
  const version = String(hardware.version || '').trim();
  const manufacturer = String(hardware.manufacturer || '').trim();
  const formFactor = String(hardware.motherboardFormFactor || '').trim();
  const cpu = String(hardware.cpu || '').trim();
  const combined = [manufacturer, version, formFactor, cpu].filter(Boolean).join(' ');
  return (
    MINI_PC_COMMERCIAL_MODEL_HINTS.test(combined) ||
    (/lenovo/i.test(manufacturer) && /ThinkCentre/i.test(version) && /Mini|Tiny/i.test(formFactor)) ||
    (MINI_PC_VENDOR_HINTS.test(manufacturer) && MINI_PC_MODEL_SERIES_HINTS.test(version)) ||
    /Mini\s?PC|Mini-PC|TinyMiniMicro/i.test(combined) ||
    (/\b(?:micro|tiny|nano|mini|usff)\b/i.test(version) && MINI_PC_VENDOR_HINTS.test(combined)) ||
    (/NUC/i.test(version) && !/Laptop/i.test(cpu))
  );
}

function hasOnlyIntegratedGpu(hardware = {}) {
  const details = Array.isArray(hardware.gpuDetailsList) ? hardware.gpuDetailsList.filter(Boolean) : [];
  if (details.length > 0) {
    const hasDedicated = details.some((entry) => {
      const model = String((entry && entry.model) || '');
      const sharedMemory = !!(entry && entry.sharedMemory);
      const vramGb = Math.max(0, Number(entry && entry.vramGb) || 0);
      return (!sharedMemory && vramGb >= 1) || DISCRETE_GPU_MODEL_HINTS.test(model);
    });
    if (hasDedicated) return false;
    return details.every((entry) => {
      const model = String((entry && entry.model) || '');
      return !!(entry && entry.sharedMemory) || INTEGRATED_GPU_MODEL_HINTS.test(model);
    });
  }

  const gpuModels = Array.isArray(hardware.gpus) ? hardware.gpus.filter(Boolean).map(String) : [];
  if (gpuModels.length === 0) return false;
  if (gpuModels.some((model) => DISCRETE_GPU_MODEL_HINTS.test(model))) return false;
  return gpuModels.every((model) => INTEGRATED_GPU_MODEL_HINTS.test(model));
}

function pickLaptopModelCandidate({
  manufacturer = '',
  systemModel = '',
  systemSku = '',
  systemVersion = '',
  baseboardModel = '',
  baseboardVersion = '',
  isOemPlaceholder = () => false,
} = {}) {
  const normalizedManufacturer = String(manufacturer || '').trim();
  const isLenovoVendor = /lenovo/i.test(normalizedManufacturer);
  const vendorRule = LAPTOP_MODEL_VENDOR_PRIORITIES.find((rule) => rule.pattern.test(normalizedManufacturer));
  const fieldScores = vendorRule ? vendorRule.fieldScores : DEFAULT_LAPTOP_MODEL_FIELD_SCORES;
  const laptopFamilyHints =
    /thinkpad|thinkbook|ideapad|yoga|legion|loq|latitude|xps|inspiron|precision|elitebook|probook|spectre|envy|pavilion|omen|zenbook|vivobook|expertbook|rog|tuf|aspire|swift|travelmate|nitro|predator|surface|matebook|gram|blade|stealth|katana|prestige|summit|galaxy book/i;

  const normalizeCandidate = (value) =>
    String(value || '')
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim();
  const looksLikeLenovoMachineType = (value) => {
    const candidate = normalizeCandidate(value);
    return (
      /^\d{4}[a-z0-9]{3}$/i.test(candidate) ||
      /^lenovo[_ -]*mt[_ -]*[a-z0-9]+$/i.test(candidate) ||
      (/^lenovo[_ -]*[a-z0-9]{4,}$/i.test(candidate) && !laptopFamilyHints.test(candidate))
    );
  };

  const looksLikeFirmwareString = (value, sourceKey) => {
    const candidate = normalizeCandidate(value);
    if (!candidate) return true;
    const lower = candidate.toLowerCase();
    if (isOemPlaceholder(candidate)) return true;
    if (/bios|uefi|firmware/.test(lower)) return true;
    if (/^rev(?:ision)?\s*[a-z0-9._-]+$/i.test(candidate)) return true;
    if (/^v(?:er(?:sion)?)?\s*\d+(?:\.\d+){1,3}$/i.test(candidate)) return true;
    if (/^\d+(?:\.\d+){1,3}$/i.test(candidate)) return true;
    if (/^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/i.test(candidate)) return true;
    if (
      (sourceKey === 'systemVersion' || sourceKey === 'baseboardVersion') &&
      /^[a-z]{1,4}\d{2,}[a-z0-9.-]*$/i.test(candidate) &&
      !laptopFamilyHints.test(candidate)
    )
      return true;
    return false;
  };

  const candidates = [
    { source: 'systemModel', value: systemModel },
    { source: 'systemSku', value: systemSku },
    { source: 'baseboardModel', value: baseboardModel },
    { source: 'baseboardVersion', value: baseboardVersion },
    { source: 'systemVersion', value: systemVersion },
  ];

  let bestCandidate = { value: '', source: '', score: -Infinity };
  for (const entry of candidates) {
    const candidate = normalizeCandidate(entry.value);
    if (!candidate) continue;

    let score = Number(fieldScores[entry.source]) || 0;
    if (looksLikeFirmwareString(candidate, entry.source)) score -= 250;
    if (candidate.length < 4) score -= 40;
    if (laptopFamilyHints.test(candidate)) score += 45;
    if (normalizedManufacturer && candidate.toLowerCase().includes(normalizedManufacturer.toLowerCase())) score += 15;
    if (/^[a-z]{2,}\d{2,}[a-z0-9-]*$/i.test(candidate) && entry.source === 'systemSku') score += 10;
    if (!/^[a-z0-9][a-z0-9 ._()/+-]*$/i.test(candidate)) score -= 20;
    if (isLenovoVendor && looksLikeLenovoMachineType(candidate) && !laptopFamilyHints.test(candidate)) score -= 120;
    if (
      isLenovoVendor &&
      laptopFamilyHints.test(candidate) &&
      (entry.source === 'systemVersion' || entry.source === 'baseboardModel' || entry.source === 'baseboardVersion')
    )
      score += 220;

    if (score > bestCandidate.score) {
      bestCandidate = { value: candidate, source: entry.source, score };
    }
  }

  if (!bestCandidate.value || bestCandidate.score < 0) {
    return { value: '', source: '', score: bestCandidate.score };
  }

  return bestCandidate;
}

function pickDesktopModelCandidate({
  manufacturer = '',
  systemModel = '',
  systemVersion = '',
  baseboardModel = '',
  isOemPlaceholder = () => false,
} = {}) {
  const normalizeCandidate = (value) =>
    String(value || '')
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim();
  const candidates = [
    { source: 'systemModel', value: systemModel, score: 150 },
    { source: 'systemVersion', value: systemVersion, score: 90 },
    { source: 'baseboardModel', value: baseboardModel, score: 20 },
  ];

  let bestCandidate = { value: '', source: '', score: -Infinity };
  for (const entry of candidates) {
    const candidate = normalizeCandidate(entry.value);
    if (!candidate || isOemPlaceholder(candidate)) continue;

    let score = entry.score;
    if (DESKTOP_COMMERCIAL_MODEL_HINTS.test(candidate)) score += 140;
    if (/^\d{3,}[a-z]?$/i.test(candidate)) score -= 120;
    if (/^[a-z]{1,6}\d{2,}[a-z0-9-]*$/i.test(candidate) && !DESKTOP_COMMERCIAL_MODEL_HINTS.test(candidate)) score -= 80;
    if (/^lenovo[_ -]*mt[_ -]*[a-z0-9]+$/i.test(candidate)) score -= 180;
    if (/^thinkcentre\b|^thinkstation\b|^thinkserver\b/i.test(candidate) && /lenovo/i.test(manufacturer)) score += 60;

    if (score > bestCandidate.score) {
      bestCandidate = { value: candidate, source: entry.source, score };
    }
  }

  if (!bestCandidate.value || bestCandidate.score < 0) {
    return { value: '', source: '', score: bestCandidate.score };
  }

  return bestCandidate;
}

// Hardware recognition (Electron or browser)
async function getHardwareInfo() {
  if (window.wattcoinHardware && window.wattcoinHardware.getSystemInfo) {
    // Use Electron preload API for precise info
    try {
      const sys = await window.wattcoinHardware.getSystemInfo();
      const logicalCores = Math.max(1, Number(sys.cpu && sys.cpu.cores) || 1);
      const physicalCores = Math.max(1, Number(sys.cpu && sys.cpu.physicalCores) || logicalCores);
      const cpuSockets = Math.max(1, Number(sys.cpu && sys.cpu.processors) || 1);
      const cpu =
        sys.cpu && sys.cpu.brand
          ? `${sys.cpu.brand} (${logicalCores} logical cores${cpuSockets > 1 ? `, ${cpuSockets} CPUs` : ''})`
          : 'Unknown';
      let gpu = sys.gpu.model || 'Unknown';
      // Collect all GPU models for multi-GPU support
      let gpus =
        Array.isArray(sys.gpus) && sys.gpus.length > 0
          ? sys.gpus.filter((g) => g && g.model).map((g) => g.model)
          : gpu !== 'Unknown'
            ? [gpu]
            : [];
      // Build detailed GPU list: include VRAM size and GDDR type for dedicated GPUs.
      // Skip entries where vramDynamic=true (shared/integrated memory) for VRAM display.
      let gpuDetailsList = (
        Array.isArray(sys.gpus) && sys.gpus.length > 0 ? sys.gpus : sys.gpu && sys.gpu.model ? [sys.gpu] : []
      )
        .filter((g) => g && g.model)
        .map((g) => {
          const vramMb = Number(g.vram) || 0;
          const isDynamic = !!g.vramDynamic;
          const vramGb = !isDynamic && vramMb >= 512 ? Math.round(vramMb / 1024) : 0;
          const memType = String(g.memoryType || '')
            .trim()
            .toUpperCase();
          return { model: g.model, vramGb, memType, sharedMemory: isDynamic };
        });
      // Show both total and type for memory
      const memTotalGB = sys.mem.total ? sys.mem.total / 1024 ** 3 : 0;
      let memType = '';
      let memSpeedMhz = 0;
      let memSticks = 0;
      if (Array.isArray(sys.memLayout) && sys.memLayout.length > 0) {
        const types = sys.memLayout
          .map((m) =>
            String(m.type || '')
              .replace(/\s+/g, '')
              .toUpperCase(),
          )
          .filter((t) => t && t !== 'UNKNOWN' && t !== '');
        if (types.length > 0) {
          const typeCount = {};
          types.forEach((t) => {
            typeCount[t] = (typeCount[t] || 0) + 1;
          });
          memType = Object.entries(typeCount).sort((a, b) => b[1] - a[1])[0][0];
        }
        // Memory speed: take the max clockSpeed across populated sticks
        for (const m of sys.memLayout) {
          const spd = Number(m.clockSpeed) || 0;
          if (spd > 0) memSpeedMhz = Math.max(memSpeedMhz, spd);
        }
        // Count populated sticks (size > 0)
        memSticks = sys.memLayout.filter((m) => Number(m.size) > 0).length;
      }
      const memory =
        memTotalGB > 0
          ? `${memTotalGB.toFixed(1)} GB${memType ? ' ' + memType : ''}${memSpeedMhz > 0 ? ' ' + memSpeedMhz + ' MHz' : ''}`
          : 'Unknown';
      // Helper: detect BIOS/SMBIOS OEM placeholder strings
      const isOemPlaceholder = (val) => {
        if (!val) return true;
        const s = String(val).trim().toLowerCase();
        return (
          s.startsWith('to be filled') ||
          s === 'default string' ||
          s === 'system product name' ||
          s === 'not specified' ||
          s === 'not applicable' ||
          s === 'none' ||
          s === 'n/a'
        );
      };
      // Manufacturer/version: prefer system info, fall back to baseboard when OEM placeholder
      const rawSysModel = sys.system && sys.system.model ? sys.system.model : '';
      const rawSysSku = sys.system && sys.system.sku ? sys.system.sku : '';
      const rawSysMfr = sys.system && sys.system.manufacturer ? sys.system.manufacturer : '';
      const rawSysVer = sys.system && sys.system.version ? sys.system.version : '';
      const rawBoardMfr = sys.baseboard && sys.baseboard.manufacturer ? sys.baseboard.manufacturer : '';
      const rawBoardModel = sys.baseboard && sys.baseboard.model ? sys.baseboard.model : '';
      const rawBoardVer = sys.baseboard && sys.baseboard.version ? sys.baseboard.version : '';
      const boardManufacturer = !isOemPlaceholder(rawBoardMfr) ? rawBoardMfr : '';
      const boardModel = !isOemPlaceholder(rawBoardModel)
        ? rawBoardModel
        : !isOemPlaceholder(rawBoardVer)
          ? rawBoardVer
          : '';
      const laptopModelCandidate = pickLaptopModelCandidate({
        manufacturer: rawSysMfr || rawBoardMfr,
        systemModel: rawSysModel,
        systemSku: rawSysSku,
        systemVersion: rawSysVer,
        baseboardModel: rawBoardModel,
        baseboardVersion: rawBoardVer,
        isOemPlaceholder,
      });
      const desktopModelCandidate = pickDesktopModelCandidate({
        manufacturer: rawSysMfr || rawBoardMfr,
        systemModel: rawSysModel,
        systemVersion: rawSysVer,
        baseboardModel: rawBoardModel,
        isOemPlaceholder,
      });
      const chassisType = String(sys.chassis && sys.chassis.type ? sys.chassis.type : '').trim();
      // Build model string for device type detection using filtered values
      const modelStr = [
        !isOemPlaceholder(rawSysModel) ? rawSysModel : laptopModelCandidate.value || '',
        !isOemPlaceholder(rawSysMfr) ? rawSysMfr : !isOemPlaceholder(rawBoardMfr) ? rawBoardMfr : '',
      ]
        .join(' ')
        .trim();
      console.log(
        '[Wattcoin] Model:',
        rawSysModel,
        '| SysSku:',
        rawSysSku,
        '| SysVer:',
        rawSysVer,
        '| SysMfr:',
        rawSysMfr,
        '| BoardMfr:',
        rawBoardMfr,
        '| BoardModel:',
        rawBoardModel,
        '| BoardVer:',
        rawBoardVer,
        '| Chassis:',
        chassisType,
        '| ModelStr:',
        modelStr,
        '| LaptopModel:',
        laptopModelCandidate.value,
        '| LaptopModelSource:',
        laptopModelCandidate.source,
      );
      const LAPTOP_CHASSIS_CODES = ['8', '9', '10', '14'];
      let deviceType = 'Unknown';
      if (
        /notebook|laptop|portable/i.test(chassisType) ||
        LAPTOP_CHASSIS_CODES.includes(chassisType) ||
        LAPTOP_COMMERCIAL_MODEL_HINTS.test(modelStr)
      ) {
        deviceType = 'Laptop';
      } else if (/server/i.test(chassisType) || /Server/i.test(modelStr)) {
        deviceType = 'Server';
      } else if (sys.system && sys.system.virtual) {
        deviceType = 'PC';
      } else if (boardManufacturer || boardModel || /PC|Desktop|Workstation|Tower|NUC|Mini/i.test(modelStr)) {
        deviceType = 'PC';
      }
      // Always use OS platform as authoritative fallback when model strings don't identify the form factor
      const osPlatform = sys.os && sys.os.platform ? sys.os.platform : '';
      if (deviceType === 'Unknown') {
        if (osPlatform === 'darwin') deviceType = 'Mac';
        else if (osPlatform === 'win32' || osPlatform === 'linux') deviceType = 'PC';
      }
      // Board form factor: N/A for laptops and Macs; detect for desktops/servers.
      // Custom-build boards (e.g. "ROG STRIX Z790-E") rarely expose an ATX/ITX
      // keyword in SMBIOS, so fall back to "Manufacturer  Model" as a label.
      const rawFormFactor =
        deviceType === 'Laptop' || deviceType === 'Mac'
          ? 'N/A'
          : detectMotherboardFormFactor(
              rawBoardModel,
              rawBoardVer,
              sys.system && sys.system.model,
              sys.system && sys.system.version,
              sys.system && sys.system.sku,
              chassisType,
            );
      const motherboardFormFactor = rawFormFactor || [boardManufacturer, boardModel].filter(Boolean).join(' ') || '';
      const manufacturer =
        deviceType === 'PC'
          ? boardManufacturer || (!isOemPlaceholder(rawSysMfr) ? rawSysMfr : 'Unknown')
          : !isOemPlaceholder(rawSysMfr)
            ? rawSysMfr
            : boardManufacturer || 'Unknown';
      const version =
        deviceType === 'PC'
          ? desktopModelCandidate.value || boardModel || (!isOemPlaceholder(rawSysVer) ? rawSysVer : 'Unknown')
          : laptopModelCandidate.value || 'Unknown';
      if (
        deviceType === 'PC' &&
        isWholeDeviceMiniPc({
          deviceType,
          manufacturer,
          version,
          motherboardFormFactor,
          cpu,
        })
      ) {
        deviceType = 'Mini PC';
      }
      // On desktop PCs, filter out integrated/motherboard GPUs (e.g. Intel HD/UHD,
      // Radeon Graphics on CPU) so only dedicated GPUs are counted and spawned.
      if (deviceType === 'PC' && gpuDetailsList.length > 0) {
        const dedicatedEntryIndices = [];
        gpuDetailsList.forEach((entry, idx) => {
          const model = String((entry && entry.model) || '');
          const sharedMemory = !!(entry && entry.sharedMemory);
          const vramGb = Math.max(0, Number(entry && entry.vramGb) || 0);
          if ((!sharedMemory && vramGb >= 1) || DISCRETE_GPU_MODEL_HINTS.test(model)) {
            dedicatedEntryIndices.push(idx);
          }
        });
        if (dedicatedEntryIndices.length > 0) {
          gpuDetailsList = dedicatedEntryIndices.map((i) => gpuDetailsList[i]);
          gpus = dedicatedEntryIndices.map((i) => gpus[i]).filter(Boolean);
          gpu = gpus[0] || 'Unknown';
        } else {
          gpuDetailsList = [];
          gpus = [];
          gpu = 'Unknown';
        }
      }
      const osName = sys.os && sys.os.distro ? sys.os.distro : sys.os && sys.os.platform ? sys.os.platform : 'Unknown';
      return {
        deviceType,
        manufacturer,
        version,
        modelSource:
          deviceType === 'Laptop'
            ? laptopModelCandidate.source
            : deviceType === 'Mini PC'
              ? desktopModelCandidate.source
              : '',
        motherboardFormFactor,
        cpu,
        logicalCores,
        physicalCores,
        cpuSockets,
        gpu,
        gpus,
        gpuDetailsList,
        memory,
        memTotalGB,
        memSpeedMhz,
        memSticks,
        osName,
        source: 'electron',
      };
    } catch (e) {
      console.warn('[Wattcoin] Electron hardware info failed, falling back to browser', e);
    }
  }
  // Fallback: browser-based detection
  const nav = window.navigator;
  const ua = nav.userAgent || '';
  const logicalCores = Math.max(1, Number(nav.hardwareConcurrency) || 1);
  const cpu = `${logicalCores} logical cores`;
  let gpu = (() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        return gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
      }
    }
    return 'Unknown';
  })();
  gpu = gpu.replace(/\(0x[0-9a-fA-F]+\) Direct3D11 vs_5_0 ps_5_0, D3D11/, '').trim();
  const memory = nav.deviceMemory ? `${nav.deviceMemory} GB` : 'Unknown';
  let deviceType = 'Unknown';
  if (
    /ThinkPad|ThinkBook|IdeaPad|Yoga|Legion|LOQ/i.test(ua) ||
    (window &&
      window.external &&
      window.external.GetSystemModel &&
      /ThinkPad|ThinkBook|IdeaPad|Yoga|Legion|LOQ/i.test(window.external.GetSystemModel()))
  ) {
    deviceType = 'Laptop (Lenovo ThinkPad)';
  } else if (/CrOS/.test(ua)) deviceType = 'Chromebook';
  else if (/Android/.test(ua)) deviceType = 'Android Device';
  else if (/iPhone|iPad|iPod/.test(ua)) deviceType = 'iOS Device';
  else if (/Macintosh|Mac OS X/.test(ua)) deviceType = 'Mac';
  else if (MINI_PC_COMMERCIAL_MODEL_HINTS.test(ua)) deviceType = 'Mini PC';
  else if (/Windows/.test(ua)) deviceType = 'PC';
  else if (/Linux/.test(ua)) deviceType = 'Linux PC';
  if (
    (deviceType === 'PC' || deviceType === 'Mac' || deviceType === 'Linux PC') &&
    deviceType !== 'Laptop (Lenovo ThinkPad)'
  ) {
    if (nav.getBattery) {
      nav.getBattery().then((bat) => {
        if (bat.charging !== undefined) {
          if (bat.charging || bat.level < 1) deviceType = 'Laptop';
        }
      });
    } else if (
      /Laptop|Notebook|Mobile|Portable|ThinkPad|ThinkBook|IdeaPad|Yoga|Legion|LOQ|Ultrabook|Zenbook|MacBook|XPS|Latitude|EliteBook|Spectre|Surface|Aspire|Chromebook/i.test(
        ua,
      )
    ) {
      deviceType = 'Laptop';
    }
  }
  if (/Antminer|Whatsminer|ASIC/i.test(gpu)) deviceType = 'ASIC';
  const gpus = gpu !== 'Unknown' ? [gpu] : [];
  return {
    deviceType,
    manufacturer: 'Unknown',
    version: 'Unknown',
    motherboardFormFactor: '',
    cpu,
    logicalCores,
    physicalCores: logicalCores,
    cpuSockets: 1,
    gpu,
    gpus,
    gpuDetailsList: gpus.map((m) => ({ model: m, vramGb: 0, memType: '' })),
    memory,
    memTotalGB: Number(nav.deviceMemory) || 0,
    osName: 'browser',
    source: 'browser',
  };
}

// ─── Memory bandwidth expected values ─────────────────────────────────────────
// Returns expected sequential bandwidth in MB/s for the declared memory spec.
// Formula: channels × speedMhz × 8 bytes (64-bit bus) × efficiency_factor.
// Node.js sequential bench achieves ~55% of theoretical peak, so efficiency=0.55.
// Called with hardware.memType (DDR4/DDR5/LPDDR5…), memSpeedMhz, and memSticks.
function getExpectedMemBandwidthMBps(memType, memSpeedMhz, memSticks) {
  if (!memSpeedMhz || memSpeedMhz <= 0) return 0;
  // Infer channel count: ≥2 sticks usually implies dual-channel for DDR4/DDR5.
  // LPDDR is always one "virtual channel" per package (spec-defined 128-bit bus treats as 2 ch).
  const isLPDDR = /LPDDR/i.test(memType || '');
  const _isDDR5 = /DDR5/i.test(memType || '');
  let channels = isLPDDR ? 2 : memSticks >= 2 ? 2 : 1;
  // DDR4/5: bus width = 64 bits = 8 bytes per transfer; speed in MT/s
  const theoreticalMBps = channels * memSpeedMhz * 8; // MT/s × 8 B = MB/s
  const efficiency = 0.25; // fraction of theoretical peak reported by this bench.
  // Stride-64 writes cause a read-for-ownership per cache line,
  // so actual DRAM traffic is 2× the buffer size, but we only
  // count bytes written.  V8 vs native adds further overhead.
  // Derivation: 65% peak × 50% RFO factor × 80% V8 ≈ 26%,
  // round down to 0.25 — applies universally across all DDR types.
  return Math.round(theoreticalMBps * efficiency);
}

// ─── WebGL GPU benchmark ───────────────────────────────────────────────────────
// Runs a compute-heavy fragment shader on a DOM canvas temporarily attached to
// document.body.  Attaching it ensures Chromium/Electron routes WebGL through the
// HW GPU compositor rather than SwiftShader (which OffscreenCanvas may use when
// the context is never composited).
// Returns { score, framesRendered, elapsedMs } or null when WebGL is unavailable.
// "score" = frames × SIZE² × C_OPS / elapsedMs — ALU-ops-per-ms metric.
async function runWebGLBenchmark() {
  // Inner helper: runs the full shader benchmark on an already-created WebGL2 context.
  // Returns { score, framesRendered, elapsedMs } or { error } (shader compile/link fail or
  // calibMs < 0.1 — pipeline did not drain, context is no-op or software-rendered).
  function _bench(gl, SIZE) {
    const vsSource = `#version 300 es
      in vec2 aPos;
      void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
    `;
    // 256 dependent MAD iterations per pixel — hard to optimise away.
    const fsSource = `#version 300 es
      precision highp float;
      uniform float uSeed;
      out vec4 fragColor;
      void main() {
        vec4 c = vec4(gl_FragCoord.xy / ${SIZE}.0, uSeed, 1.0 - uSeed);
        for (int i = 0; i < 256; i++) {
          c.x = c.x * c.y + c.z * 0.00013;
          c.y = c.y * c.z + c.w * 0.00017;
          c.z = c.z * c.w + c.x * 0.00019;
          c.w = c.w * c.x + c.y * 0.00023;
        }
        fragColor = c;
      }
    `;

    const compileShader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        gl.deleteShader(s);
        return null;
      }
      return s;
    };
    const vs = compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return { error: 'GPU-E1: shader compile failed' };

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { error: 'GPU-E2: shader link failed' };
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const aPosLoc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPosLoc);
    gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);
    const uSeedLoc = gl.getUniformLocation(prog, 'uSeed');

    // GPU sync: full-framebuffer readPixels per frame.
    // readPixels on the full 512×512 render target MUST return real pixel data —
    // the driver cannot skip the GPU work without producing wrong pixel values.
    // Per-frame sync (not batched) ensures each frame's GPU work is individually
    // timed, giving a score that reflects real pipeline throughput.
    const SYNC_W = SIZE,
      SYNC_H = SIZE;
    const syncBuf = new Uint8Array(SYNC_W * SYNC_H * 4);
    function gpuSync() {
      gl.readPixels(0, 0, SYNC_W, SYNC_H, gl.RGBA, gl.UNSIGNED_BYTE, syncBuf);
    }

    // Warmup: 5 frames with per-frame sync to JIT shaders and warm caches.
    for (let i = 0; i < 5; i++) {
      gl.uniform1f(uSeedLoc, i * 0.001);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gpuSync();
    }

    // Adaptive calibration: render frames one-at-a-time with per-frame sync
    // until at least MIN_CALIB_MS of real GPU wall-time has accumulated.
    // Cap at 200 frames to bound calibration time on slow GPUs.
    const MIN_CALIB_MS = 20;
    let calibFrames = 0;
    const tCalib0 = performance.now();
    do {
      gl.uniform1f(uSeedLoc, 0.5 + calibFrames * 0.001);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gpuSync();
      calibFrames++;
    } while (performance.now() - tCalib0 < MIN_CALIB_MS && calibFrames < 200);
    const calibMs = performance.now() - tCalib0;
    // Safety: if 200 frames finished in < 1 ms, readPixels is not stalling.
    if (calibMs < 1.0 && calibFrames >= 200) {
      console.warn('[GPU benchmark] readPixels not stalling (200 frames in ' + calibMs.toFixed(2) + 'ms)');
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
      return { error: 'GPU-E3: readPixels not stalling (' + calibMs.toFixed(2) + 'ms / 200 frames)' };
    }
    const msPerFrame = Math.max(0.01, calibMs / calibFrames);

    // Choose frame count to target ~1000 ms of GPU work; clamp to 5–1000 frames.
    const targetFrames = Math.min(1000, Math.max(5, Math.round(1000 / msPerFrame)));

    // Benchmark pass: per-frame sync.
    const t0 = performance.now();
    for (let i = 0; i < targetFrames; i++) {
      gl.uniform1f(uSeedLoc, i * 0.001);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gpuSync();
    }
    const elapsedMs = Math.max(1, performance.now() - t0);

    gl.deleteProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    gl.deleteBuffer(buf);

    // Score: ALU ops executed per ms (normalised).
    // 256 iterations × 4 MAD = 1024 effective FP32 ops per pixel per frame.
    const opsPerFrame = SIZE * SIZE * 1024;
    const score = Math.round((targetFrames * opsPerFrame) / elapsedMs); // ops/ms
    return { score, framesRendered: targetFrames, elapsedMs: Math.round(elapsedMs) };
  }

  const SIZE = 512; // larger render target → more work per draw call

  // DOM canvas only — routed via the hardware GPU compositor, same path as
  // runGpuBenchmarkProof (confirmed working on dedicated GPUs).
  // OffscreenCanvas is intentionally skipped: it bypasses the compositor, which
  // makes readPixels pipeline-sync unreliable on ANGLE/D3D11 drivers — the GPU
  // work may not stall the CPU even with a 16×16 read, causing 200-frame calibration
  // cap to trip and _bench to return null even on real discrete hardware.
  let domCanvas = null;
  let domAttached = false;
  try {
    domCanvas = document.createElement('canvas');
    domCanvas.width = SIZE;
    domCanvas.height = SIZE;
    domCanvas.style.cssText =
      'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;pointer-events:none;opacity:0.001;';
    try {
      document.body.appendChild(domCanvas);
      domAttached = true;
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
    }
    const gl = domCanvas.getContext('webgl2');
    if (!gl) return { error: 'GPU-E5: no webgl2 context' };
    return await _bench(gl, SIZE);
  } catch (e) {
    console.warn('[GPU benchmark] failed:', e && e.message);
    return { error: 'GPU-E6: exception (' + ((e && e.message) || 'unknown') + ')' };
  } finally {
    if (domAttached && domCanvas) {
      try {
        document.body.removeChild(domCanvas);
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }
    }
  }
}

// ─── GPU probe ────────────────────────────────────────────────────────────────
// Single-frame WebGL render used by the mining probe system.
// Unlike runWebGLBenchmark (which uses gl.finish() to time many frames),
// this function uses gl.readPixels() which GUARANTEES synchronous GPU completion —
// the call blocks until all pending GPU work is done, giving an accurate elapsed time.
//
// Item 3: Uses a pure-integer XOR-shift shader (WebGL2 required) so the coordinator
// can recompute the expected pixelHash in pure Node.js — bit-identical to the GPU
// output because GLSL ES 3.0 `int` is defined two's-complement 32-bit, matching JS.
// Falls back to the original float shader on WebGL1 (timing-only verification then).
//
// Standalone CPU probe computation — module-level function so V8 can permanently optimize
// it with TurboFan, avoiding baseline-compiler-only execution inside async context.
// Synchronous CPU probe computation — module-level standalone function so V8 can
// permanently optimize it with TurboFan.  Called twice: first as warmup with
// a small iteration count to trigger compilation, then for the real measurement.
let _cpuProbeCallCount = 0;
function runCpuProbe(seed, iterations, recordChunks) {
  _cpuProbeCallCount++;
  let x = seed | 0 || 1;
  const N = iterations | 0;
  const chunks = recordChunks ? [] : null;
  const CHUNK = 25000000;
  let prev = performance.now();
  for (let chunkStart = 0; chunkStart < N; chunkStart += CHUNK) {
    const chunkEnd = Math.min(chunkStart + CHUNK, N);
    for (let i = chunkStart; i < chunkEnd; i++) {
      x = (Math.imul(x, 48271) + 9973) | 0;
      x ^= x << 13;
      x ^= x >> 17;
      x ^= x << 5;
      x &= 0x7fffffff;
    }
    if (chunks) {
      const now = performance.now();
      chunks.push(Math.round((now - prev) * 10) / 10);
      prev = now;
    }
  }
  return { proof: (x >>> 0).toString(16).padStart(8, '0'), chunks };
}

// Returns { pixelHash, elapsedMs, integerShader } or null when WebGL unavailable.
function runGpuProbe(seed, size, shaderIterations) {
  let canvas = null;
  let attached = false;
  try {
    canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.style.cssText =
      'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;pointer-events:none;opacity:0.001;';
    try {
      document.body.appendChild(canvas);
      attached = true;
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
    }

    // Prefer WebGL2 for the integer-shader path (item 3).
    const gl2 = canvas.getContext('webgl2');
    const gl = gl2 || canvas.getContext('webgl');
    if (!gl) {
      console.error('[runGpuProbe] No WebGL context');
      return null;
    }
    const useIntShader = !!gl2;

    // Vertex shader MUST match the GLSL version of the fragment shader.
    // WebGL2 programs require both shaders to use the same GLSL version;
    // mixing a GLSL 1.00 vertex shader (no directive, `attribute`) with a
    // GLSL 3.00 fragment shader (`#version 300 es`, `out`) silently fails to
    // link — the root cause of "no pixel hash returned" on WebGL2 drivers.
    const vsSource = useIntShader
      ? `#version 300 es\nin vec2 aPos;\nvoid main() { gl_Position = vec4(aPos, 0.0, 1.0); }`
      : `attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

    // Integer shader (WebGL2): deterministic 32-bit XOR-shift per pixel.
    // Coordinator can verify in pure JS with computeGpuProbeExpectedHash().
    // uSeedInt is a uniform int; seed values are constrained to [1, 0x7FFFFFFF] at probe issuance.
    // Pack all 32 bits of x across RGBA so the GPU compiler cannot dead-eliminate
    // any XOR-shift iterations based on the observation that only low bits are used.
    // R=bits31-24, G=bits23-16, B=bits15-8, A=bits7-0. Hash loop reads all 4 channels.
    const fsSourceInt = `#version 300 es\n      precision highp int;\n      precision highp float;\n      uniform int uSeedInt;\n      out vec4 fragColor;\n      void main() {\n        int px = int(gl_FragCoord.x);\n        int py = int(gl_FragCoord.y);\n        int x = (px * 1000003) ^ (py * 7919) ^ uSeedInt;\n        x |= 1;\n        for (int i = 0; i < ${shaderIterations}; i++) {\n          x ^= x << 13;\n          x ^= x >> 17;\n          x ^= x << 5;\n        }\n        fragColor = vec4(\n          float((x >> 24) & 255) / 255.0,\n          float((x >> 16) & 255) / 255.0,\n          float((x >>  8) & 255) / 255.0,\n          float( x        & 255) / 255.0);\n      }\n    `;

    // Float shader fallback (WebGL1): original algorithm, timing-only verification.
    const fsSourceFloat = `\n      precision highp float;\n      uniform float uSeed;\n      void main() {\n        vec4 c = vec4(gl_FragCoord.xy / ${size}.0, uSeed, 1.0 - uSeed);\n        for (int i = 0; i < ${shaderIterations}; i++) {\n          c.x = c.x * c.y + c.z * 0.00013;\n          c.y = c.y * c.z + c.w * 0.00017;\n          c.z = c.z * c.w + c.x * 0.00019;\n          c.w = c.w * c.x + c.y * 0.00023;\n        }\n        gl_FragColor = c;\n      }\n    `;

    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const err = gl.getShaderInfoLog(sh);
        console.error('[runGpuProbe] Shader compile failed:', err, src);
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, vsSource);
    const fs = compile(gl.FRAGMENT_SHADER, useIntShader ? fsSourceInt : fsSourceFloat);
    if (!vs || !fs) {
      console.error('[runGpuProbe] Shader compile returned null');
      return null;
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const err = gl.getProgramInfoLog(prog);
      console.error('[runGpuProbe] Program link failed:', err);
      return null;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    // WebGL2: bind an explicit VAO so vertex state is self-contained. On strict
    // ANGLE/D3D11 drivers, a deleted buffer still referenced by the default VAO can
    // silently corrupt subsequent draw calls (same issue noted in runGpuBenchmarkProof).
    let vao = null;
    if (useIntShader) {
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
    }
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    if (useIntShader) {
      // Pass seed as signed integer — constrained to [1, 0x7FFFFFFF] at probe issuance.
      gl.uniform1i(gl.getUniformLocation(prog, 'uSeedInt'), seed | 0 || 1);
    } else {
      gl.uniform1f(gl.getUniformLocation(prog, 'uSeed'), (seed >>> 0) / 0xffffffff);
    }
    gl.viewport(0, 0, size, size);

    // Render and force synchronous completion via readPixels.
    const pixels = new Uint8Array(size * size * 4);
    const t0 = performance.now();
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels); // blocks until done
    if (gl.finish) gl.finish(); // Force GPU-CPU sync to prevent driver optimization
    const elapsed = performance.now() - t0;

    // Hash: every 4th pixel, all 4 channels (full 32-bit x packed as RGBA) through djb2.
    // Using all channels prevents GPU compiler from dead-eliminating high-bit shader work.
    // This EXACT loop must match computeGpuProbeExpectedHash in backend-benchmark.js.
    let h = 5381;
    let allZero = true;
    for (let i = 0; i < pixels.length; i += 16) {
      if (pixels[i] !== 0 || pixels[i + 1] !== 0 || pixels[i + 2] !== 0 || pixels[i + 3] !== 0) allZero = false;
      h = ((h << 5) + h + pixels[i]) | 0; // R = bits 31–24
      h = ((h << 5) + h + pixels[i + 1]) | 0; // G = bits 23–16
      h = ((h << 5) + h + pixels[i + 2]) | 0; // B = bits 15–8
      h = ((h << 5) + h + pixels[i + 3]) | 0; // A = bits 7–0
    }
    // Clean up GL resources — prevents per-probe leaks on long-running sessions.
    // Matches the cleanup pattern in runGpuBenchmarkProof.
    if (vao) {
      gl.bindVertexArray(null);
      gl.deleteVertexArray(vao);
    }
    gl.deleteProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    gl.deleteBuffer(buf);

    if (allZero) {
      console.error('[runGpuProbe] All pixels zero after readPixels');
      return null;
    }
    return {
      pixelHash: (h >>> 0).toString(16).padStart(8, '0'),
      elapsedMs: Math.round(elapsed),
      integerShader: useIntShader,
    };
  } catch (err) {
    console.error('[runGpuProbe] Exception:', err);
    return null;
  } finally {
    if (attached && canvas && canvas.parentNode) {
      try {
        canvas.parentNode.removeChild(canvas);
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }
    }
  }
}

// ─── GPU benchmark proof ──────────────────────────────────────────────────────
// Runs a single deterministic integer-shader render keyed by `seed` and returns
// a proof hash that the Node process can independently verify using pure JS
// (computeGpuProbeExpectedHash in backend-benchmark.js — bit-identical to this hash
// because GLSL ES 3.0 `int` is defined two's-complement 32-bit, matching JS |0).
//
// Uses a DOM canvas (not OffscreenCanvas) so Chromium routes rendering through the
// hardware GPU compositor instead of the SwiftShader software rasteriser.
// Requires WebGL2 for the integer shader path; returns null on WebGL1 / no WebGL.
//
// The pixel hash algorithm is IDENTICAL to the hash loop in runGpuProbe — every 4th
// pixel, all 4 RGBA channels (full 32-bit x) fed into a djb2 accumulator — so both use the same verification.
const GPU_PROOF_SIZE = 128; // 128×128 pixels — fast but sufficient for a unique hash
const GPU_PROOF_ITERS = 32; // 32 XOR-shift iterations per pixel
function runGpuBenchmarkProof(seed, size, shaderIterations) {
  let canvas = null;
  let attached = false;
  try {
    canvas = document.createElement('canvas');
    // Size to 512 up front so the post-proof MAD benchmark can use the full viewport
    // without resizing the canvas. Resizing canvas.width/height resets WebGL context
    // state (and causes context loss on some AMD/Intel drivers), which silently
    // discards all shader programs and makes the embedded benchmark return gpuScore=0.
    // The proof render uses gl.viewport(0, 0, size, size) so its hash is unaffected.
    canvas.width = 512;
    canvas.height = 512;
    canvas.style.cssText =
      'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;pointer-events:none;opacity:0.001;';
    try {
      document.body.appendChild(canvas);
      attached = true;
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
    }

    const gl = canvas.getContext('webgl2');
    if (!gl) return null; // integer shader requires WebGL2 for Node-verifiability

    // Both shaders MUST use the same GLSL ES version.  In WebGL 2, mixing a
    // no-directive (1.00) vertex shader with a '#version 300 es' fragment shader
    // causes the program to fail linking silently.
    const vsSource = `#version 300 es
      in vec2 aPos;
      void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
    `;
    // Integer XOR-shift shader — MUST match computeGpuProbeExpectedHash in backend-benchmark.js.
    const fsSource = `#version 300 es
      precision highp int;
      precision highp float;
      uniform int uSeedInt;
      out vec4 fragColor;
      void main() {
        int px = int(gl_FragCoord.x);
        int py = int(gl_FragCoord.y);
        int x = (px * 1000003) ^ (py * 7919) ^ uSeedInt;
        x |= 1;
        for (int i = 0; i < ${shaderIterations}; i++) {
          x ^= x << 13;
          x ^= x >> 17;
          x ^= x << 5;
        }
        fragColor = vec4(
          float((x >> 24) & 255) / 255.0,
          float((x >> 16) & 255) / 255.0,
          float((x >>  8) & 255) / 255.0,
          float( x        & 255) / 255.0);
      }
    `;

    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, vsSource);
    const fs = compile(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return null;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'uSeedInt'), seed | 0 || 1);
    gl.viewport(0, 0, size, size);

    const pixels = new Uint8Array(size * size * 4);
    const t0 = performance.now();
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels); // blocks until done
    const elapsed = performance.now() - t0;

    // Reject all-zero results — render didn't actually execute on the GPU.
    // Check all 4 channels: R holds bits 31–24 which may legitimately be 0 for some seeds.
    let allZero = true;
    for (let i = 0; i < pixels.length; i += 64) {
      if (pixels[i] !== 0 || pixels[i + 1] !== 0 || pixels[i + 2] !== 0 || pixels[i + 3] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) return null;

    // Unbind and delete the proof VAO before proceeding. The active VAO references
    // `buf` which is about to be deleted. On strict ANGLE/D3D11 drivers, keeping a
    // deleted buffer referenced by the active VAO causes all subsequent draw calls
    // to silently fail, making the embedded MAD benchmark produce gpuScore=0.
    gl.bindVertexArray(null);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    gl.deleteBuffer(buf);

    // Hash: every 4th pixel, all 4 channels (full 32-bit x) through djb2 — identical to runGpuProbe.
    let h = 5381;
    for (let i = 0; i < pixels.length; i += 16) {
      h = ((h << 5) + h + pixels[i]) | 0; // R = bits 31–24
      h = ((h << 5) + h + pixels[i + 1]) | 0; // G = bits 23–16
      h = ((h << 5) + h + pixels[i + 2]) | 0; // B = bits 15–8
      h = ((h << 5) + h + pixels[i + 3]) | 0; // A = bits 7–0
    }

    // Float MAD benchmark: run on this same canvas so GPU score is available even
    // when runWebGLBenchmark fails (e.g. OffscreenCanvas or readPixels drain issues).
    // Uses the identical shader and formula as runWebGLBenchmark._bench.
    const BENCH_SIZE = 512;
    let gpuScore = 0;
    let benchError = null;
    try {
      // Canvas is already 512×512 (sized at creation) — only reset the viewport.
      gl.viewport(0, 0, BENCH_SIZE, BENCH_SIZE);
      const vsBSrc = `#version 300 es\nin vec2 aPos;\nvoid main(){gl_Position=vec4(aPos,0.0,1.0);}`;
      const fsBSrc = `#version 300 es\nprecision highp float;\nuniform float uSeed;\nout vec4 fragColor;\nvoid main(){\n  vec4 c=vec4(gl_FragCoord.xy/${BENCH_SIZE}.0,uSeed,1.0-uSeed);\n  for(int i=0;i<256;i++){\n    c.x=c.x*c.y+c.z*0.00013;\n    c.y=c.y*c.z+c.w*0.00017;\n    c.z=c.z*c.w+c.x*0.00019;\n    c.w=c.w*c.x+c.y*0.00023;\n  }\n  fragColor=c;\n}`;
      const cmpB = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : (gl.deleteShader(sh), null);
      };
      const vsB = cmpB(gl.VERTEX_SHADER, vsBSrc);
      const fsB = cmpB(gl.FRAGMENT_SHADER, fsBSrc);
      if (vsB && fsB) {
        const progB = gl.createProgram();
        gl.attachShader(progB, vsB);
        gl.attachShader(progB, fsB);
        gl.linkProgram(progB);
        if (gl.getProgramParameter(progB, gl.LINK_STATUS)) {
          gl.useProgram(progB);
          const bufB = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, bufB);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
          const vaoB = gl.createVertexArray();
          gl.bindVertexArray(vaoB);
          const aPosB = gl.getAttribLocation(progB, 'aPos');
          gl.enableVertexAttribArray(aPosB);
          gl.vertexAttribPointer(aPosB, 2, gl.FLOAT, false, 0, 0);
          const uSeedB = gl.getUniformLocation(progB, 'uSeed');
          // Per-frame readPixels sync — same approach as runWebGLBenchmark._bench.
          const SYNC_W = BENCH_SIZE,
            SYNC_H = BENCH_SIZE;
          const syncB = new Uint8Array(SYNC_W * SYNC_H * 4);
          const gpuSyncB = function () {
            gl.readPixels(0, 0, SYNC_W, SYNC_H, gl.RGBA, gl.UNSIGNED_BYTE, syncB);
          };
          // Warmup: 5 frames with per-frame sync
          for (let i = 0; i < 5; i++) {
            gl.uniform1f(uSeedB, i * 0.001);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            gpuSyncB();
          }
          // Adaptive per-frame calibration: accumulate >= 20 ms, cap 200 frames
          let calibFrames = 0;
          const tCalib = performance.now();
          do {
            gl.uniform1f(uSeedB, 0.5 + calibFrames * 0.001);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            gpuSyncB();
            calibFrames++;
          } while (performance.now() - tCalib < 20 && calibFrames < 200);
          const calibMs = performance.now() - tCalib;
          if (calibMs < 1.0 && calibFrames >= 200) {
            benchError = 'GPU-E3p: proof-bench readPixels not stalling (' + calibMs.toFixed(2) + 'ms / 200 frames)';
          } else {
            const msPerFrame = Math.max(0.01, calibMs / calibFrames);
            const benchFrames = Math.min(1000, Math.max(5, Math.round(1000 / msPerFrame)));
            const tB = performance.now();
            for (let i = 0; i < benchFrames; i++) {
              gl.uniform1f(uSeedB, i * 0.001);
              gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
              gpuSyncB();
            }
            const benchMs = Math.max(1, performance.now() - tB);
            gpuScore = Math.round((benchFrames * BENCH_SIZE * BENCH_SIZE * 1024) / benchMs);
          }
          gl.bindVertexArray(null);
          gl.deleteVertexArray(vaoB);
          gl.deleteBuffer(bufB);
          gl.deleteProgram(progB);
        }
        gl.deleteShader(vsB);
        gl.deleteShader(fsB);
      }
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
    }

    return { proofHash: (h >>> 0).toString(16).padStart(8, '0'), elapsedMs: Math.round(elapsed), gpuScore, benchError };
  } catch (e) {
    console.warn('[GPU proof] failed:', e && e.message);
    return null;
  } finally {
    if (attached && canvas && canvas.parentNode) {
      try {
        canvas.parentNode.removeChild(canvas);
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }
    }
  }
}

// ─── GPU VRAM / memory-type lookup table ─────────────────────────────────────
// Returns { vramGb, memType } for a GPU model string.
// Used as fallback when systeminformation doesn't populate vram/memoryType
// (e.g. when hardware source is 'electron' or drivers don't expose it).
function getGpuVramInfo(model) {
  if (!model) return { vramGb: 0, memType: '' };
  const m = model;
  // NVIDIA RTX 40-series
  if (/RTX\s*4090/i.test(m)) return { vramGb: 24, memType: 'GDDR6X' };
  if (/RTX\s*4080\s*Super/i.test(m)) return { vramGb: 16, memType: 'GDDR6X' };
  if (/RTX\s*4080/i.test(m)) return { vramGb: 16, memType: 'GDDR6X' };
  if (/RTX\s*4070\s*Ti\s*Super/i.test(m)) return { vramGb: 16, memType: 'GDDR6X' };
  if (/RTX\s*4070\s*Ti/i.test(m)) return { vramGb: 12, memType: 'GDDR6X' };
  if (/RTX\s*4070\s*Super/i.test(m)) return { vramGb: 12, memType: 'GDDR6X' };
  if (/RTX\s*4070/i.test(m)) return { vramGb: 12, memType: 'GDDR6X' };
  if (/RTX\s*4060\s*Ti/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RTX\s*4060/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*4050/i.test(m)) return { vramGb: 6, memType: 'GDDR6' };
  // NVIDIA RTX 30-series
  if (/RTX\s*3090\s*Ti/i.test(m)) return { vramGb: 24, memType: 'GDDR6X' };
  if (/RTX\s*3090/i.test(m)) return { vramGb: 24, memType: 'GDDR6X' };
  if (/RTX\s*3080\s*Ti/i.test(m)) return { vramGb: 12, memType: 'GDDR6X' };
  if (/RTX\s*3080\s*12/i.test(m)) return { vramGb: 12, memType: 'GDDR6X' };
  if (/RTX\s*3080/i.test(m)) return { vramGb: 10, memType: 'GDDR6X' };
  if (/RTX\s*3070\s*Ti/i.test(m)) return { vramGb: 8, memType: 'GDDR6X' };
  if (/RTX\s*3070/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*3060\s*Ti/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*3060/i.test(m)) return { vramGb: 12, memType: 'GDDR6' };
  if (/RTX\s*3050/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  // NVIDIA RTX 20-series
  if (/RTX\s*2080\s*Ti/i.test(m)) return { vramGb: 11, memType: 'GDDR6' };
  if (/RTX\s*2080\s*Super/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*2080/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*2070\s*Super/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*2070/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*2060\s*Super/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*2060/i.test(m)) return { vramGb: 6, memType: 'GDDR6' };
  // NVIDIA GTX 16-series
  if (/GTX\s*1660\s*Ti/i.test(m)) return { vramGb: 6, memType: 'GDDR6' };
  if (/GTX\s*1660\s*Super/i.test(m)) return { vramGb: 6, memType: 'GDDR6' };
  if (/GTX\s*1660/i.test(m)) return { vramGb: 6, memType: 'GDDR5' };
  if (/GTX\s*1650\s*Super/i.test(m)) return { vramGb: 4, memType: 'GDDR6' };
  if (/GTX\s*1650/i.test(m)) return { vramGb: 4, memType: 'GDDR5' };
  // NVIDIA GTX 10-series
  if (/GTX\s*1080\s*Ti/i.test(m)) return { vramGb: 11, memType: 'GDDR5X' };
  if (/GTX\s*1080/i.test(m)) return { vramGb: 8, memType: 'GDDR5X' };
  if (/GTX\s*1070\s*Ti/i.test(m)) return { vramGb: 8, memType: 'GDDR5' };
  if (/GTX\s*1070/i.test(m)) return { vramGb: 8, memType: 'GDDR5' };
  if (/GTX\s*1060\s*6/i.test(m)) return { vramGb: 6, memType: 'GDDR5' };
  if (/GTX\s*1060\s*3/i.test(m)) return { vramGb: 3, memType: 'GDDR5' };
  if (/GTX\s*1060/i.test(m)) return { vramGb: 6, memType: 'GDDR5' };
  if (/GTX\s*1050\s*Ti/i.test(m)) return { vramGb: 4, memType: 'GDDR5' };
  if (/GTX\s*1050/i.test(m)) return { vramGb: 2, memType: 'GDDR5' };
  // AMD RX 9000-series (RDNA 4)
  if (/RX\s*9070\s*XT/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*9070/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  // AMD RX 7000-series (RDNA 3)
  if (/RX\s*7900\s*XTX/i.test(m)) return { vramGb: 24, memType: 'GDDR6' };
  if (/RX\s*7900\s*GRE/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*7900\s*XT/i.test(m)) return { vramGb: 20, memType: 'GDDR6' };
  if (/RX\s*7800\s*XT/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*7700\s*XT/i.test(m)) return { vramGb: 12, memType: 'GDDR6' };
  if (/RX\s*7600\s*XT/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*7600/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RX\s*7500\s*XT/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  // AMD RX 6000-series (RDNA 2)
  if (/RX\s*6950\s*XT/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*6900\s*XT/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*6800\s*XT/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*6800/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*6750\s*XT/i.test(m)) return { vramGb: 12, memType: 'GDDR6' };
  if (/RX\s*6700\s*XT/i.test(m)) return { vramGb: 12, memType: 'GDDR6' };
  if (/RX\s*6700/i.test(m)) return { vramGb: 10, memType: 'GDDR6' };
  if (/RX\s*6650\s*XT/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RX\s*6600\s*XT/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RX\s*6600/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RX\s*6500\s*XT/i.test(m)) return { vramGb: 4, memType: 'GDDR6' };
  if (/RX\s*6400/i.test(m)) return { vramGb: 4, memType: 'GDDR6' };
  // AMD RX 5000-series (RDNA 1)
  if (/RX\s*5700\s*XT/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RX\s*5700/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RX\s*5600\s*XT/i.test(m)) return { vramGb: 6, memType: 'GDDR6' };
  if (/RX\s*5500\s*XT/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  // AMD RX 500/400-series (Polaris)
  if (/RX\s*590/i.test(m)) return { vramGb: 8, memType: 'GDDR5' };
  if (/RX\s*580/i.test(m)) return { vramGb: 8, memType: 'GDDR5' };
  if (/RX\s*570/i.test(m)) return { vramGb: 4, memType: 'GDDR5' };
  if (/RX\s*480/i.test(m)) return { vramGb: 8, memType: 'GDDR5' };
  if (/RX\s*470/i.test(m)) return { vramGb: 4, memType: 'GDDR5' };
  // AMD Vega
  if (/Vega\s*64/i.test(m)) return { vramGb: 8, memType: 'HBM2' };
  if (/Vega\s*56/i.test(m)) return { vramGb: 8, memType: 'HBM2' };
  if (/Radeon\s*VII/i.test(m)) return { vramGb: 16, memType: 'HBM2' };
  // Intel Arc
  if (/Arc\s*A770/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/Arc\s*A750/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/Arc\s*A580/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/Arc\s*A380/i.test(m)) return { vramGb: 6, memType: 'GDDR6' };
  if (/Arc\s*B580/i.test(m)) return { vramGb: 12, memType: 'GDDR6' };
  if (/Arc\s*B570/i.test(m)) return { vramGb: 10, memType: 'GDDR6' };
  return { vramGb: 0, memType: '' };
}

// ─── Expected WebGL score table ───────────────────────────────────────────────
// Returns expected WebGL ALU benchmark score (ops/ms) for a GPU model string.
// Values are tuned to the 256×256 / 128-MAD-iter shader above.
// Returns 0 for unknown GPUs (validation skipped).
function getExpectedGpuScore(gpuModel) {
  if (!gpuModel) return 0;
  const m = gpuModel;

  // ── NVIDIA RTX 40-series ──────────────────────────────────────────────────────
  // All values calibrated for per-frame readPixels benchmark (×41 vs old fenceSync table).
  if (/RTX\s*4090/i.test(m)) return 1_150_000_000;
  if (/RTX\s*4080\s*Super/i.test(m)) return 900_000_000;
  if (/RTX\s*4080/i.test(m)) return 820_000_000;
  if (/RTX\s*4070\s*Ti\s*Super/i.test(m)) return 700_000_000;
  if (/RTX\s*4070\s*Ti/i.test(m)) return 655_000_000;
  if (/RTX\s*4070\s*Super/i.test(m)) return 595_000_000;
  if (/RTX\s*4070/i.test(m)) return 533_000_000;
  if (/RTX\s*4060\s*Ti/i.test(m)) return 430_000_000;
  if (/RTX\s*4060/i.test(m)) return 349_000_000;
  if (/RTX\s*4050/i.test(m)) return 287_000_000;

  // ── NVIDIA RTX 30-series ──────────────────────────────────────────────────────
  if (/RTX\s*3090\s*Ti/i.test(m)) return 738_000_000;
  if (/RTX\s*3090/i.test(m)) return 677_000_000;
  if (/RTX\s*3080\s*Ti/i.test(m)) return 656_000_000;
  if (/RTX\s*3080\s*12/i.test(m)) return 595_000_000;
  if (/RTX\s*3080/i.test(m)) return 554_000_000;
  if (/RTX\s*3070\s*Ti/i.test(m)) return 472_000_000;
  if (/RTX\s*3070/i.test(m)) return 451_000_000;
  if (/RTX\s*3060\s*Ti/i.test(m)) return 369_000_000;
  if (/RTX\s*3060/i.test(m)) return 308_000_000;
  if (/RTX\s*3050/i.test(m)) return 205_000_000;

  // ── NVIDIA RTX 20-series ──────────────────────────────────────────────────────
  if (/RTX\s*2080\s*Ti/i.test(m)) return 472_000_000;
  if (/RTX\s*2080\s*Super/i.test(m)) return 410_000_000;
  if (/RTX\s*2080/i.test(m)) return 390_000_000;
  if (/RTX\s*2070\s*Super/i.test(m)) return 369_000_000;
  if (/RTX\s*2070/i.test(m)) return 328_000_000;
  if (/RTX\s*2060\s*Super/i.test(m)) return 308_000_000;
  if (/RTX\s*2060/i.test(m)) return 267_000_000;

  // ── NVIDIA GTX 16-series ──────────────────────────────────────────────────────
  if (/GTX\s*1660\s*Ti/i.test(m)) return 226_000_000;
  if (/GTX\s*1660\s*Super/i.test(m)) return 205_000_000;
  if (/GTX\s*1660/i.test(m)) return 185_000_000;
  if (/GTX\s*1650\s*Super/i.test(m)) return 164_000_000;
  if (/GTX\s*1650/i.test(m)) return 123_000_000;

  // ── NVIDIA GTX 10-series ──────────────────────────────────────────────────────
  if (/GTX\s*1080\s*Ti/i.test(m)) return 308_000_000;
  if (/GTX\s*1080/i.test(m)) return 267_000_000;
  if (/GTX\s*1070\s*Ti/i.test(m)) return 226_000_000;
  if (/GTX\s*1070/i.test(m)) return 205_000_000;
  if (/GTX\s*1060\s*6/i.test(m)) return 144_000_000;
  if (/GTX\s*1060/i.test(m)) return 123_000_000;
  if (/GTX\s*1050\s*Ti/i.test(m)) return 90_000_000;
  if (/GTX\s*1050/i.test(m)) return 74_000_000;

  // ── NVIDIA Quadro / Professional ─────────────────────────────────────────────
  if (/RTX\s*[Aa]\s*6000/i.test(m)) return 738_000_000;
  if (/RTX\s*[Aa]\s*5000/i.test(m)) return 574_000_000;
  if (/RTX\s*[Aa]\s*4000/i.test(m)) return 369_000_000;
  if (/RTX\s*[Aa]\s*2000/i.test(m)) return 205_000_000;
  if (/Quadro\s*P[45][0-9]{3}/i.test(m)) return 205_000_000;
  if (/Quadro\s*P[12][0-9]{3}/i.test(m)) return 103_000_000;

  // ── AMD Radeon RX 7000-series ─────────────────────────────────────────────────
  if (/RX\s*7900\s*XTX/i.test(m)) return 902_000_000;
  if (/RX\s*7900\s*XT/i.test(m)) return 779_000_000;
  if (/RX\s*7800\s*XT/i.test(m)) return 574_000_000;
  if (/RX\s*7700\s*XT/i.test(m)) return 492_000_000;
  if (/RX\s*7600/i.test(m)) return 349_000_000;
  if (/RX\s*7500\s*XT/i.test(m)) return 246_000_000;

  // ── AMD Radeon RX 6000-series ─────────────────────────────────────────────────
  if (/RX\s*6950\s*XT/i.test(m)) return 759_000_000;
  if (/RX\s*6900\s*XT/i.test(m)) return 718_000_000;
  if (/RX\s*6800\s*XT/i.test(m)) return 677_000_000;
  if (/RX\s*6800/i.test(m)) return 615_000_000;
  if (/RX\s*6750\s*XT/i.test(m)) return 533_000_000;
  if (/RX\s*6700\s*XT/i.test(m)) return 492_000_000;
  if (/RX\s*6700/i.test(m)) return 451_000_000;
  if (/RX\s*6650\s*XT/i.test(m)) return 390_000_000;
  if (/RX\s*6600\s*XT/i.test(m)) return 369_000_000;
  if (/RX\s*6600/i.test(m)) return 328_000_000;
  if (/RX\s*6500\s*XT/i.test(m)) return 185_000_000;
  if (/RX\s*6400/i.test(m)) return 123_000_000;

  // ── AMD Radeon RX 5000-series ─────────────────────────────────────────────────
  if (/RX\s*5700\s*XT/i.test(m)) return 410_000_000;
  if (/RX\s*5700/i.test(m)) return 369_000_000;
  if (/RX\s*5600\s*XT/i.test(m)) return 308_000_000;
  if (/RX\s*5500\s*XT/i.test(m)) return 205_000_000;

  // ── AMD Radeon Vega / RX 400–580 ─────────────────────────────────────────────
  if (/Vega\s*64/i.test(m)) return 328_000_000;
  if (/Vega\s*56/i.test(m)) return 287_000_000;
  if (/RX\s*590/i.test(m)) return 205_000_000;
  if (/RX\s*580/i.test(m)) return 185_000_000;
  if (/RX\s*570/i.test(m)) return 164_000_000;
  if (/RX\s*480/i.test(m)) return 185_000_000;
  if (/RX\s*470/i.test(m)) return 164_000_000;

  // ── Intel Arc ─────────────────────────────────────────────────────────────────
  if (/Arc\s*A770/i.test(m)) return 451_000_000;
  if (/Arc\s*A750/i.test(m)) return 390_000_000;
  if (/Arc\s*A580/i.test(m)) return 308_000_000;
  if (/Arc\s*A380/i.test(m)) return 164_000_000;
  if (/Arc\s*A310/i.test(m)) return 103_000_000;

  // ── Intel Iris Xe (discrete / Evo) ───────────────────────────────────────────
  if (/Iris\s*Xe\s*Max/i.test(m)) return 74_000_000;
  if (/Iris\s*Xe/i.test(m)) return 37_000_000;

  // ── Intel UHD / HD integrated ────────────────────────────────────────────────
  if (/UHD\s*Graphics\s*770/i.test(m)) return 21_000_000;
  if (/UHD\s*Graphics\s*7[0-9]{2}/i.test(m)) return 20_000_000;
  if (/UHD\s*Graphics\s*6[0-9]{2}/i.test(m)) return 16_000_000;
  if (/UHD\s*Graphics/i.test(m)) return 16_000_000;
  if (/HD\s*Graphics\s*[6-9][3-9]0/i.test(m)) return 8_000_000;
  if (/HD\s*Graphics/i.test(m)) return 6_000_000;

  // ── AMD Radeon Graphics (integrated RDNA2/3) ──────────────────────────────────
  if (/Radeon\s*Graphics/i.test(m)) return 29_000_000; // Ryzen iGPU generic

  // ── Apple (Metal — GPU perf via system-reported model) ───────────────────────
  if (/M4\s*(Pro|Max|Ultra)/i.test(m)) return 369_000_000;
  if (/\bM4\b/i.test(m)) return 205_000_000;
  if (/M3\s*(Pro|Max|Ultra)/i.test(m)) return 287_000_000;
  if (/\bM3\b/i.test(m)) return 164_000_000;
  if (/M2\s*(Pro|Max|Ultra)/i.test(m)) return 226_000_000;
  if (/\bM2\b/i.test(m)) return 131_000_000;
  if (/M1\s*(Pro|Max|Ultra)/i.test(m)) return 164_000_000;
  if (/\bM1\b/i.test(m)) return 103_000_000;

  // Unknown GPU: conservative mid-range fallback (≈ GTX 1060 / RX 580 class).
  return 144_000_000;
}

// Returns the expected ops/s for runCpuSpeedBenchmark (fixed-N imul+XOR loop) for a
// given CPU model string.  Values are derived from: boostClockGHz × archFactor × 1e8.
// Used for (1) hardware-claim validation and (2) TDP calibration from measured throughput.
// Returns 0 for unrecognised CPUs (validation skipped).
function getExpectedCpuSpeedOps(cpuModel) {
  if (!cpuModel) return 0;
  const m = cpuModel;

  // ── Intel 14th / 13th Gen Desktop (Raptor Lake / Refresh) ────────────────────
  if (/Core.*i9-1[34]900KS/i.test(m)) return 620_000_000;
  if (/Core.*i9-1[34]900KF?/i.test(m)) return 600_000_000;
  if (/Core.*i9-1[34]900[FT]?/i.test(m)) return 575_000_000;
  if (/Core.*i7-1[34]700KF?/i.test(m)) return 560_000_000;
  if (/Core.*i7-1[34]700[FT]?/i.test(m)) return 540_000_000;
  if (/Core.*i5-1[34]600KF?/i.test(m)) return 530_000_000;
  if (/Core.*i5-1[34][5-9]0{2}[FT]?/i.test(m)) return 510_000_000;
  if (/Core.*i5-1[34]400[FT]?/i.test(m)) return 480_000_000;
  if (/Core.*i3-1[34]1[0-9]0[FT]?/i.test(m)) return 460_000_000;
  if (/Core.*i3-133[0-9]0/i.test(m)) return 460_000_000;

  // ── Intel 12th Gen Desktop (Alder Lake P-core) ───────────────────────────────
  if (/Core.*i9-12900KS/i.test(m)) return 520_000_000;
  if (/Core.*i9-12900KF?/i.test(m)) return 500_000_000;
  if (/Core.*i9-12900[FT]?/i.test(m)) return 490_000_000;
  if (/Core.*i7-12700KF?/i.test(m)) return 490_000_000;
  if (/Core.*i7-12700[FT]?/i.test(m)) return 470_000_000;
  if (/Core.*i5-12600KF?/i.test(m)) return 470_000_000;
  if (/Core.*i5-12[56]0{2}[FT]?/i.test(m)) return 450_000_000;
  if (/Core.*i5-124[024]0[FT]?/i.test(m)) return 430_000_000;
  if (/Core.*i3-12[13][02][015][FT]?/i.test(m)) return 420_000_000;

  // ── Intel 11th Gen Desktop (Rocket Lake) ─────────────────────────────────────
  if (/Core.*i9-11900KF?/i.test(m)) return 490_000_000;
  if (/Core.*i9-11900[FT]?/i.test(m)) return 480_000_000;
  if (/Core.*i7-11700KF?/i.test(m)) return 480_000_000;
  if (/Core.*i7-11700[FT]?/i.test(m)) return 460_000_000;
  if (/Core.*i5-11[456][0-9]0[FKT]?[F]?/i.test(m)) return 440_000_000;

  // ── Intel 10th Gen Desktop (Comet Lake) ──────────────────────────────────────
  if (/Core.*i9-10900KF?S?/i.test(m)) return 470_000_000;
  if (/Core.*i9-10[89][0-9]0[FKST]?/i.test(m)) return 460_000_000;
  if (/Core.*i7-10700KF?/i.test(m)) return 450_000_000;
  if (/Core.*i7-10700[FT]?/i.test(m)) return 420_000_000;
  if (/Core.*i5-10[456][0-9]0[FKST]?/i.test(m)) return 400_000_000;
  if (/Core.*i3-10[1-9][0-9]0[FT]?/i.test(m)) return 390_000_000;

  // ── Intel 9th / 8th Gen Desktop (Coffee Lake / Refresh) ─────────────────────
  if (/Core.*i9-9900KF?S?/i.test(m)) return 430_000_000;
  if (/Core.*i9-9900[FT]?/i.test(m)) return 430_000_000;
  if (/Core.*i7-9700KF?/i.test(m)) return 420_000_000;
  if (/Core.*i7-9700[FT]?/i.test(m)) return 400_000_000;
  if (/Core.*i5-9[456][0-9]0[FKT]?/i.test(m)) return 380_000_000;
  if (/Core.*i3-9[1-9][0-9]0[FKT]?/i.test(m)) return 360_000_000;
  if (/Core.*i7-8700KF?/i.test(m)) return 400_000_000;
  if (/Core.*i7-8700[FT]?/i.test(m)) return 385_000_000;
  if (/Core.*i5-8[456][0-9]0[FKT]?/i.test(m)) return 360_000_000;
  if (/Core.*i3-8[1-4][0-9]0[FKT]?/i.test(m)) return 340_000_000;

  // ── Intel 7th Gen Desktop (Kaby Lake) ────────────────────────────────────────
  if (/Core.*i7-7700KF?/i.test(m)) return 375_000_000;
  if (/Core.*i7-7700[T]?/i.test(m)) return 350_000_000;
  if (/Core.*i5-7[456][0-9]0[KT]?/i.test(m)) return 335_000_000;
  if (/Core.*i3-73[0-9]0[KT]?/i.test(m)) return 330_000_000;
  if (/Core.*i3-71[0-9]0[T]?/i.test(m)) return 320_000_000;

  // ── Intel 6th Gen Desktop (Skylake) ──────────────────────────────────────────
  if (/Core.*i7-6700KF?/i.test(m)) return 340_000_000;
  if (/Core.*i7-6700[T]?/i.test(m)) return 320_000_000;
  if (/Core.*i5-6[456][0-9]0[KT]?/i.test(m)) return 310_000_000;
  if (/Core.*i3-6[1-3][0-9]0[T]?/i.test(m)) return 300_000_000;

  // ── Intel 5th Gen Desktop (Broadwell) ────────────────────────────────────────
  if (/Core.*i[57]-5[67][0-9]5C/i.test(m)) return 285_000_000;

  // ── Intel 4th Gen Desktop (Haswell) ──────────────────────────────────────────
  if (/Core.*i7-4790K/i.test(m)) return 330_000_000;
  if (/Core.*i7-47[0-9]0[T]?/i.test(m)) return 300_000_000;
  if (/Core.*i5-4[5-9][0-9]0[KT]?/i.test(m)) return 295_000_000;
  if (/Core.*i5-4[34][0-9]0[T]?/i.test(m)) return 270_000_000;
  if (/Core.*i3-4[1-4][0-9]0[T]?/i.test(m)) return 265_000_000;

  // ── Intel 3rd Gen Desktop (Ivy Bridge) ───────────────────────────────────────
  if (/Core.*i7-377[0-9]K?/i.test(m)) return 260_000_000;
  if (/Core.*i5-35[2-7]0[KT]?/i.test(m)) return 250_000_000;
  if (/Core.*i5-34[3-7]0[T]?/i.test(m)) return 240_000_000;
  if (/Core.*i3-3[1-3][0-9]0/i.test(m)) return 220_000_000;

  // ── Intel 2nd Gen Desktop (Sandy Bridge) ─────────────────────────────────────
  if (/Core.*i7-2[6-7]00K?/i.test(m)) return 240_000_000;
  if (/Core.*i7-2[5-9][0-9]0[S]?/i.test(m)) return 230_000_000;
  if (/Core.*i5-2[3-6][0-9]0K?/i.test(m)) return 220_000_000;
  if (/Core.*i3-2[1-3][0-9]0/i.test(m)) return 200_000_000;

  // ── Intel Core Ultra 200S (Arrow Lake Desktop) ───────────────────────────────
  if (/Core.*Ultra 9 2[0-9]{2}K/i.test(m)) return 560_000_000;
  if (/Core.*Ultra 7 2[0-9]{2}KF?/i.test(m)) return 540_000_000;
  if (/Core.*Ultra 5 2[0-9]{2}KF?/i.test(m)) return 510_000_000;

  // ── Intel Core Ultra 100H/U (Meteor Lake Mobile) ─────────────────────────────
  if (/Core.*Ultra 9 1[0-9]{2}H/i.test(m)) return 430_000_000;
  if (/Core.*Ultra 7 1[0-9]{2}H/i.test(m)) return 415_000_000;
  if (/Core.*Ultra 5 1[0-9]{2}H/i.test(m)) return 390_000_000;
  if (/Core.*Ultra [579] 1[0-9]{2}U/i.test(m)) return 350_000_000;

  // ── Intel 13th Gen Mobile (HX / H / U) ───────────────────────────────────────
  if (/Core.*i9-139[0-9]0HX/i.test(m)) return 520_000_000;
  if (/Core.*i9-139[0-9]0H/i.test(m)) return 490_000_000;
  if (/Core.*i7-137[0-9]0HX/i.test(m)) return 480_000_000;
  if (/Core.*i7-137[0-9]0H/i.test(m)) return 460_000_000;
  if (/Core.*i5-13[3-6][0-9]0H/i.test(m)) return 440_000_000;
  if (/Core.*i[37]-13[3-7][0-9]U/i.test(m)) return 420_000_000;
  if (/Core.*i[35]-13[1-5][0-9]U/i.test(m)) return 390_000_000;

  // ── Intel 12th Gen Mobile ─────────────────────────────────────────────────────
  if (/Core.*i9-129[0-9]0H[KX]?/i.test(m)) return 450_000_000;
  if (/Core.*i7-127[0-9]0H/i.test(m)) return 420_000_000;
  if (/Core.*i5-12[45][0-9]0H/i.test(m)) return 400_000_000;
  if (/Core.*i7-12[78][0-9]P/i.test(m)) return 390_000_000;
  if (/Core.*i[35]-12[34][0-9]P/i.test(m)) return 360_000_000;
  if (/Core.*i[37]-12[25][0-9]U/i.test(m)) return 380_000_000;
  if (/Core.*i5-12[23][0-9]U/i.test(m)) return 350_000_000;

  // ── Intel 11th Gen Mobile ─────────────────────────────────────────────────────
  if (/Core.*i9-11980HK/i.test(m)) return 420_000_000;
  if (/Core.*i9-119[0-9]0H/i.test(m)) return 390_000_000;
  if (/Core.*i7-118[0-9]0H/i.test(m)) return 380_000_000;
  if (/Core.*i5-115[0-9]0H/i.test(m)) return 360_000_000;
  if (/Core.*i7-118[56]G[47]/i.test(m)) return 350_000_000;
  if (/Core.*i7-116[56]G7/i.test(m)) return 340_000_000;
  if (/Core.*i5-1135G7/i.test(m)) return 320_000_000;
  if (/Core.*i3-11[12][0-9]G[47]/i.test(m)) return 290_000_000;

  // ── Intel 10th Gen Mobile ─────────────────────────────────────────────────────
  if (/Core.*i7-108[0-9]5H/i.test(m)) return 380_000_000;
  if (/Core.*i7-107[0-9]0H/i.test(m)) return 360_000_000;
  if (/Core.*i5-103[0-9]0H/i.test(m)) return 340_000_000;
  if (/Core.*i7-1065G7/i.test(m)) return 320_000_000; // Ice Lake
  if (/Core.*i5-1035G[14]/i.test(m)) return 290_000_000;
  if (/Core.*i3-1005G1/i.test(m)) return 260_000_000;

  // ── Intel Xeon ────────────────────────────────────────────────────────────────
  if (/Xeon.*w9-35[0-9]{2}X/i.test(m)) return 490_000_000;
  if (/Xeon.*w7-3[0-9]{3}X/i.test(m)) return 470_000_000;
  if (/Xeon.*w7-2[0-9]{3}X/i.test(m)) return 450_000_000;
  if (/Xeon.*W-3175X/i.test(m)) return 390_000_000;
  if (/Xeon.*W-2[2-9][0-9]{2}/i.test(m)) return 410_000_000;
  if (/Xeon.*Gold 6[12][0-9]{2}R?/i.test(m)) return 360_000_000;
  if (/Xeon.*Silver 4[23][0-9]{2}/i.test(m)) return 330_000_000;
  if (/Xeon.*E5-2[6-9][0-9]{2}/i.test(m)) return 260_000_000;

  // ── AMD Ryzen 9000 (Zen 5) ────────────────────────────────────────────────────
  if (/Ryzen 9 9950X/i.test(m)) return 580_000_000;
  if (/Ryzen 9 9900X/i.test(m)) return 570_000_000;
  if (/Ryzen 7 9800X3D/i.test(m)) return 520_000_000;
  if (/Ryzen 7 9700X/i.test(m)) return 560_000_000;
  if (/Ryzen 5 9600X/i.test(m)) return 540_000_000;
  if (/Ryzen 5 9600/i.test(m)) return 510_000_000;

  // ── AMD Ryzen 7000 (Zen 4) ────────────────────────────────────────────────────
  if (/Ryzen 9 7950X3D/i.test(m)) return 540_000_000;
  if (/Ryzen 9 7950X/i.test(m)) return 560_000_000;
  if (/Ryzen 9 7900X3D/i.test(m)) return 530_000_000;
  if (/Ryzen 9 7900X/i.test(m)) return 550_000_000;
  if (/Ryzen 9 7900/i.test(m)) return 530_000_000;
  if (/Ryzen 7 7800X3D/i.test(m)) return 490_000_000;
  if (/Ryzen 7 7700X/i.test(m)) return 530_000_000;
  if (/Ryzen 7 7700/i.test(m)) return 520_000_000;
  if (/Ryzen 5 7600X/i.test(m)) return 520_000_000;
  if (/Ryzen 5 7600/i.test(m)) return 500_000_000;
  if (/Ryzen 5 7500F/i.test(m)) return 490_000_000;

  // ── AMD Ryzen 5000 (Zen 3) ────────────────────────────────────────────────────
  if (/Ryzen 9 5950X/i.test(m)) return 470_000_000;
  if (/Ryzen 9 5900X/i.test(m)) return 460_000_000;
  if (/Ryzen 9 5900HX/i.test(m)) return 420_000_000;
  if (/Ryzen 9 5900/i.test(m)) return 450_000_000;
  if (/Ryzen 7 5800X3D/i.test(m)) return 430_000_000;
  if (/Ryzen 7 5800X/i.test(m)) return 450_000_000;
  if (/Ryzen 7 5800H/i.test(m)) return 410_000_000;
  if (/Ryzen 7 5800/i.test(m)) return 440_000_000;
  if (/Ryzen 7 5700[GX]?/i.test(m)) return 440_000_000;
  if (/Ryzen 5 5600X/i.test(m)) return 440_000_000;
  if (/Ryzen 5 5600H/i.test(m)) return 400_000_000;
  if (/Ryzen 5 5600[G]?/i.test(m)) return 420_000_000;
  if (/Ryzen 5 5500/i.test(m)) return 400_000_000;
  if (/Ryzen 3 5[13][0-9]{2}G?/i.test(m)) return 385_000_000;

  // ── AMD Ryzen 3000 (Zen 2) ────────────────────────────────────────────────────
  if (/Ryzen 9 3950X/i.test(m)) return 420_000_000;
  if (/Ryzen 9 3900X?T?/i.test(m)) return 415_000_000;
  if (/Ryzen 7 3800X?T?/i.test(m)) return 410_000_000;
  if (/Ryzen 7 3700X/i.test(m)) return 400_000_000;
  if (/Ryzen 5 3600X?T?/i.test(m)) return 400_000_000;
  if (/Ryzen 5 3600/i.test(m)) return 380_000_000;
  if (/Ryzen 5 3500X?/i.test(m)) return 360_000_000;
  if (/Ryzen 3 3[13][0-9]{2}X?/i.test(m)) return 370_000_000;

  // ── AMD Ryzen 2000 (Zen+) ─────────────────────────────────────────────────────
  if (/Ryzen 7 2700X/i.test(m)) return 330_000_000;
  if (/Ryzen 7 2700/i.test(m)) return 310_000_000;
  if (/Ryzen 5 2600X/i.test(m)) return 320_000_000;
  if (/Ryzen 5 2600/i.test(m)) return 300_000_000;
  if (/Ryzen 3 2[23][0-9]{2}[GX]?/i.test(m)) return 280_000_000;

  // ── AMD Threadripper ──────────────────────────────────────────────────────────
  if (/Threadripper PRO 79[0-9]{2}W/i.test(m)) return 490_000_000;
  if (/Threadripper PRO 59[0-9]{2}W/i.test(m)) return 440_000_000;
  if (/Threadripper PRO 59[0-9]{2}W/i.test(m)) return 440_000_000;
  if (/Threadripper 39[0-9]{2}X/i.test(m)) return 400_000_000;
  if (/Threadripper 29[0-9]{2}[WX]/i.test(m)) return 310_000_000;

  // ── AMD EPYC ──────────────────────────────────────────────────────────────────
  if (/EPYC 9[5-9][0-9]{2}/i.test(m)) return 390_000_000; // Zen4
  if (/EPYC 9[1-4][0-9]{2}/i.test(m)) return 375_000_000;
  if (/EPYC 7[6-9][0-9]{2}/i.test(m)) return 310_000_000; // Zen3
  if (/EPYC 7[3-5][0-9]{2}/i.test(m)) return 280_000_000; // Zen2
  if (/EPYC 7[0-2][0-9]{2}/i.test(m)) return 260_000_000;

  // ── Apple Silicon ─────────────────────────────────────────────────────────────
  if (/M4 (Pro|Max|Ultra)/i.test(m)) return 620_000_000;
  if (/\bM4\b/i.test(m)) return 590_000_000;
  if (/M3 Max/i.test(m)) return 560_000_000;
  if (/M3 (Pro|Ultra)/i.test(m)) return 550_000_000;
  if (/\bM3\b/i.test(m)) return 540_000_000;
  if (/M2 (Pro|Max|Ultra)/i.test(m)) return 500_000_000;
  if (/\bM2\b/i.test(m)) return 480_000_000;
  if (/M1 (Pro|Max|Ultra)/i.test(m)) return 440_000_000;
  if (/\bM1\b/i.test(m)) return 420_000_000;

  return 0; // unknown — skip validation
}

// Add a prop: isActive (true if dashboard is visible)
export default function Miner({
  mining,
  setMining,
  coins,
  setCoins: _setCoins,
  maturedCoins = 0,
  unmaturedCoins = 0,
  energy,
  setEnergy: _setEnergy,
  log: _log,
  setLog,
  probeLog: _probeLog = [],
  setProbeLog,
  isActive = true,
  setPowerW, // NEW: callback to lift powerW
  miningAddress = '',
  onBlockMined,
  chainHeight = -1,
  hardwareLookupResetNonce = 0,
  firewallBlocked = false,
  firewallHealing = false,
  onHealFirewall,
}) {
  // Helper for timestamp
  const now = React.useCallback(() => new Date().toLocaleString('en-GB'), []);
  const [realMineBusy, setRealMineBusy] = React.useState(false);
  const [_realMineStatus, setRealMineStatus] = React.useState('');
  const [peerCount, setPeerCount] = React.useState(null);
  const [connectedPeerCount, setConnectedPeerCount] = React.useState(0);
  const [peerCountSource, setPeerCountSource] = React.useState(null); // null | 'standalone' | 'coordinator'
  const [peerDiscoveryInfo, setPeerDiscoveryInfo] = React.useState({
    configuredPeers: 0,
    seedPeers: 0,
    discoveredPeers: 0,
  });
  const [lastSyncInfo, setLastSyncInfo] = React.useState({ trigger: '', ok: false });
  const [chainReadiness, setChainReadiness] = React.useState({
    spendReady: false,
    message: 'Checking...',
    connections: 0,
    blocks: 0,
  });
  const [sharedRoundTotalWh, setSharedRoundTotalWh] = React.useState(0);

  const [_baselinePowerW, setBaselinePowerW] = React.useState(0);
  const [showRebenchPrompt, setShowRebenchPrompt] = React.useState(false);
  const rebenchRef = React.useRef(false);
  React.useEffect(() => {
    rebenchRef.current = showRebenchPrompt;
  }, [showRebenchPrompt]);
  const [benchmarkState, setBenchmarkState] = React.useState({
    running: false,
    startupDone: (() => {
      try {
        return sessionStorage.getItem(STARTUP_BENCHMARK_DONE_STORAGE_KEY) === '1';
      } catch (_) {
        return false;
      }
    })(),
    lastScore: null,
    lastReason: '',
    lastSummary: '',
    issues: [],
    lastJitterPct: null,
    lastTrustDelta: null,
    lastTrustChangeTime: null,
    lastAvgCpuPct: null,
    lastAvgMemPct: null,
    lastAvgGpuPct: null,
    lastWasBaseline: false,
    cpuPenaltyPct: -1,
    memPenaltyPct: -1,
    gpuPenaltyPct: -1,
  });
  const [loadPercent, setLoadPercent] = React.useState(() => {
    try {
      const raw = localStorage.getItem(LOAD_PERCENT_STORAGE_KEY);
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return MAX_HARDWARE_LOAD_PERCENT;
      return Math.min(MAX_HARDWARE_LOAD_PERCENT, Math.max(0, parsed));
    } catch (_) {
      return MAX_HARDWARE_LOAD_PERCENT;
    }
  });
  const energyBudgetWhRef = React.useRef(0);
  const lastRoundAttemptRef = React.useRef({ id: 0, atMs: 0 });
  const prevMiningStateRef = React.useRef(mining);
  const benchmarkInFlightRef = React.useRef(false);
  const loadPercentRef = React.useRef(MAX_HARDWARE_LOAD_PERCENT);
  const miningRef = React.useRef(false);

  const lastSuspiciousBenchmarkMsRef = React.useRef(0);
  const [sliderAdjustNonce, setSliderAdjustNonce] = React.useState(0);
  const lastHandledSliderAdjustNonceRef = React.useRef(0);
  const lastSliderCommitAtMsRef = React.useRef(0);
  // Drift-detection baselines — set on startup/slider-stop, compared on every subsequent run.
  const benchmarkRefCpuOpsRef = React.useRef(null);
  const benchmarkRefMemBwRef = React.useRef(null);
  const benchmarkRefMemLatencyRef = React.useRef(null);
  const benchmarkRefGpuScoreRef = React.useRef(null);
  const benchmarkRefJitterRef = React.useRef(null);

  // Holds the most recent benchmark proof data for inclusion in the next mineBlock call.
  // Fields: cpuSpeedProof, cpuSpeedInitialSeed, memProof, challengeSeed, cpuOpsPerSec,
  //         memoryMBps, jitterRatio, score, issues, benchmarkTs.
  const benchmarkProofRef = React.useRef(null);
  // Item 4: set to true when a peer probe was successfully verified in the current round.
  // Reset when a block is mined so each round is independently assessed.
  const peerProbeVerifiedRef = React.useRef(false);
  // Item 5: stores the latest signed receipt from the coordinator peer probe.
  const probeReceiptRef = React.useRef(null);
  // Chained-probe continuity state — updated on each verified probe response.
  // chainHead: last proof hash (drives next seed derivation); chainIndex: count;
  // chainBroken: true if any probe in this session timed out or failed.
  const probeChainRef = React.useRef({ chainHead: null, chainIndex: 0, chainBroken: false });

  // True while waiting for the re-benchmark confirmation after a first drift was detected.
  const benchmarkRetryPendingRef = React.useRef(false);
  // Set when all peers go offline to pause mining. Cleared when a peer reconnects.
  const peerDownRef = React.useRef(false);
  // Toggled when a peer reconnects after being down, forcing the mining effect to re-run.
  const [peerDownToggle, setPeerDownToggle] = React.useState(0);
  // Tracks consecutive peer probe connection failures (no peers, peer unreachable).
  // Resets on success or coordinator rejection (non-transient). Mining stops at 5.
  // WebGL GPU load canvas and GL state (for continuous GPU load during mining).
  const gpuLoadCanvasRef = React.useRef(null);
  const gpuLoadGlStateRef = React.useRef({ gl: null, prog: null, seedLoc: null, initialized: false });
  const gpuLoadRafRef = React.useRef(null);
  const gpuMeasuredDutyRef = React.useRef(0);
  const [hardwareHoldUntilMs, setHardwareHoldUntilMs] = React.useState(() => {
    try {
      const stored = Number(localStorage.getItem(HW_HOLD_STORAGE_KEY) || '0');
      if (stored <= Date.now()) return 0;
      // If stored trust is 0 it was likely corrupted by an earlier bug — clear the
      // erroneously-triggered hold so mining can resume at default trust.
      const storedTrust = Number(localStorage.getItem(TRUST_SCORE_STORAGE_KEY) || '0');
      if (!Number.isFinite(storedTrust) || storedTrust === 0) {
        localStorage.removeItem(HW_HOLD_STORAGE_KEY);
        return 0;
      }
      return stored;
    } catch (_) {
      return 0;
    }
  });
  const hardwareHoldUntilRef = React.useRef(hardwareHoldUntilMs);
  const [holdSecondsLeft, setHoldSecondsLeft] = React.useState(0);
  const isHardwareOnHold = ENABLE_HARDWARE_HOLD && hardwareHoldUntilMs > Date.now();

  const [hardwareRecognizedByNetwork, setHardwareRecognizedByNetwork] = React.useState(true);

  // Try to load hardware info from sessionStorage first
  const [hardware, setHardware] = React.useState(() => {
    // eslint-disable-line no-unused-vars
    const saved = sessionStorage.getItem('wattcoinHardware');
    if (saved) return JSON.parse(saved);
    return {
      deviceType: 'Unknown',
      manufacturer: 'Unknown',
      version: 'Unknown',
      motherboardFormFactor: '',
      cpu: 'Unknown',
      logicalCores: 1,
      physicalCores: 1,
      cpuSockets: 1,
      gpu: 'Unknown',
      gpus: [],
      gpuDetailsList: [],
      memory: 'Unknown',
      memTotalGB: 0,
      memSpeedMhz: 0,
      memSticks: 1,
      osName: 'Unknown',
      source: '',
    };
  });

  const [benchPower, setBenchPower] = React.useState(null);

  // Persisted hardware card width — saved after hardware is recognized so the card
  // doesn't jump from "Unknown" placeholder size to full content size on next launch.
  // Minimum threshold prevents caching a loading-state narrow width.
  const [savedHwCardWidth, setSavedHwCardWidth] = React.useState(() => {
    try {
      const v = parseInt(localStorage.getItem('wattcoin-hw-card-width'), 10);
      return v > 0 ? v : null;
    } catch (_) {
      return null;
    }
  });
  const hwCardRef = React.useRef(null);
  const [benchmarkPowerCapW, setBenchmarkPowerCapW] = React.useState(null);
  const benchmarkPowerCapWRef = React.useRef(null);
  // Ops-based TDP calibration: ratio of measured cpuSpeedOpsPerSec to expected ops/s
  // for the declared CPU model.  Stays 1.0 when unknown; <1.0 when throttled.
  const [benchmarkOpsCalibration, setBenchmarkOpsCalibration] = React.useState(1.0);
  // Memory bandwidth calibration: ratio of measured sequential bandwidth to expected.
  const [benchmarkMemCalibration, setBenchmarkMemCalibration] = React.useState(1.0);
  // GPU ALU-score calibration: ratio of measured WebGL score to expected for declared GPU.
  const [benchmarkGpuCalibration, setBenchmarkGpuCalibration] = React.useState(1.0);
  const consecutiveUnderestimateRef = React.useRef(0);
  // Tracks the sum of online/static CPU+GPU TDP for the current hardware (set each render).
  // Gives runBenchmark a device-type-aware ceiling that doesn't depend on per-core ops math.
  const totalHardwareTDPRef = React.useRef(0);
  // Calibration-adjusted unit TDP, updated every render from the power computation below.
  // Read by runBenchmark to pass declaredUnitPowerW to the main-process power ceiling.
  const unitFullPowerWRef = React.useRef(0);
  // Trust score is owned by the main process (hw-auth-state.json).
  // Renderer starts at 50 and syncs from the authority on mount and after each benchmark.
  const [trustScore, setTrustScore] = React.useState(50);
  const trustScoreRef = React.useRef(50);

  // Global average electricity price (USD/kWh) — fetched from main, cached 24 h.
  const [electricityPrice, setElectricityPrice] = React.useState(null);
  const [electricityPriceSource, setElectricityPriceSource] = React.useState(null);

  const [asicConfigStatus, setAsicConfigStatus] = React.useState('');
  const [discoveredAsics, setDiscoveredAsics] = React.useState([]);
  const [scanning, setScanning] = React.useState(false);
  const [asicLiveness, setAsicLiveness] = React.useState([]);

  React.useEffect(() => {
    if (hardwareLookupResetNonce <= 0) return;
    try {
      sessionStorage.removeItem(STARTUP_BENCHMARK_DONE_STORAGE_KEY);
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
    }
    setBenchmarkState((prev) => ({
      ...prev,
      running: false,
      startupDone: false,
      lastSummary: '',
      issues: [],
      lastReason: '',
    }));
    benchmarkInFlightRef.current = false;
    setBenchmarkPowerCapW(null);
    consecutiveUnderestimateRef.current = 0;
  }, [hardwareLookupResetNonce]);

  const allGpuModels = React.useMemo(() => {
    if (Array.isArray(hardware.gpus) && hardware.gpus.length > 0) return hardware.gpus;
    if (hardware.gpu && hardware.gpu !== 'Unknown') return [hardware.gpu];
    return [];
  }, [hardware.gpu, hardware.gpus]);
  const isWholeDeviceMiniPcModel = isWholeDeviceMiniPc(hardware);
  const allowGpuWorkloads =
    hardware.deviceType !== 'Laptop' &&
    hardware.deviceType !== 'ASIC' &&
    !isWholeDeviceMiniPcModel &&
    !hasOnlyIntegratedGpu(hardware);

  React.useEffect(() => {
    hardwareHoldUntilRef.current = hardwareHoldUntilMs;
  }, [hardwareHoldUntilMs]);
  React.useEffect(() => {
    benchmarkPowerCapWRef.current = benchmarkPowerCapW;
  }, [benchmarkPowerCapW]);
  React.useEffect(() => {
    trustScoreRef.current = trustScore;
    // Trust score is persisted by the main process (hw-auth-state.json in userData).
    // localStorage is no longer the authoritative store; main owns the value.
  }, [trustScore]);
  React.useEffect(() => {
    loadPercentRef.current = loadPercent;
  }, [loadPercent]);
  React.useEffect(() => {
    miningRef.current = mining;
  }, [mining]);

  // Fetch global average electricity price from main (cached 24 h, refreshed every 30 min).
  React.useEffect(() => {
    const fetchPrice = async () => {
      try {
        const res = await window.wattcoinHardware.invoke('wattcoin-get-electricity-price');
        if (res && typeof res.price === 'number' && res.price > 0) {
          setElectricityPrice(res.price);
          setElectricityPriceSource(res.source || null);
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }
    };
    fetchPrice();
    const id = setInterval(fetchPrice, 30 * 60 * 1000); // refresh every 30 min
    return () => clearInterval(id);
  }, []);

  // On mount: sync trust score and hw-hold from main-process authority state.
  // Main persists these to hw-auth-state.json so they survive localStorage clears.
  // On first run (isFirstRun=true) we migrate any legacy localStorage value to main.
  React.useEffect(() => {
    (async () => {
      try {
        if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
          const auth = await window.wattcoinHardware.invoke('wattcoin-get-authority-state').catch(() => null);
          if (auth) {
            // One-time migration: seed main with the localStorage value it never had.
            if (auth.isFirstRun) {
              try {
                const legacyTrust = Number(localStorage.getItem(TRUST_SCORE_STORAGE_KEY));
                const legacyHold = Number(localStorage.getItem(HW_HOLD_STORAGE_KEY) || 0);
                const seedPayload = {};
                if (Number.isFinite(legacyTrust) && legacyTrust > 0 && legacyTrust <= 100) {
                  seedPayload.trustScore = legacyTrust;
                }
                if (legacyHold > Date.now()) {
                  seedPayload.hwHoldUntilMs = legacyHold;
                }
                const seeded = await window.wattcoinHardware
                  .invoke('wattcoin-seed-authority-state', seedPayload)
                  .catch(() => null);
                if (seeded && seeded.ok && typeof seeded.trustScore === 'number') {
                  setTrustScore(seeded.trustScore);
                  trustScoreRef.current = seeded.trustScore;
                }
              } catch (_) {
                if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
              }
            } else {
              if (typeof auth.trustScore === 'number') {
                setTrustScore(auth.trustScore);
                trustScoreRef.current = auth.trustScore;
              }
            }
            if (typeof auth.hwHoldUntilMs === 'number' && auth.hwHoldUntilMs > Date.now()) {
              hardwareHoldUntilRef.current = auth.hwHoldUntilMs;
              setHardwareHoldUntilMs(auth.hwHoldUntilMs);
            }
          }
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const activateHardwareHold = React.useCallback(
    async (reason, durationMs = BENCHMARK_HOLD_DURATION_MS) => {
      if (!ENABLE_HARDWARE_HOLD) {
        return 0;
      }
      const nowMs = Date.now();
      const existingHoldUntil = Number(hardwareHoldUntilRef.current) || 0;
      if (existingHoldUntil > nowMs) {
        return existingHoldUntil;
      }

      const holdUntil = nowMs + durationMs;
      hardwareHoldUntilRef.current = holdUntil;
      setHardwareHoldUntilMs(holdUntil);
      // Trust decrement is applied by the main process in wattcoin-activate-hardware-hold;
      // renderer syncs the new value below after the IPC call returns.
      // Notify main process so the hold is persisted to the authoritative store
      // (hw-auth-state.json in userData) and cannot be cleared via localStorage.
      try {
        if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
          const holdResult = await window.wattcoinHardware
            .invoke('wattcoin-activate-hardware-hold', { durationMs })
            .catch(() => null);
          // Sync trust + hold from main after it applies the decrement.
          const authAfterHold = await window.wattcoinHardware.invoke('wattcoin-get-authority-state').catch(() => null);
          if (authAfterHold && typeof authAfterHold.trustScore === 'number') {
            setTrustScore(authAfterHold.trustScore);
            trustScoreRef.current = authAfterHold.trustScore;
          }
          void holdResult;
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }

      if (mining) {
        setMining(false);
        setRealMineStatus('Mining stopped: hardware on hold');
        try {
          if (window.wattcoinHardware && window.wattcoinHardware.stopHardwareLoad) {
            await window.wattcoinHardware.stopHardwareLoad();
          } else if (window.wattcoinHardware && window.wattcoinHardware.setHardwareLoad) {
            await window.wattcoinHardware.setHardwareLoad(0);
          }
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }
        setLog((log) => [
          {
            time: now(),
            msg: `Hardware hold activated: ${reason}. Mining stopped automatically.`,
            type: 'warn',
          },
          ...log,
        ]);
      }

      return holdUntil;
    },
    [mining, setMining, setLog, now],
  );

  const runBenchmark = React.useCallback(
    async (reason = 'manual', { extended = false } = {}) => {
      if (ENABLE_HARDWARE_HOLD && hardwareHoldUntilRef.current > Date.now()) {
        return { skipped: true, reason: 'hold-active' };
      }
      if (benchmarkInFlightRef.current) return null;
      benchmarkInFlightRef.current = true;
      setBenchmarkState((prev) => ({ ...prev, running: true }));

      // For startup and slider-stop benchmarks: apply the slider's hardware load so
      // measurements are taken under real working conditions.  The hardware load ramp
      // takes ~3 s, so we wait before measuring.  Afterward the load is stopped if
      // mining was not already active when the benchmark started.
      const isBaselineBench = reason === 'startup' || reason === 'slider-stop';
      const wasMiningAtStart = miningRef.current;
      const _rawBenchLoad = isBaselineBench
        ? Math.min(MAX_HARDWARE_LOAD_PERCENT, Math.max(0, loadPercentRef.current || 0))
        : 0;
      // Apply the same trust cap used by syncHardwareLoadTarget and effectiveLoadPercent
      // so the baseline benchmark runs at the same load ceiling as live mining.
      const _trustFBench = Math.min(1.0, 0.2 + (trustScoreRef.current / 100) * 0.8);
      const benchLoadPct = Math.min(_rawBenchLoad, Math.round(_trustFBench * 100));

      // Poll the hardware load state until the ramp completes and duty cycle
      // reaches near the target, so the benchmark measures settled conditions
      // even on cold startup where the CPU may need extra time to reach boost.
      const settleHardwareLoad = async (targetPct, minWaitMs, timeoutMs) => {
        const targetFrac = targetPct / 100;
        const start = Date.now();
        if (minWaitMs > 0) await new Promise((r) => setTimeout(r, minWaitMs));
        while (Date.now() - start < timeoutMs) {
          let settled = false;
          try {
            if (window.wattcoinHardware && window.wattcoinHardware.getHardwareLoadState) {
              const hwState = await window.wattcoinHardware.getHardwareLoadState();
              if (hwState && hwState.ok && !hwState.rampingUp) {
                const duty = Math.max(0, Math.min(1, Number(hwState.avgCpuWorkerDuty) || 0));
                const currPct = Math.max(0, Math.min(100, Number(hwState.currentPercent) || 0));
                if (currPct >= targetPct * 0.9 && duty >= targetFrac * 0.85) settled = true;
              }
            } else {
              settled = true;
            }
          } catch (_) {
            settled = true;
          }
          if (settled) break;
          await new Promise((r) => setTimeout(r, 200));
        }
      };

      if (benchLoadPct > 0 && !wasMiningAtStart) {
        try {
          if (window.wattcoinHardware && window.wattcoinHardware.setHardwareLoad) {
            await window.wattcoinHardware.setHardwareLoad(benchLoadPct);
          }
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }
        // Wait for the hardware load ramp to complete, then poll until settled.
        await settleHardwareLoad(benchLoadPct, 3000, 10000);
      } else if (isBaselineBench && wasMiningAtStart && benchLoadPct > 0) {
        // Mining: syncHardwareLoadTarget already started the ramp when the slider changed,
        // but only ~1500ms ago (the slider-stop debounce). Wait for remaining ramp + settle.
        await settleHardwareLoad(benchLoadPct, 1700, 8000);
      }

      try {
        const issues = [];
        const startedAt = performance.now();

        // Device fingerprint — stored in userData (not localStorage) so clearing browser
        // storage cannot reset cross-session drift detection (item 6).
        // Falls back to localStorage if the IPC API isn't available (dev/browser mode).
        let fingerprintHash = '';
        try {
          const fingerprintPayload = JSON.stringify({
            deviceType: hardware.deviceType || '',
            manufacturer: hardware.manufacturer || '',
            version: hardware.version || '',
            cpu: hardware.cpu || '',
            gpu: hardware.gpu || '',
            memTotalGB: Math.round(hardware.memTotalGB || 0),
            source: hardware.source || '',
            // osName, userAgent, and platform intentionally excluded: all change on
            // OS/app/Electron updates and are not indicators of hardware substitution.
            // navigator.platform is also deprecated in modern Electron/Chrome.
          });
          fingerprintHash = simpleHash(fingerprintPayload);

          const hw = window.wattcoinHardware;
          if (hw && hw.readFingerprintFile && hw.writeFingerprintFile) {
            // File-based path: userData-persisted, wallet-HMAC-signed (items 6).
            const stored = await hw.readFingerprintFile().catch(() => ({ ok: true, data: null }));
            const prevData = stored && stored.data ? stored.data : null;
            const prevHash = prevData && prevData.hash ? String(prevData.hash) : '';
            const prevFmtVer = prevData && prevData.fmtVer ? Number(prevData.fmtVer) : 1;
            // Only compare if stored hash uses the same format version.  A format bump
            // (e.g. removing volatile fields) would produce a different hash for the same
            // hardware, so we silently re-baseline instead of flagging a false change.
            if (prevHash && prevFmtVer === 2 && prevHash !== fingerprintHash) {
              issues.push('device fingerprint changed unexpectedly');
            }
            await hw.writeFingerprintFile({ hash: fingerprintHash, fmtVer: 2, ts: Date.now() }).catch(() => null);
          } else {
            // localStorage fallback (browser/dev mode).
            let secret = localStorage.getItem(FINGERPRINT_SECRET_STORAGE_KEY);
            if (!secret) {
              const _buf = new Uint32Array(2);
              window.crypto.getRandomValues(_buf);
              secret = `${_buf[0].toString(36)}-${_buf[1].toString(36)}`;
              localStorage.setItem(FINGERPRINT_SECRET_STORAGE_KEY, secret);
            }
            const expectedSig = simpleHash(`${secret}|${fingerprintHash}`);
            const prevHash = localStorage.getItem(FINGERPRINT_HASH_STORAGE_KEY) || '';
            const prevSig = localStorage.getItem(FINGERPRINT_SIG_STORAGE_KEY) || '';
            if (prevHash && prevSig === simpleHash(`${secret}|${prevHash}`) && prevHash !== fingerprintHash) {
              issues.push('device fingerprint changed unexpectedly');
            }
            localStorage.setItem(FINGERPRINT_HASH_STORAGE_KEY, fingerprintHash);
            localStorage.setItem(FINGERPRINT_SIG_STORAGE_KEY, expectedSig);
          }
        } catch (_) {
          issues.push('fingerprint persistence check failed');
        }

        // Backend benchmark workload (CPU, memory, GPU provider metric).
        const backendBench =
          window.wattcoinHardware && window.wattcoinHardware.runBackendBenchmark
            ? await window.wattcoinHardware
                .runBackendBenchmark({
                  reason,
                  allowGpuWorkloads,
                  phaseCount: 4,
                  phaseDurationMs: extended ? 200 : 100,
                  cpuSpeedRuns: reason === 'startup' || reason === 'slider-stop' ? 3 : 2,
                  memBytes: 128 * 1024 * 1024, // 128 MB — exceeds L3 cache on virtually all consumer
                  // CPUs (Intel max ~36 MB, standard AMD max ~64 MB),
                  // ensuring DRAM bandwidth is measured, not L3 cache.
                  // Hardware description strings for main-process authoritative calibration.
                  // Main uses its own copy of the lookup tables (hardware-tables.cjs) so these
                  // cannot be spoofed to inflate the calibration ratio.
                  // Main also cross-checks these against OS-level APIs (os.cpus(), Electron
                  // GPU info, systeminformation chassis) and applies a trust penalty + TDP
                  // clamp if mismatches are detected.
                  declaredCpuModel: hardware.cpu ? hardware.cpu.split(' (')[0] : '',
                  declaredGpuModel: hardware.gpu || '',
                  declaredDeviceType: hardware.deviceType || '',
                  declaredMemType: hardware.memory || '',
                  declaredMemSpeedMhz: hardware.memSpeedMhz || 0,
                  declaredMemSticks: hardware.memSticks || 1,
                  // Declared calibrated TDP so main can establish the per-tick energy ceiling.
                  // Main applies its own calibration factor on top so declaring a wrong model
                  // is penalised by the benchmark-measured ops ratio.
                  declaredUnitPowerW: unitFullPowerWRef.current || 0,
                  declaredGpuCount: Array.isArray(hardware && hardware.gpus) ? hardware.gpus.length : 0,
                  isBaselineBenchmark: reason === 'startup' || reason === 'slider-stop',
                })
                .catch((e) => {
                  console.error('[Benchmark] IPC error:', e && e.message ? e.message : e);
                  return null;
                })
            : null;
        if (!(backendBench && backendBench.ok)) {
          throw new Error(
            `backend benchmark unavailable${backendBench && backendBench.message ? `: ${backendBench.message}` : ''}`,
          );
        }
        const challengeSeed = Number(backendBench.challengeSeed) || 0;
        const cpuOpsPerSec = Math.max(0, Number(backendBench.cpuOpsPerSec) || 0);
        const memoryMBps = Math.max(0, Number(backendBench.memoryMBps) || 0);
        const jitterRatio = Math.max(0, Number(backendBench.jitterRatio) || 0);
        let cpuSpeedOpsPerSec = Math.max(0, Number(backendBench.cpuSpeedOpsPerSec) || 0);
        // Renderer-side calibration: runCpuProbe executes in the same V8 isolate and
        // CPU core affinity as the actual probe, so its measurement reflects the true
        // probe throughput. On hybrid CPUs (Intel P-core/E-core) the backend benchmark
        // (Node.js main process) may land on slower E-cores, producing a lower ops/sec
        // that would inflate expectedMs and trigger false-positive suspiciously-fast flags.
        try {
          const CALIBRATION_ITERS = 20000000;
          const calSeed = Number(backendBench.cpuSpeedInitialSeed) || 1;
          const calStart = performance.now();
          runCpuProbe(calSeed, CALIBRATION_ITERS, false);
          const calElapsed = Math.max(1, performance.now() - calStart);
          const rendererSpeed = Math.round((CALIBRATION_ITERS / calElapsed) * 1000);
          if (rendererSpeed > cpuSpeedOpsPerSec) cpuSpeedOpsPerSec = rendererSpeed;
        } catch (_) {
          /* renderer calibration is non-fatal */
        }
        const _cpuSamples = Array.isArray(backendBench.cpuSamples) ? backendBench.cpuSamples : [cpuOpsPerSec];
        const memLatencyNs = Math.max(0, Number(backendBench.memLatencyNs) || 0);

        // Item 2: measurement-derived hardware tiers — independent of declared hardware names.
        // Power credit is anchored to what was actually measured, not what was declared.
        // Tier 1 = weakest measurable / VM; tier 5 = enthusiast.
        const cpuSpeedTier =
          cpuSpeedOpsPerSec < 1e8
            ? 1
            : cpuSpeedOpsPerSec < 2e8
              ? 2
              : cpuSpeedOpsPerSec < 4e8
                ? 3
                : cpuSpeedOpsPerSec < 6e8
                  ? 4
                  : 5;
        // Memory latency tier: lower ns = faster RAM = higher tier.
        const memLatencyTier =
          memLatencyNs <= 0
            ? 1
            : memLatencyNs < 40
              ? 5 // DDR5 / HBM
              : memLatencyNs < 70
                ? 4 // DDR4-3600+
                : memLatencyNs < 100
                  ? 3 // DDR4-2400
                  : memLatencyNs < 150
                    ? 2 // DDR3 / slow DDR4
                    : 1; // very slow / virtual

        // Proof integrity: Node re-runs the same computation and confirms the hash matches.
        // A false value means the Node process itself is corrupted/patched — treat as fatal.
        if (backendBench.cpuSpeedProofVerified === false) {
          issues.push('cpu speed proof failed verification — benchmark integrity compromised');
        }
        if (backendBench.memProofVerified === false) {
          issues.push('memory proof failed verification — benchmark integrity compromised');
        }
        if (jitterRatio > 0.45) {
          issues.push('high benchmark jitter detected');
        }
        const logicalCores = Math.max(
          1,
          Number(hardware.logicalCores) || Number(hardware.physicalCores) || Number(navigator.hardwareConcurrency) || 1,
        );
        const minExpectedCpu = logicalCores * 50_000;
        if (cpuOpsPerSec < minExpectedCpu) {
          issues.push('cpu throughput below expected envelope');
        }
        if (memoryMBps < 500) {
          issues.push('memory bandwidth below expected envelope');
        }

        // Hardware-specific ops/s validation: compare measured CPU speed against the
        // expected throughput for the declared CPU model.  Catches extreme mismatches
        // (claimed hardware that would be physically impossible at the reported ops/s)
        // and calibrates the TDP power estimate using the actual performance fraction.
        const cpuKey = hardware.cpu ? hardware.cpu.split(' (')[0] : '';
        let expectedSpeedOps = getExpectedCpuSpeedOps(cpuKey);
        if (expectedSpeedOps <= 0) {
          // Fallback: estimate expected ops/s from CPU model tier + generation.
          // Uses piecewise per-generation values calibrated to the database.
          const m = cpuKey;
          let tierEstimate = 0;
          // ── Intel ──────────────────────────────────────────────────────
          // Extract tier (3/5/7/9) and generation prefix from model number.
          // "i7-14700KF" → tier=7, model="14700", gen=14.
          // "i5-1035G1" → tier=5, model="1035", gen=10.
          const intelMatch = m.match(/Core.*\bi([3579])\D(\d{4,5})/i);
          if (intelMatch) {
            const tier = Number(intelMatch[1]);
            const modelStr = intelMatch[2];
            const genPrefix = modelStr.length >= 5 ? Number(modelStr.slice(0, 2)) : Number(modelStr.slice(0, 1));
            const perGen = [
              // [minGen, {tier → ops/s}]
              [13, { 3: 460e6, 5: 520e6, 7: 560e6, 9: 600e6 }], // Raptor Lake Refresh
              [12, { 3: 420e6, 5: 470e6, 7: 490e6, 9: 520e6 }], // Alder Lake
              [10, { 3: 390e6, 5: 440e6, 7: 470e6, 9: 480e6 }], // Comet / Rocket Lake
              [8, { 3: 340e6, 5: 380e6, 7: 420e6, 9: 450e6 }], // Coffee Lake
              [6, { 3: 300e6, 5: 350e6, 7: 380e6, 9: 400e6 }], // Skylake / Kaby Lake
              [0, { 3: 250e6, 5: 300e6, 7: 340e6, 9: 380e6 }], // Sandy / Ivy / Haswell
            ];
            for (const [minGen, map] of perGen) {
              if (genPrefix >= minGen) {
                tierEstimate = map[tier];
                break;
              }
            }
          }
          // ── AMD Ryzen ──────────────────────────────────────────────────
          // "Ryzen 7 7800X3D" → tier=7, 7000 series
          const amdMatch = m.match(/Ryzen\s+(\d+)\s+(\d)/i);
          if (amdMatch && !tierEstimate) {
            const tier = Number(amdMatch[1]);
            const series = Number(amdMatch[2]);
            const perSeries = [
              [9, { 3: 400e6, 5: 540e6, 7: 560e6, 9: 580e6 }], // Zen 5
              [7, { 3: 380e6, 5: 520e6, 7: 520e6, 9: 560e6 }], // Zen 4
              [5, { 3: 385e6, 5: 440e6, 7: 450e6, 9: 470e6 }], // Zen 3
              [3, { 3: 370e6, 5: 400e6, 7: 410e6, 9: 420e6 }], // Zen 2
              [0, { 3: 280e6, 5: 320e6, 7: 330e6, 9: 350e6 }], // Zen+
            ];
            for (const [minSeries, map] of perSeries) {
              if (series >= minSeries) {
                tierEstimate = map[tier];
                break;
              }
            }
          }
          // ── Apple Silicon ──────────────────────────────────────────────
          const appleMatch = m.match(/M(\d)/i);
          if (appleMatch && !tierEstimate) {
            const gen = Number(appleMatch[1]);
            tierEstimate = gen >= 4 ? 620e6 : gen >= 3 ? 550e6 : gen >= 2 ? 500e6 : 440e6;
          }
          // ── Generic fallback ──────────────────────────────────────────
          expectedSpeedOps = Math.max(50_000_000, tierEstimate || 300_000_000);
        }
        let hardwareOpsRatio = 1.0; // default: no calibration data
        if (expectedSpeedOps > 0 && cpuSpeedOpsPerSec > 0) {
          hardwareOpsRatio = cpuSpeedOpsPerSec / expectedSpeedOps;
          if (hardwareOpsRatio > 3.5) {
            // Measured ops/s is impossibly high for the declared CPU → possible spoofing.
            issues.push(
              `cpu speed ${Math.round(cpuSpeedOpsPerSec / 1e6)}M ops/s exceeds expected ${Math.round(expectedSpeedOps / 1e6)}M for declared hardware`,
            );
          }
          if (hardwareOpsRatio < 0.08) {
            // More than 12× below expected → hardware claim implausible (VM with wrong CPU label?).
            issues.push(
              `cpu speed ${Math.round(cpuSpeedOpsPerSec / 1e6)}M ops/s far below expected ${Math.round(expectedSpeedOps / 1e6)}M for declared hardware`,
            );
          }
        }
        // Ops calibration: blend 50% fixed + 50% ratio-adjusted, clamped 0.20–1.20.
        // At ratio=1.0 → 1.0 (no change); at ratio=0.5 → 0.75 (thermal throttle reflected).
        const newOpsCalibration =
          expectedSpeedOps > 0 && cpuSpeedOpsPerSec > 0
            ? Math.min(1.2, Math.max(0.2, 0.5 + 0.5 * hardwareOpsRatio))
            : 1.0;
        setBenchmarkOpsCalibration(newOpsCalibration);

        // Memory bandwidth calibration: compare measured sequential bandwidth to expected for
        // the declared memory type + speed.  Flags impossible values (e.g. DDR5-6000 speed but
        // DDR3-tier bandwidth) and scales the memory TDP contribution accordingly.
        const _randomMemBandwidthMBps = Math.max(0, Number(backendBench.randomMemBandwidthMBps) || 0);
        // memLatencyNs already declared above (used for tier computation).
        const expectedMemBwMBps = getExpectedMemBandwidthMBps(
          hardware.memory,
          hardware.memSpeedMhz || 0,
          hardware.memSticks || 1,
        );
        let memBwRatio = 1.0;
        if (expectedMemBwMBps > 0 && memoryMBps > 0) {
          memBwRatio = memoryMBps / expectedMemBwMBps;
          if (memBwRatio > 3.0) {
            issues.push(
              `memory bandwidth ${Math.round(memoryMBps / 1024)} GB/s exceeds expected ${Math.round(expectedMemBwMBps / 1024)} GB/s for declared spec`,
            );
          }
          if (memBwRatio < 0.25) {
            issues.push(
              `memory bandwidth ${Math.round(memoryMBps / 1024)} GB/s far below expected ${Math.round(expectedMemBwMBps / 1024)} GB/s for declared spec`,
            );
          }
        }
        const newMemCalibration =
          expectedMemBwMBps > 0 && memoryMBps > 0 ? Math.min(1.2, Math.max(0.2, 0.5 + 0.5 * memBwRatio)) : 1.0;
        setBenchmarkMemCalibration(newMemCalibration);

        // GPU ALU-score calibration: only run for desktops with discrete GPUs.
        // Laptops are modelled as a single thermal unit (CPU+iGPU envelope), so GPU
        // benchmarking is meaningless there.  Also skip for any device where GPU
        // workloads are disabled (allowGpuWorkloads = false).
        // runWebGLBenchmark now uses a DOM canvas (hardware-accelerated path) and
        // already returns null if readPixels failed to actually drag the GPU pipeline.
        let gpuScore = 0;
        let _gpuScoreElapsedMs = 0;
        if (allowGpuWorkloads) {
          try {
            const gpuBench = await runWebGLBenchmark();
            if (gpuBench && gpuBench.score) {
              gpuScore = gpuBench.score;
              _gpuScoreElapsedMs = gpuBench.elapsedMs;
            } else if (gpuBench && gpuBench.error) {
              issues.push('gpu-bench: ' + gpuBench.error);
            }
          } catch (_) {
            if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
          }
        }
        const declaredGpus =
          Array.isArray(hardware.gpus) && hardware.gpus.length > 0
            ? hardware.gpus
            : hardware.gpu && hardware.gpu !== 'Unknown'
              ? [hardware.gpu]
              : [];
        // Use the highest-ranked expected score among declared GPUs (multi-GPU systems)
        let maxExpectedGpuScore = 0;
        let _gpuTableMatch = false;
        for (const g of declaredGpus) {
          const exp = getExpectedGpuScore(g);
          if (exp > maxExpectedGpuScore) {
            maxExpectedGpuScore = exp;
            _gpuTableMatch = true;
          }
        }
        if (
          maxExpectedGpuScore > 0 &&
          !declaredGpus.some((g) => {
            // Re-check if any GPU was truly matched (not just the fallback 3_500_000)
            // by seeing if at least one model string matched a named entry.
            return /RTX|GTX|RX\s*[5-9]|Arc|Vega|Iris|UHD|HD Graphics|Radeon|M[1-4]/i.test(g);
          })
        ) {
          console.warn(
            '[GPU] Unrecognised GPU model(s):',
            declaredGpus.join(', '),
            '- using fallback expected score 3.5M ops/ms',
          );
        }
        // True when at least one declared GPU is a named, table-matched entry.
        // For known GPUs, substituting the table value when readPixels doesn’t stall
        // is correct behaviour — not an anomaly worth flagging.
        const _isNamedGpu = declaredGpus.some((g) =>
          /RTX|GTX|RX\s*[5-9]|Arc|Vega|Iris|UHD|HD Graphics|Radeon|M[1-4]/i.test(g),
        );
        let gpuScoreRatio = 1.0;
        if (allowGpuWorkloads && maxExpectedGpuScore > 0 && gpuScore > 0) {
          gpuScoreRatio = gpuScore / maxExpectedGpuScore;
          if (gpuScoreRatio < 0.05) {
            issues.push(
              `GPU score ${Math.round(gpuScore / 1e3)}K ops/ms far below expected ${Math.round(maxExpectedGpuScore / 1e3)}K for declared GPU (integrated-only?)`,
            );
          }
        }
        const newGpuCalibration =
          allowGpuWorkloads && maxExpectedGpuScore > 0 && gpuScore > 0
            ? Math.min(1.2, Math.max(0.2, 0.5 + 0.5 * gpuScoreRatio))
            : 1.0;
        setBenchmarkGpuCalibration(newGpuCalibration);
        // Report GPU calibration to main process so it owns the authoritative value.
        // GPU benchmarking requires WebGL and must run in the renderer; main process
        // receives the raw score and performs the same ratio calc independently.
        let gpuCalibResult = null;
        if (allowGpuWorkloads && maxExpectedGpuScore > 0 && gpuScore > 0) {
          try {
            if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
              gpuCalibResult = await window.wattcoinHardware
                .invoke('wattcoin-report-gpu-calibration', {
                  gpuScore,
                  maxExpectedScore: maxExpectedGpuScore,
                })
                .catch(() => null);
            }
          } catch (_) {
            if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
          }
        }

        // GPU proof: single deterministic integer-shader render keyed by challengeSeed.
        // Node verifies it independently using computeGpuProbeExpectedHash (pure JS,
        // no GPU needed) — requires WebGL2; skipped on software-rendered contexts.
        let gpuProofHash = '';
        let gpuProofVerified = false;
        if (allowGpuWorkloads) {
          try {
            const gpuProof = await runGpuBenchmarkProof(challengeSeed, GPU_PROOF_SIZE, GPU_PROOF_ITERS);
            if (gpuProof) {
              gpuProofHash = gpuProof.proofHash;
              if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
                const vr = await window.wattcoinHardware
                  .invoke('wattcoin-verify-gpu-proof', {
                    seed: challengeSeed,
                    size: GPU_PROOF_SIZE,
                    shaderIterations: GPU_PROOF_ITERS,
                    proofHash: gpuProofHash,
                  })
                  .catch(() => null);
                gpuProofVerified = !!(vr && vr.verified);
              }
              if (!gpuProofVerified) {
                issues.push('gpu proof failed verification — GPU render may be software-emulated');
              }
              if (gpuProof.benchError) {
                issues.push(gpuProof.benchError);
              }
              // Always use the proof's embedded MAD benchmark score — it runs on the
              // same DOM canvas path that produced the proof, so it is guaranteed to
              // reflect real GPU execution. Prefer it over runWebGLBenchmark which has
              // historically been unreliable on discrete GPUs with ANGLE/D3D11.
              if (gpuProof.gpuScore > 0) {
                // Always use the raw measured score — let the real number show.
                gpuScore = gpuProof.gpuScore;
                gpuScoreRatio = maxExpectedGpuScore > 0 ? gpuProof.gpuScore / maxExpectedGpuScore : 1.0;
                if (gpuScoreRatio < 0.05) {
                  issues.push(
                    `GPU score ${Math.round(gpuScore / 1e3)}K ops/ms far below expected ${Math.round(maxExpectedGpuScore / 1e3)}K for declared GPU (integrated-only?)`,
                  );
                }
                setBenchmarkGpuCalibration(Math.min(1.2, Math.max(0.2, 0.5 + 0.5 * gpuScoreRatio)));
                try {
                  if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
                    gpuCalibResult = await window.wattcoinHardware
                      .invoke('wattcoin-report-gpu-calibration', {
                        gpuScore,
                        maxExpectedScore: maxExpectedGpuScore,
                      })
                      .catch(() => null);
                  }
                } catch (_) {
                  if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
                }
              }
            }
          } catch (_) {
            if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
          }
        }

        // Initialise native GPU binary path with detected GPU count so that
        // per-GPU native processes are ready when the slider triggers load.
        if (allowGpuWorkloads && window.wattcoinHardware && window.wattcoinHardware.invoke) {
          const gpuCount = Array.isArray(hardware && hardware.gpus) ? hardware.gpus.length : 0;
          if (gpuCount > 0) {
            window.wattcoinHardware.invoke('wattcoin-gpu-info', { gpuCount }).catch(() => {});
          }
        }

        // Startup and slider-stop benchmarks define new baselines — no drift check.
        const _adoptSliderBaseline = reason === 'slider-stop';
        const isBaselineBenchmark = reason === 'startup' || reason === 'slider-stop';
        if (isBaselineBenchmark) {
          benchmarkRefCpuOpsRef.current = cpuOpsPerSec;
          benchmarkRefMemBwRef.current = memoryMBps;
          benchmarkRefMemLatencyRef.current = memLatencyNs > 0 ? memLatencyNs : null;
          benchmarkRefGpuScoreRef.current = gpuScore > 0 ? gpuScore : null;
          benchmarkRefJitterRef.current = jitterRatio > 0 ? jitterRatio : null;
          benchmarkRetryPendingRef.current = false;
        } else {
          let retryEscalationReason = '';
          let scheduleExtendedRetry = false;
          // Multi-metric drift detection: flag any metric that drifts >25% from its per-session baseline.
          const driftChecks = [];

          const refOps = benchmarkRefCpuOpsRef.current;
          if (refOps !== null && refOps > 0) {
            const d = Math.abs(cpuOpsPerSec - refOps) / refOps;
            if (d > BENCHMARK_DRIFT_THRESHOLD) driftChecks.push(`cpu ${(d * 100).toFixed(1)}%`);
          } else {
            benchmarkRefCpuOpsRef.current = cpuOpsPerSec;
          }

          const refMemLatency = benchmarkRefMemLatencyRef.current;
          if (refMemLatency !== null && refMemLatency > 0 && memLatencyNs > 0) {
            const d = Math.abs(memLatencyNs - refMemLatency) / refMemLatency;
            if (d > BENCHMARK_DRIFT_THRESHOLD) driftChecks.push(`ddr latency ${(d * 100).toFixed(1)}%`);
          } else if (memLatencyNs > 0) {
            benchmarkRefMemLatencyRef.current = memLatencyNs;
          }

          const refGpu = benchmarkRefGpuScoreRef.current;
          if (refGpu !== null && refGpu > 0 && gpuScore > 0) {
            const d = Math.abs(gpuScore - refGpu) / refGpu;
            if (d > BENCHMARK_DRIFT_THRESHOLD) driftChecks.push(`gpu ${(d * 100).toFixed(1)}%`);
          } else if (gpuScore > 0) {
            benchmarkRefGpuScoreRef.current = gpuScore;
          }

          // Jitter is inherently noisy; relative drift against a small baseline produces massive
          // false positives. It is already capped by the absolute >45% threshold above, so skip
          // relative jitter drift here and just keep the baseline current.
          if (jitterRatio > 0) benchmarkRefJitterRef.current = jitterRatio;

          if (driftChecks.length > 0) {
            const driftDesc = driftChecks.join(', ');
            if (benchmarkRetryPendingRef.current) {
              // Second consecutive drift: 5-min hardware hold + -10 trust (applied by activateHardwareHold).
              retryEscalationReason = `drift on retry: ${driftDesc}`;
              issues.push(`benchmark drift on retry: ${driftDesc}`);
            } else {
              // First drift: immediate 2x extended re-benchmark.
              scheduleExtendedRetry = true;
              issues.push(`benchmark drift (${driftDesc}) extended re-benchmark scheduled`);
            }
          } else {
            // No significant drift: update baselines to track gradual hardware changes.
            if (cpuOpsPerSec > 0) benchmarkRefCpuOpsRef.current = cpuOpsPerSec;
            if (memoryMBps > 0) benchmarkRefMemBwRef.current = memoryMBps;
            if (memLatencyNs > 0) benchmarkRefMemLatencyRef.current = memLatencyNs;
            if (gpuScore > 0) benchmarkRefGpuScoreRef.current = gpuScore;
            if (jitterRatio > 0) benchmarkRefJitterRef.current = jitterRatio;
          }

          const benchmarkIssues = issues.filter((issue) => {
            const text = String(issue || '');
            return (
              text && !text.includes('extended re-benchmark scheduled') && !text.startsWith('benchmark drift on retry:')
            );
          });

          if (!retryEscalationReason && benchmarkIssues.length > 0) {
            const issueDesc = benchmarkIssues.join(', ');
            if (benchmarkRetryPendingRef.current || reason === 'retry-drift') {
              retryEscalationReason = `benchmark issues on retry: ${issueDesc}`;
              issues.push(`benchmark issues persisted on retry: ${issueDesc}`);
            } else if (!scheduleExtendedRetry) {
              scheduleExtendedRetry = true;
              issues.push(`benchmark issues (${issueDesc}) extended re-benchmark scheduled`);
            }
          }

          if (retryEscalationReason) {
            await activateHardwareHold(retryEscalationReason);
            benchmarkRetryPendingRef.current = false;
          } else if (scheduleExtendedRetry) {
            benchmarkRetryPendingRef.current = true;
            setTimeout(() => {
              if (!benchmarkInFlightRef.current && hardwareHoldUntilRef.current <= Date.now()) {
                runBenchmark('retry-drift', { extended: true });
              }
            }, 0);
          } else {
            benchmarkRetryPendingRef.current = false;
          }
        }

        // Score — computed after all issue checks so every detected issue penalises the result.
        let score = 100;
        if (!isBaselineBenchmark) {
          score -= Math.min(60, issues.length * 12);
          if (jitterRatio > 0.3) score -= 8;
        }
        score = Math.max(0, Math.min(100, Math.round(score)));

        // Cross-session performance baseline: persist ops/sec to detect hardware spoofing between sessions.
        try {
          const baselineSecret = localStorage.getItem(FINGERPRINT_SECRET_STORAGE_KEY) || '';
          const prevOpsStr = localStorage.getItem(BENCH_BASELINE_OPS_KEY) || '';
          const prevSig = localStorage.getItem(BENCH_BASELINE_SIG_KEY) || '';
          if (prevOpsStr && prevSig === simpleHash(`${baselineSecret}|${prevOpsStr}|0`)) {
            const prevOps = Number(prevOpsStr);
            if (Number.isFinite(prevOps) && prevOps > 0) {
              const crossDrift = Math.abs(cpuOpsPerSec - prevOps) / prevOps;
              if (crossDrift > 0.65) {
                issues.push(`cross-session cpu drift ${(crossDrift * 100).toFixed(1)}%`);
              }
            }
          }
          const opsStr = Math.round(cpuOpsPerSec).toString();
          const newSig = simpleHash(`${baselineSecret}|${opsStr}|0`);
          localStorage.setItem(BENCH_BASELINE_OPS_KEY, opsStr);
          localStorage.setItem(BENCH_BASELINE_GPS_KEY, '0');
          localStorage.setItem(BENCH_BASELINE_SIG_KEY, newSig);
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }

        // Benchmark-derived power cap: conservative on first run, raises gradually after 10 consecutive underestimates.
        {
          const isLaptopForCap = hardware.deviceType === 'Laptop';
          const navCoresForCap = Math.max(1, navigator.hardwareConcurrency || 1);
          let newCapW;
          if (isLaptopForCap) {
            // For laptops, cap is anchored to real manufacturer TDP fetched online.
            // Starting cap = 60% of declared TDP (40% conservative buffer; max mining load is 85%).
            // It grows back toward 100% via the consecutive-clean-benchmark raise logic.
            const refTDP = totalHardwareTDPRef.current;
            if (refTDP > 0) {
              newCapW = Math.round(refTDP * 0.6);
            } else {
              // No TDP data yet: conservative ops-based fallback (small absolute numbers).
              if (cpuOpsPerSec < 200_000) newCapW = 25;
              else if (cpuOpsPerSec < 500_000) newCapW = 35;
              else if (cpuOpsPerSec < 1_000_000) newCapW = 50;
              else newCapW = 65;
            }
          } else {
            // Desktop / PC / Server: derive cap from CPU ops throughput per core + GPU metric.
            let benchCpuCapW;
            if (cpuOpsPerSec < 80_000) benchCpuCapW = 20 * navCoresForCap;
            else if (cpuOpsPerSec < 200_000) benchCpuCapW = 40 * navCoresForCap;
            else if (cpuOpsPerSec < 500_000) benchCpuCapW = 65 * navCoresForCap;
            else if (cpuOpsPerSec < 1_000_000) benchCpuCapW = 100 * navCoresForCap;
            else benchCpuCapW = 160 * navCoresForCap;
            benchCpuCapW = Math.min(benchCpuCapW, 800);
            const benchGpuCapW = allowGpuWorkloads ? 80 : 25;
            newCapW = benchCpuCapW + benchGpuCapW + 30;
          }
          // TDP ceiling: upper bound for raise steps (laptops: full 100% TDP; desktops: static table).
          // Item 2: when hardware name lookup returns 0 (unknown CPU), use measurement-derived tier
          // ceiling so declaring an unknown high-end CPU doesn't give free power headroom.
          let tdpCeilingW = 0;
          if (isLaptopForCap) {
            // Ceiling is the full declared TDP — base is 80%, raises stop at 100%.
            tdpCeilingW = totalHardwareTDPRef.current > 0 ? totalHardwareTDPRef.current : newCapW * 1.5;
          } else {
            const cpuSocketsForCap = Math.max(1, Number(hardware.cpuSockets) || 1);
            const navCoresCap2 = Math.max(1, navigator.hardwareConcurrency || 1);
            const validSocketsCap = Math.min(cpuSocketsForCap, Math.max(1, Math.floor(navCoresCap2 / 2)));
            if (hardware.cpu) {
              const cpuKeyForCap = hardware.cpu.split(' (')[0];
              const staticCpuTdp = cpuTDPTable[cpuKeyForCap];
              if (staticCpuTdp) tdpCeilingW += staticCpuTdp * validSocketsCap;
            }
            for (const m of allGpuModels) {
              const staticGpuTdp = gpuTDPTable[m];
              if (staticGpuTdp) tdpCeilingW += staticGpuTdp;
            }
            tdpCeilingW += 30; // overhead margin
            // Item 2: if hardware name tables gave us nothing (unknown CPU/GPU), fall back to
            // a tier-based ceiling derived purely from measured ops/s — prevents fake declarations
            // from granting an artificially high power ceiling.
            if (tdpCeilingW <= 30) {
              const tierCpuCeilingPerSocket =
                cpuSpeedTier === 5
                  ? 600
                  : cpuSpeedTier === 4
                    ? 350
                    : cpuSpeedTier === 3
                      ? 220
                      : cpuSpeedTier === 2
                        ? 125
                        : 65;
              tdpCeilingW = tierCpuCeilingPerSocket * validSocketsCap + (allowGpuWorkloads ? 120 : 30) + 30;
            }
          }
          const effectiveCeiling = Math.max(tdpCeilingW, newCapW);
          const currentCap = benchmarkPowerCapWRef.current;
          if (currentCap === null) {
            // First benchmark: establish the cap conservatively.
            setBenchmarkPowerCapW(newCapW);
            consecutiveUnderestimateRef.current = 0;
          } else if (newCapW > currentCap) {
            // Throughput implies more power than current cap allows — count as underestimate.
            consecutiveUnderestimateRef.current += 1;
            if (consecutiveUnderestimateRef.current >= 10) {
              const raisable = effectiveCeiling - currentCap;
              if (raisable > 0) {
                setBenchmarkPowerCapW(Math.min(currentCap + raisable / 10, effectiveCeiling));
              }
              consecutiveUnderestimateRef.current = 0;
            }
          } else {
            // Throughput within cap — keep cap, reset counter.
            consecutiveUnderestimateRef.current = 0;
          }
        }

        // Sync trust score and hw-hold from the main-process authority.
        // Main is the only party that computes trust changes — renderer reads back
        // the authoritative values including before/after snapshots for the delta.
        // trustScoreBefore / trustScoreAfter are injected by the benchmark handler.
        let lastTrustDelta = 0;
        const prevTrustForDelta =
          typeof backendBench.trustScoreBefore === 'number' ? backendBench.trustScoreBefore : trustScoreRef.current;
        try {
          if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
            const auth = await window.wattcoinHardware.invoke('wattcoin-get-authority-state').catch(() => null);
            if (auth) {
              if (typeof auth.trustScore === 'number') {
                setTrustScore(auth.trustScore);
                trustScoreRef.current = auth.trustScore;
                if (!isBaselineBenchmark) {
                  lastTrustDelta = auth.trustScore - prevTrustForDelta;
                }
                // If main triggered a hold (trust hit 0), reflect it in the renderer.
                if (!isBaselineBenchmark && auth.trustScore === 0 && prevTrustForDelta > 0 && !auth.isOnHold) {
                  await activateHardwareHold('trust score depleted: repeated anomalies detected', 24 * 60 * 60 * 1000);
                }
              }
              if (typeof auth.hwHoldUntilMs === 'number' && auth.hwHoldUntilMs > Date.now()) {
                hardwareHoldUntilRef.current = auth.hwHoldUntilMs;
                setHardwareHoldUntilMs(auth.hwHoldUntilMs);
              }
            }
          }
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }

        const elapsedMs = performance.now() - startedAt;
        const trustAfter = trustScoreRef.current;
        let bgCpuOpsPerSec = 0;
        let bgMemMBps = 0;
        let bgCpuDutyPct = 0;
        let bgMemDutyPct = 0;
        try {
          if (window.wattcoinHardware && window.wattcoinHardware.getHardwareLoadState) {
            const hwState = await window.wattcoinHardware.getHardwareLoadState();
            if (hwState && hwState.ok) {
              bgCpuOpsPerSec = Math.max(0, Number(hwState.cpuLoadOpsPerSec) || 0);
              bgMemMBps = Math.max(0, Number(hwState.memLoadMBps) || 0);
              bgCpuDutyPct = Math.max(0, Math.min(100, (Number(hwState.avgCpuWorkerDuty) || 0) * 100));
              bgMemDutyPct = Math.max(0, Math.min(100, (Number(hwState.memDuty) || 0) * 100));
            }
          }
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }
        const totalCpuWorkOpsPerSec = cpuOpsPerSec + bgCpuOpsPerSec;
        const totalMemWorkMBps = memoryMBps + bgMemMBps;
        const gpuDutyPct = Math.max(0, Math.min(100, gpuMeasuredDutyRef.current * 100));
        const gpuActualWorkOpsPerMs = gpuScore > 0 ? gpuScore * (gpuDutyPct / 100) : 0;
        const summary =
          `Benchmark score: ${score}/100` +
          `, cpu-speed ${fmtNum(cpuSpeedOpsPerSec, 0)} ops/s${expectedSpeedOps > 0 ? ` (${(hardwareOpsRatio * 100).toFixed(0)}% of expected)` : ''}` +
          `, cpu-phase ${fmtNum(cpuOpsPerSec, 0)} ops/s` +
          `, cpu-total ${fmtNum(totalCpuWorkOpsPerSec, 0)} ops/s (bench ${fmtNum(cpuOpsPerSec, 0)} + bg ${fmtNum(bgCpuOpsPerSec, 0)} @${bgCpuDutyPct.toFixed(0)}%)` +
          `, mem-seq ${fmtNum(memoryMBps, 0)} MB/s${expectedMemBwMBps > 0 ? ` (${(memBwRatio * 100).toFixed(0)}% of expected)` : ''}` +
          `, mem-total ${fmtNum(totalMemWorkMBps, 0)} MB/s (bench ${fmtNum(memoryMBps, 0)} + bg ${fmtNum(bgMemMBps, 0)} @${bgMemDutyPct.toFixed(0)}%)` +
          (memLatencyNs > 0 ? `, mem-latency ${memLatencyNs.toFixed(0)} ns` : '') +
          (allowGpuWorkloads
            ? gpuScore > 0
              ? `, gpu-score ${fmtNum(gpuScore, 0)} ops/ms${maxExpectedGpuScore > 0 ? ` (${(gpuScoreRatio * 100).toFixed(0)}% of expected)` : ''}`
              : ', gpu-score n/a'
            : '') +
          (allowGpuWorkloads
            ? gpuScore > 0
              ? `, gpu-total ${fmtNum(gpuActualWorkOpsPerMs, 0)} ops/ms (bench ${fmtNum(gpuScore, 0)} @${gpuDutyPct.toFixed(1)}%)`
              : `, gpu-total duty ${gpuDutyPct.toFixed(1)}%`
            : '') +
          `, jitter ${(jitterRatio * 100).toFixed(1)}%, challenge ${challengeSeed}` +
          `, trust ${trustAfter}/100${!isBaselineBenchmark ? ` (${lastTrustDelta > 0 ? '+' : ''}${lastTrustDelta})` : ''}` +
          `, cpu-proof ${backendBench.cpuSpeedProof || 'n/a'} (seed ${backendBench.cpuSpeedInitialSeed || 0})` +
          `, mem-proof ${backendBench.memProof || 'n/a'}` +
          (gpuProofHash
            ? `, gpu-proof ${gpuProofHash}${gpuProofVerified ? '' : ' (unverified)'}`
            : allowGpuWorkloads
              ? ', gpu-proof n/a'
              : '');
        const issueSummary = issues.length ? `issues: ${issues.join('; ')}` : 'no anomalies';

        // Compute vs-average deviation percentages using personal mean returned by main.
        const personalMeanCpu = Number(backendBench.personalMeanCpu) || 0;
        const personalMeanMem = Number(backendBench.personalMeanMem) || 0;
        const personalMeanGpuRatio = Number(gpuCalibResult && gpuCalibResult.personalMeanGpuRatio) || 0;
        const lastAvgCpuPct = personalMeanCpu > 0 ? Math.round((cpuSpeedOpsPerSec / personalMeanCpu - 1) * 100) : null;
        const lastAvgMemPct = personalMeanMem > 0 ? Math.round((memoryMBps / personalMeanMem - 1) * 100) : null;
        const lastAvgGpuPct =
          allowGpuWorkloads && maxExpectedGpuScore > 0 && gpuScore > 0 && hardware.deviceType !== 'Laptop'
            ? Math.round((gpuScoreRatio / (personalMeanGpuRatio > 0 ? personalMeanGpuRatio : 1.0) - 1) * 100)
            : null;

        const cpuPenaltyPct =
          expectedSpeedOps > 0 ? Math.max(0, 100 - Math.round((cpuSpeedOpsPerSec / expectedSpeedOps) * 100)) : -1;
        const memPenaltyPct =
          expectedMemBwMBps > 0 ? Math.max(0, 100 - Math.round((memoryMBps / expectedMemBwMBps) * 100)) : -1;
        const gpuPenaltyPct =
          allowGpuWorkloads && maxExpectedGpuScore > 0 && gpuScore > 0
            ? Math.max(0, 100 - Math.round((gpuScore / maxExpectedGpuScore) * 100))
            : -1;
        setBenchmarkState({
          running: false,
          startupDone: true,
          lastScore: score,
          lastReason: reason,
          lastSummary: `${summary} (${issueSummary})`,
          issues,
          lastJitterPct: Math.round(jitterRatio * 1000) / 10,
          lastTrustDelta,
          lastAvgCpuPct,
          lastAvgMemPct,
          lastAvgGpuPct,
          lastWasBaseline: isBaselineBenchmark,
          cpuPenaltyPct,
          memPenaltyPct,
          gpuPenaltyPct,
        });

        // If startup benchmark shows significant performance degradation,
        // prompt the user to re-benchmark before continuing to mine.
        if (isBaselineBenchmark) {
          const anyDegraded = [cpuPenaltyPct, memPenaltyPct, gpuPenaltyPct].some((p) => p > 30);
          if (anyDegraded) setShowRebenchPrompt(true);
        }

        // Persist proof data so the next mineBlock call can include it in the OP_RETURN
        // commitment.  Other nodes can then re-run cpuSpeedStep(initialSeed, N=20M) and
        // confirm the proof hash, giving them independent verification of the computation.
        benchmarkProofRef.current = {
          cpuSpeedProof: backendBench.cpuSpeedProof || '',
          cpuSpeedInitialSeed: Number(backendBench.cpuSpeedInitialSeed) || 0,
          memProof: backendBench.memProof || '',
          memProofSeed: Number(backendBench.memProofSeed) || 0,
          memLatencyNs: Math.max(0, Number(backendBench.memLatencyNs) || 0),
          gpuProof: gpuProofHash || '',
          gpuProofSeed: gpuProofHash ? challengeSeed : 0,
          gpuProofVerified,
          challengeSeed: Number(backendBench.challengeSeed) || 0,
          cpuOpsPerSec: Math.round(cpuOpsPerSec),
          cpuSpeedOpsPerSec: Math.round(cpuSpeedOpsPerSec),
          cpuTotalWorkOpsPerSec: Math.round(totalCpuWorkOpsPerSec),
          backgroundCpuOpsPerSec: Math.round(bgCpuOpsPerSec),
          memoryMBps: Math.round(memoryMBps),
          memoryTotalWorkMBps: Math.round(totalMemWorkMBps),
          backgroundMemMBps: Math.round(bgMemMBps),
          gpuScoreOpsPerMs: Math.round(gpuScore),
          gpuActualWorkOpsPerMs: Math.round(gpuActualWorkOpsPerMs),
          gpuMeasuredDutyPct: Math.round(gpuDutyPct * 10) / 10,
          jitterRatio: Math.round(jitterRatio * 10000) / 10000,
          cpuSpeedTier, // item 2: measurement-derived tier
          memLatencyTier, // item 2: measurement-derived tier
          score,
          issues: [...issues],
          benchmarkTs: Date.now(),
        };
        try {
          sessionStorage.setItem(STARTUP_BENCHMARK_DONE_STORAGE_KEY, '1');
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }

        setLog((log) => [
          {
            time: now(),
            msg: `Benchmark (${reason}${isBaselineBenchmark && benchLoadPct > 0 ? ` @${benchLoadPct}%` : ''}) in ${fmtNum(elapsedMs, 0)} ms: ${summary} (${issueSummary})`,
            type: !isBaselineBenchmark && issues.length ? 'warn' : 'info',
          },
          ...log,
        ]);

        return { score, issues };
      } catch (e) {
        setBenchmarkState((prev) => ({
          ...prev,
          running: false,
          startupDone: true,
          lastSummary: `benchmark failed: ${e && e.message ? e.message : 'unknown error'}`,
        }));
        try {
          sessionStorage.setItem(STARTUP_BENCHMARK_DONE_STORAGE_KEY, '1');
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }
        setLog((log) => [
          {
            time: now(),
            msg: `Benchmark failed (${reason}): ${e && e.message ? e.message : 'unknown error'}`,
            type: 'error',
          },
          ...log,
        ]);
        return null;
      } finally {
        benchmarkInFlightRef.current = false;
        // Stop the synthetic load if we applied it for this benchmark and mining
        // has not been activated in the meantime.
        if (benchLoadPct > 0 && !wasMiningAtStart && !miningRef.current) {
          try {
            if (window.wattcoinHardware && window.wattcoinHardware.stopHardwareLoad) {
              await window.wattcoinHardware.stopHardwareLoad();
            } else if (window.wattcoinHardware && window.wattcoinHardware.setHardwareLoad) {
              await window.wattcoinHardware.setHardwareLoad(0);
            }
          } catch (_) {
            if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
          }
        }
      }
    },
    // cpuTDPTable/gpuTDPTable are stable useMemo — omitted to avoid TDZ (declared later)
    [activateHardwareHold, allowGpuWorkloads, hardware, setLog, allGpuModels, now], // eslint-disable-line react-hooks/exhaustive-deps
  );

  function computeCoinsFromEnergy(energyWh) {
    let remainingWh = Math.max(0, Number(energyWh) || 0);
    let minedCoins = 0;
    const maxCoins = COINS_PER_TIER * TOTAL_TIERS;

    for (let tier = 0; tier < TOTAL_TIERS; tier++) {
      const energyPerCoinWh = energyForTier(tier);
      const tierCoinCap = COINS_PER_TIER;
      const tierMaxEnergyWh = tierCoinCap * energyPerCoinWh;

      if (remainingWh >= tierMaxEnergyWh) {
        minedCoins += tierCoinCap;
        remainingWh -= tierMaxEnergyWh;
      } else {
        minedCoins += remainingWh / energyPerCoinWh;
        return Math.min(maxCoins, minedCoins);
      }
    }

    return Math.min(maxCoins, minedCoins);
  }

  // Simulation mining logic removed

  // Mine a single real block attempt.
  const mineOneRealBlock = React.useCallback(
    async (blockEnergyWh = 0) => {
      if (!(window.wattcoinHardware && window.wattcoinHardware.mineBlock)) {
        console.error('[MinerSimulator] Mining API unavailable - window.wattcoinHardware.mineBlock not found');
        setRealMineStatus('Mining API unavailable');
        return false;
      }
      if (realMineBusy) return false;

      setRealMineBusy(true);
      setRealMineStatus('Mining block...');
      try {
        console.log('[MinerSimulator] Starting mining attempt with address:', miningAddress);
        // Attach the most recent benchmark proof so the OP_RETURN commitment includes
        // (cpuSpeedInitialSeed, cpuSpeedProof) — any peer can re-run the computation
        // from that seed and confirm the proof hash independently.
        const proofData = benchmarkProofRef.current
          ? {
              ...benchmarkProofRef.current,
              energyWh: blockEnergyWh,
              proofTs: Date.now(),
              miningAddress: miningAddress || '',
              peerProbeVerified: peerProbeVerifiedRef.current, // item 4
              probeReceipt: probeReceiptRef.current, // item 5
              probeChain: {
                // chained-probe continuity record
                chainHead: probeChainRef.current.chainHead,
                chainIndex: probeChainRef.current.chainIndex,
                chainBroken: probeChainRef.current.chainBroken,
              },
            }
          : null;
        // Reset per-round probe state after capturing for this block.
        peerProbeVerifiedRef.current = false;
        probeReceiptRef.current = null;
        // Chain continuity persists across blocks (chainHead/chainIndex stay intact).
        // Only reset the 'broken' flag so each new round is assessed independently.
        probeChainRef.current = { ...probeChainRef.current, chainBroken: false };
        let result = await window.wattcoinHardware.mineBlock(miningAddress || undefined, proofData);
        console.log('[MinerSimulator] Mining result:', result);

        // If selected address path fails (but not NO_PEERS), retry once without forcing address.
        if (result && result.code !== 'NO_PEERS' && result.error && miningAddress) {
          console.log('[MinerSimulator] Retrying without forcing address due to error:', result.error);
          result = await window.wattcoinHardware.mineBlock(undefined, proofData);
          console.log('[MinerSimulator] Retry result:', result);
        }

        if (result && result.code === 'NO_PEERS') {
          setRealMineStatus('Waiting for peers...');
          peerDownRef.current = true;
          return 'NO_PEERS';
        }
        if (result && result.address) {
          const blockHash = result && result.blockHash ? String(result.blockHash).trim() : '';
          const walletName = result && result.walletName ? String(result.walletName).trim() : 'wattminer';
          setRealMineStatus(blockHash ? `Block mined: ${blockHash}` : `Block mined to ${result.address}`);
          if (typeof onBlockMined === 'function') {
            try {
              await onBlockMined({
                blockHash,
                address: result.address,
                walletName,
                // Proof fields for Tier 4c coordinator re-verification (item 1).
                cpuSpeedInitialSeed: benchmarkProofRef.current
                  ? Number(benchmarkProofRef.current.cpuSpeedInitialSeed) || 0
                  : 0,
                cpuSpeedProof: benchmarkProofRef.current ? String(benchmarkProofRef.current.cpuSpeedProof || '') : '',
                memProof: benchmarkProofRef.current ? String(benchmarkProofRef.current.memProof || '') : '',
                proofIssues: benchmarkProofRef.current ? benchmarkState.issues || [] : [],
                proofCommitment: result.proofCommitment || null,
                peerProbeVerified: !!(proofData && proofData.peerProbeVerified), // item 4
                probeReceipt: proofData && proofData.probeReceipt ? proofData.probeReceipt : null, // item 5
                probeChain: proofData && proofData.probeChain ? proofData.probeChain : null, // Tier 4e coverage ratio
              });
            } catch (_) {
              if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
            }
          }
          setLog((log) => [
            {
              time: now(),
              msg: blockHash
                ? `Real block mined: hash=${blockHash}, address=${result.address}`
                : `Real block mined: address=${result.address}`,
              type: 'block',
            },
            ...log,
          ]);
          return true;
        } else {
          const errMsg = result && result.error ? result.error : 'Unknown error';
          setRealMineStatus(`Mining failed: ${errMsg}`);
          setLog((log) => [{ time: now(), msg: `Mining failed: ${errMsg}`, type: 'error' }, ...log]);
          return false;
        }
      } catch (e) {
        const errMsg = e && e.message ? e.message : 'Unknown error';
        setRealMineStatus(`Mining failed: ${errMsg}`);
        setLog((log) => [{ time: now(), msg: `Mining failed: ${errMsg}`, type: 'error' }, ...log]);
        return false;
      } finally {
        setRealMineBusy(false);
      }
    },
    [miningAddress, onBlockMined, setLog, setRealMineStatus, setRealMineBusy, benchmarkState, now, realMineBusy],
  );

  // Fetch hardware info at startup if not already found, or if deviceType is still unknown
  React.useEffect(() => {
    if (hardware && hardware.cpu !== 'Unknown' && hardware.deviceType !== 'Unknown') return;
    let cancelled = false;
    (async () => {
      try {
        const hw = await getHardwareInfo();
        if (cancelled) return;
        if (hw && hw.source) {
          setHardware(hw);
          try {
            sessionStorage.setItem('wattcoinHardware', JSON.stringify(hw));
          } catch (_) {
            if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
          }
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hardware]);

  React.useEffect(() => {
    try {
      localStorage.setItem(
        LOAD_PERCENT_STORAGE_KEY,
        String(Math.min(MAX_HARDWARE_LOAD_PERCENT, Math.max(0, Number(loadPercent) || 0))),
      );
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
    }
  }, [loadPercent]);

  React.useEffect(() => {
    let cancelled = false;

    async function syncHardwareLoadTarget() {
      if (!(window.wattcoinHardware && window.wattcoinHardware.setHardwareLoad)) return;
      // Don't override the load that runBenchmark applied for a baseline measurement.
      if (benchmarkInFlightRef.current) return;
      const clamped = Math.min(MAX_HARDWARE_LOAD_PERCENT, Math.max(0, Number(loadPercent) || 0));
      // Cap physical OS load at the trust ceiling so the machine doesn't do work that won't be credited.
      const trustF = Math.min(1.0, 0.2 + (trustScoreRef.current / 100) * 0.8);
      const trustCappedLoad = Math.min(clamped, Math.round(trustF * 100));
      // Detect number of GPUs from hardware detection
      const gpuCount = Array.isArray(hardware && hardware.gpus) ? hardware.gpus.length : 0;
      try {
        if (isHardwareOnHold) {
          if (window.wattcoinHardware.stopHardwareLoad) {
            await window.wattcoinHardware.stopHardwareLoad();
          } else {
            await window.wattcoinHardware.setHardwareLoad(0);
          }
          if (gpuCount > 0 && window.wattcoinHardware.invoke) {
            await window.wattcoinHardware.invoke('wattcoin-stop-gpu-load').catch(() => {});
          }
        } else if (mining) {
          await window.wattcoinHardware.setHardwareLoad(trustCappedLoad);
          if (gpuCount > 0 && allowGpuWorkloads && window.wattcoinHardware.invoke) {
            await window.wattcoinHardware
              .invoke('wattcoin-set-gpu-load', {
                percent: trustCappedLoad,
                gpuCount,
              })
              .catch(() => {});
          }
        } else if (window.wattcoinHardware.stopHardwareLoad) {
          await window.wattcoinHardware.stopHardwareLoad();
          if (gpuCount > 0 && window.wattcoinHardware.invoke) {
            await window.wattcoinHardware.invoke('wattcoin-stop-gpu-load').catch(() => {});
          }
        } else {
          await window.wattcoinHardware.setHardwareLoad(0);
          if (gpuCount > 0 && window.wattcoinHardware.invoke) {
            await window.wattcoinHardware.invoke('wattcoin-stop-gpu-load').catch(() => {});
          }
        }
      } catch (_) {
        if (!cancelled) {
          // Ignore backend load-control errors to keep UI responsive.
        }
      }
    }

    syncHardwareLoadTarget();
    return () => {
      cancelled = true;
    };
  }, [allowGpuWorkloads, hardware, isHardwareOnHold, loadPercent, mining]);

  // Improved benchmark: only run when dashboard is active
  React.useEffect(() => {
    if (!isActive) return;
    if (!hardware || hardware.cpu === 'Unknown') return;
    // Run the benchmark asynchronously to avoid blocking the UI
    let cancelled = false;
    let rafId = null;
    let timeoutId = null;
    if (hardware.deviceType === 'Laptop' && navigator.getBattery) {
      navigator.getBattery().then((bat) => {
        const initialLevel = bat.level;
        const initialTime = Date.now();
        timeoutId = setTimeout(() => {
          if (cancelled) return;
          function sha256(str) {
            let hash = 5381;
            for (let i = 0; i < str.length; i++) {
              hash = (hash << 5) + hash + str.charCodeAt(i);
            }
            return hash >>> 0;
          }
          let count = 0;
          const start = performance.now();
          function runBench() {
            if (cancelled) return;
            if (performance.now() - start < 5000) {
              for (let i = 0; i < 1000; i++) {
                sha256('wattcoin-bench' + count++);
              }
              rafId = requestAnimationFrame(runBench);
            } else {
              const endLevel = bat.level;
              const endTime = Date.now();
              const deltaLevel = initialLevel - endLevel;
              const deltaTime = (endTime - initialTime) / 1000; // seconds
              if (deltaLevel > 0 && bat.dischargingTime > 0) {
                const batteryCapacityWh = (bat.dischargingTime / 3600) * (bat.level * 100);
                const power = (batteryCapacityWh * deltaLevel) / (deltaTime / 3600);
                if (power > 0 && power < 200) setBenchPower(Math.round(power));
                else setBenchPower(0);
              } else {
                let est = null;
                if (count < 100000) est = 40;
                else if (count < 200000) est = 60;
                else if (count < 400000) est = 80;
                else if (count < 700000) est = 90;
                else est = 90;
                setBenchPower(est);
              }
            }
          }
          runBench();
        }, 0);
      });
    } else {
      timeoutId = setTimeout(() => {
        if (cancelled) return;
        function sha256(str) {
          let hash = 5381;
          for (let i = 0; i < str.length; i++) {
            hash = (hash << 5) + hash + str.charCodeAt(i);
          }
          return hash >>> 0;
        }
        let count = 0;
        const start = performance.now();
        function runBench() {
          if (cancelled) return;
          if (performance.now() - start < 500) {
            for (let i = 0; i < 1000; i++) {
              sha256('wattcoin-bench' + count++);
            }
            rafId = requestAnimationFrame(runBench);
          } else {
            let est = null;
            if (count < 100000) est = 80;
            else if (count < 200000) est = 120;
            else if (count < 400000) est = 200;
            else if (count < 700000) est = 350;
            else est = 600;
            let cpuTDP = null;
            let gpuTDP = null;
            const cpuSocketCount = Math.max(1, Number(hardware.cpuSockets) || 1);
            const navCoresEst = Math.max(1, navigator.hardwareConcurrency || 1);
            const validSocketsEst = Math.min(cpuSocketCount, Math.max(1, Math.floor(navCoresEst / 2)));
            if (hardware.cpu) {
              const cpuKey = hardware.cpu.replace(/ CPU(?: @ [\d.]+GHz?)?$/i, '').split(' (')[0];
              const w = cpuTDPTable[cpuKey];
              if (w) cpuTDP = w * validSocketsEst;
            }
            if (hardware.gpu && gpuTDPTable[hardware.gpu]) gpuTDP = gpuTDPTable[hardware.gpu];
            let maxTDP = 600;
            if (cpuTDP !== null && gpuTDP !== null) maxTDP = cpuTDP + gpuTDP;
            else if (cpuTDP !== null) maxTDP = cpuTDP;
            else if (gpuTDP !== null) maxTDP = gpuTDP;
            if (est !== null) setBenchPower(Math.min(est, maxTDP));
          }
        }
        runBench();
      }, 0);
    }
    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (timeoutId) clearTimeout(timeoutId);
    };
    // cpuTDPTable/gpuTDPTable are stable useMemo — omitted to avoid TDZ (declared later)
  }, [hardware, isActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // Startup benchmark runs after hardware recognition.
  // Not dashboard-gated: it must also run when another in-app tab is active.
  React.useEffect(() => {
    if (!(hardware && hardware.source)) return;
    if (isHardwareOnHold) return;
    if (benchmarkState.startupDone || benchmarkState.running) return;
    if (clampedLoadPercent === 0) return;
    const timeoutId = setTimeout(() => {
      runBenchmark('startup');
    }, 4000);
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isHardwareOnHold,
    hardware,
    benchmarkState.startupDone,
    benchmarkState.running,
    runBenchmark,
    hardwareLookupResetNonce,
  ]);

  // Run a benchmark after user stops adjusting hardware load slider.
  // Not dashboard-gated: slider-triggered baseline checks must run on any tab.
  React.useEffect(() => {
    if (!(hardware && hardware.source)) return;
    if (isHardwareOnHold) return;
    if (sliderAdjustNonce <= 0) return;
    if (sliderAdjustNonce <= lastHandledSliderAdjustNonceRef.current) return;
    if (clampedLoadPercent === 0) return;

    lastHandledSliderAdjustNonceRef.current = sliderAdjustNonce;

    const timeoutId = setTimeout(() => {
      if (!benchmarkInFlightRef.current) {
        runBenchmark('slider-stop');
      }
    }, 1500);

    return () => clearTimeout(timeoutId);
  }, [sliderAdjustNonce, isHardwareOnHold, hardware, runBenchmark]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Runtime hardware probe polling ──────────────────────────────────────────
  // While mining is active, poll every 30 s for a hardware probe job.
  //
  // Source priority:
  //   1. PEER mode  — requestPeerProbe() fetches a challenge issued by the coordinator.
  //      The coordinator measures wall-clock time independently; the worker cannot lie
  //      about speed.  CPU and memory proofs are also hash-verified.
  //   2. LOCAL mode — falls back to self-issued probes when coordinator is unreachable
  //      or node is standalone.  Proof hashes still verified by Node; timing is loose.
  //
  // CPU and memory computations run inline here so they block the JS thread for their
  // full duration (~500-2000 ms) — this is intentional and ensures the timing
  // measurement reflects true hardware throughput and is not easily faked by sleeping.
  const walletAddressRef = React.useRef(miningAddress);
  React.useEffect(() => {
    walletAddressRef.current = miningAddress;
  }, [miningAddress]);

  React.useEffect(() => {
    if (!mining) return;
    const hw = window.wattcoinHardware;
    if (!hw || !hw.requestPeerProbe || !hw.submitPeerProbeResult) return;

    const POLL_INTERVAL_MS = 2_000;
    let disposed = false;
    let inFlight = false;
    const runProbeTick = async () => {
      if (disposed || inFlight) return;
      if (!walletAddressRef.current) return;
      inFlight = true;
      try {
        // Ask Node (which knows if we're worker/standalone) for a probe.
        const response = await hw.requestPeerProbe({
          workerId: walletAddressRef.current,
          allowGpuWorkloads,
        });
        if (!response || !response.probe) {
          return;
        }
        const probe = response.probe;
        const source = response.source || 'local'; // 'peer' | 'local'
        const probeStartedAt = performance.now();

        let probeResult = null;

        if (probe.type === 'cpu') {
          _cpuProbeCallCount = 0; // exclude keepalive calls from counter
          const seed = probe.params.seed | 0 || 1;
          const iterations = probe.params.iterations | 0;
          // Warmup — keeps CPU hot; no yield here because yielding lets the CPU drop into a
          // lower power state, causing the main loop to run at reduced frequency.
          runCpuProbe(seed, 5000000);
          // Real measurement loop
          let cpuResult = runCpuProbe(seed, iterations, true);
          let mainMs = cpuResult.chunks ? cpuResult.chunks.reduce((a, b) => a + b, 0) : 0;
          let retried = false;
          // Retry once if suspiciously slow — transient dips resolve on the second attempt
          if (mainMs > 3000) {
            cpuResult = runCpuProbe(seed, iterations, true);
            mainMs = cpuResult.chunks ? cpuResult.chunks.reduce((a, b) => a + b, 0) : 0;
            retried = true;
          }
          const wallMs = Math.round(performance.now() - probeStartedAt);
          const callCount = _cpuProbeCallCount;
          _cpuProbeCallCount = 0;
          probeResult = {
            id: probe.id,
            type: 'cpu',
            proof: cpuResult.proof,
            _probeIterations: iterations,
            _intDateMs: mainMs,
            _warmupTotalMs: wallMs,
            _retried: retried ? 1 : 0,
            _chunks: cpuResult.chunks ? cpuResult.chunks.join(',') : '',
            _callCount: callCount,
            probeWallClockMs: mainMs,
          };
        } else if (probe.type === 'memory') {
          const ENTRIES = Math.max(1, Number(probe.params.entries) || 1 << 24);
          const s = probe.params.arraySeed | 0 || 1;
          const arr = new Uint32Array(ENTRIES);
          for (let fillIdx = 0; fillIdx < ENTRIES; fillIdx++) {
            arr[fillIdx] = ((fillIdx * 1664525 + s) ^ (s >>> 13)) & (ENTRIES - 1);
          }
          let idx = arr[0];
          const N = probe.params.iterations | 0;
          for (let i = 0; i < N; i++) idx = arr[idx & (ENTRIES - 1)];
          probeResult = { id: probe.id, type: 'memory', proof: (idx >>> 0).toString(16).padStart(8, '0') };
        } else if (probe.type === 'gpu') {
          // GPU probe: backend-defined render size with readPixels() for true synchronous completion.
          // Silently skip if the hardware can't run GPU probes — the background poller
          // will fetch a new probe on its next cycle.
          const gpuCount = Array.isArray(hardware && hardware.gpus) ? hardware.gpus.length : 0;
          if (gpuCount > 1 && window.wattcoinHardware && window.wattcoinHardware.invoke) {
            // Multi-GPU: run proof on ALL GPUs via native binary and collect per-device hashes
            const nativeProofs = await window.wattcoinHardware
              .invoke('wattcoin-gpu-proof', {
                seed: probe.params.seed,
                size: probe.params.size,
                shaderIterations: probe.params.shaderIterations,
              })
              .catch(() => null);
            if (
              nativeProofs &&
              nativeProofs.ok &&
              Array.isArray(nativeProofs.devices) &&
              nativeProofs.devices.length > 0
            ) {
              // All GPUs should produce the same hash (deterministic algorithm)
              const primaryHash = nativeProofs.devices[0].hash;
              const allMatch = nativeProofs.devices.every((d) => d.hash === primaryHash);
              probeResult = {
                id: probe.id,
                type: 'gpu',
                pixelHash: primaryHash || '',
                gpuCount: nativeProofs.devices.length,
                gpuHashes: nativeProofs.devices.map((d) => ({
                  deviceIndex: d.deviceIndex,
                  hash: d.hash,
                  elapsedMs: d.elapsedMs,
                })),
                gpuHashesAllMatch: allMatch,
              };
            }
          }
          // Fall back to WebGL probe for single-GPU or when native binary unavailable
          if (!probeResult) {
            const gpuResult = allowGpuWorkloads
              ? await runGpuProbe(probe.params.seed, probe.params.size, probe.params.shaderIterations)
              : null;
            if (!gpuResult || !gpuResult.pixelHash) return;
            probeResult = { id: probe.id, type: 'gpu', pixelHash: gpuResult.pixelHash, gpuCount: 1 };
          }
        } else if (probe.type === 'asic') {
          // ASIC probe: inject liveness challenge (if present), then wait for
          // fresh X11 shares.  The challenge PrevHash prevents pre-mined shares.
          const minShares = (probe.params && probe.params.minShares) || 3;
          const challengePrevHash = probe.params && probe.params.challengePrevHash;
          let shares = [];
          let shareCount = 0;
          try {
            if (challengePrevHash) {
              await window.wattcoinHardware.injectAsicCustomJob(challengePrevHash);
            }
            const fresh = await window.wattcoinHardware.waitForFreshShares(minShares);
            if (fresh && fresh.ok && Array.isArray(fresh.shares)) {
              shares = fresh.shares;
              shareCount = fresh.shareCount || 0;
            }
          } catch (_) {
            /* timeout — proceed */
          }
          probeResult = {
            id: probe.id,
            type: 'asic',
            shares,
            shareCount,
            proof: `${shares.length}:${shares.length > 0 ? shares[0].hashHex.slice(0, 16) : '0'}`,
          };
        }

        if (!probeResult) {
          return;
        }

        const submitPayload = {
          source,
          result: {
            ...probeResult,
            _peerUrl: probe._peerUrl,
            probeWallClockMs:
              probeResult.probeWallClockMs != null
                ? probeResult.probeWallClockMs
                : Math.round(performance.now() - probeStartedAt),
          },
          hardwareSpec: {
            measuredCpuOpsPerSec: Number(benchmarkProofRef.current && benchmarkProofRef.current.cpuSpeedOpsPerSec) || 0,
            measuredMemLatencyNs: Number(benchmarkProofRef.current && benchmarkProofRef.current.memLatencyNs) || 0,
            allowGpuWorkloads,
            hwPowerW: Math.max(0, Math.round(Number(totalHardwareTDPRef.current) || 0)),
            cpuModel: typeof hardware.cpu === 'string' ? hardware.cpu : '',
            gpuModels: Array.isArray(hardware.gpus) ? hardware.gpus : [],
            asicModel: typeof hardware.gpu === 'string' ? hardware.gpu : '',
          },
        };
        let verdict = await hw.submitPeerProbeResult(submitPayload);
        // Single retry after 5 s if the coordinator was transiently unreachable.
        // Avoids the probe computation being wasted due to a momentary network hiccup
        // and reduces coordinator-side timeouts from flaky connections.
        if (verdict && !verdict.ok && verdict.transient && source === 'peer') {
          await new Promise((r) => setTimeout(r, 5000));
          verdict = await hw.submitPeerProbeResult(submitPayload);
        }

        if (verdict) {
          // Item 5: capture the signed receipt from the coordinator so it can be
          // included in the next block's OP_RETURN commitment.
          if (verdict.receipt && typeof verdict.receipt === 'object') {
            probeReceiptRef.current = verdict.receipt;
          }
          // Update chained-probe continuity state from the verdict.
          // Local probes return chainHead/chainIndex/chainBroken directly.
          // Peer probes embed chain state in the receipt (coordinator-side chain).
          if (verdict.chainHead !== undefined) {
            probeChainRef.current = {
              chainHead: verdict.chainHead,
              chainIndex:
                typeof verdict.chainIndex === 'number' ? verdict.chainIndex : probeChainRef.current.chainIndex,
              chainBroken: probeChainRef.current.chainBroken || !!verdict.chainBroken,
            };
          } else if (verdict.receipt && typeof verdict.receipt.chainIndex === 'number') {
            probeChainRef.current = {
              chainHead:
                verdict.receipt.chainHead !== undefined ? verdict.receipt.chainHead : probeChainRef.current.chainHead,
              chainIndex: verdict.receipt.chainIndex,
              chainBroken: probeChainRef.current.chainBroken,
            };
          }
          if (!verdict.ok) {
            probeChainRef.current = { ...probeChainRef.current, chainBroken: true };
          }
          // Item 4: mark that a peer probe was verified this round.
          if (source === 'peer' && verdict.ok) {
            peerProbeVerifiedRef.current = true;
          }
          // Sync trust score from the main-process authority (trustScoreBefore/trustScoreAfter
          // are injected by the peer probe handler when verdict.ok === true).
          if (typeof verdict.trustScoreAfter === 'number') {
            const prev = trustScoreRef.current;
            setTrustScore(verdict.trustScoreAfter);
            trustScoreRef.current = verdict.trustScoreAfter;
            const delta =
              verdict.trustScoreAfter -
              (typeof verdict.trustScoreBefore === 'number' ? verdict.trustScoreBefore : prev);
            const pad2 = (n) => String(n).padStart(2, '0');
            const d = new Date();
            setBenchmarkState((prevState) => ({
              ...prevState,
              lastTrustDelta: delta,
              lastTrustChangeTime:
                delta !== 0 ? `${pad2(d.getHours())}.${pad2(d.getMinutes())}.${pad2(d.getSeconds())}` : null,
            }));
          }
          // Record to probe log (real-time capture; covers both local and peer probe paths).
          if (typeof setProbeLog === 'function') {
            const ts = Date.now();
            setProbeLog((prev) =>
              [
                {
                  ts,
                  id: probe.id,
                  time: now(),
                  role: 'self',
                  source,
                  type: probe.type,
                  ok: !!verdict.ok,
                  timedOut: false,
                  wallClockMs:
                    typeof verdict.probeWallClockMs === 'number'
                      ? Math.round(verdict.probeWallClockMs)
                      : typeof verdict.wallClockMs === 'number'
                        ? Math.round(verdict.wallClockMs)
                        : null,
                  rttMs: typeof verdict.rttMs === 'number' ? Math.round(verdict.rttMs) : null,
                  computeTimeMs: typeof verdict.computeTimeMs === 'number' ? Math.round(verdict.computeTimeMs) : null,
                  pixelHash: typeof probeResult.pixelHash === 'string' ? probeResult.pixelHash : '',
                  proof: typeof probeResult.proof === 'string' ? probeResult.proof : '',
                  verifierAddress:
                    verdict.receipt && typeof verdict.receipt.verifierAddress === 'string'
                      ? verdict.receipt.verifierAddress
                      : '',
                  chainIndex:
                    typeof verdict.chainIndex === 'number'
                      ? verdict.chainIndex
                      : verdict.receipt && typeof verdict.receipt.chainIndex === 'number'
                        ? verdict.receipt.chainIndex
                        : null,
                  issues: Array.isArray(verdict.issues) ? verdict.issues : [],
                  loadPercent: typeof verdict.loadPercent === 'number' ? verdict.loadPercent : null,
                  trustDelta:
                    typeof verdict.trustScoreAfter === 'number' && typeof verdict.trustScoreBefore === 'number'
                      ? verdict.trustScoreAfter - verdict.trustScoreBefore
                      : null,
                },
                ...prev,
              ].slice(0, 150),
            );
          }
          if (!verdict.ok) {
            setLog((prev) => [
              {
                time: now(),
                msg: `Hardware probe FAILED (${probe.type}, ${source}): ${(verdict.issues || []).join('; ')}`,
                type: 'warn',
              },
              ...prev,
            ]);
          }
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      } finally {
        inFlight = false;
      }
    };

    // Keep TurboFan alive for runCpuProbe between probes — prevents V8 from
    // evicting the optimized code, which was causing the first run to recompile
    // in Sparkplug (42M ops/sec) while the retry uses TurboFan (280M ops/sec).
    const keepaliveId = setInterval(() => {
      if (!disposed) runCpuProbe(1, 1);
    }, 5000);

    // Poll for probes at a fixed short interval. The actual coordinator polling
    // happens in the main process on an unpredictable schedule; this renderer-side
    // interval just drains the pre-fetched cache.
    const probeIntervalId = setInterval(() => {
      runProbeTick();
    }, POLL_INTERVAL_MS);
    runProbeTick();
    return () => {
      clearInterval(keepaliveId);
      clearInterval(probeIntervalId);
      disposed = true;
    };
  }, [mining, allowGpuWorkloads, hardware, setLog, setProbeLog, now]);

  // Poll backend probe histories every 20 s to catch:
  //   - timed-out probes (added to probeState.history by getPendingProbe when a probe expires)
  //   - coordinator-attested probes (this node verified for other workers in peer mode)
  // New entries are merged by ts to avoid duplicates with real-time entries above.
  React.useEffect(() => {
    const hw = window.wattcoinHardware;
    if (!hw || !hw.invoke || typeof setProbeLog !== 'function') return;

    async function mergeBackendHistory() {
      try {
        const [selfRes, attestRes] = await Promise.allSettled([
          hw.invoke('wattcoin-get-probe-history'),
          hw.invoke('wattcoin-get-attest-history'),
        ]);
        const selfHistory =
          selfRes.status === 'fulfilled' && selfRes.value && Array.isArray(selfRes.value.history)
            ? selfRes.value.history
            : [];
        const attestHistory =
          attestRes.status === 'fulfilled' && attestRes.value && Array.isArray(attestRes.value.history)
            ? attestRes.value.history
            : [];

        const selfEntries = selfHistory.map((h) => ({
          ts: typeof h.ts === 'number' ? h.ts : 0,
          id: typeof h.id === 'string' ? h.id : '',
          time: h.ts ? new Date(h.ts).toLocaleString('en-GB') : '—',
          role: 'self',
          source: 'local',
          type: h.type || '?',
          ok: !!h.ok,
          timedOut: Array.isArray(h.issues) && h.issues.some((i) => String(i).includes('timed out')),
          wallClockMs: typeof h.wallClockMs === 'number' ? Math.round(h.wallClockMs) : null,
          rttMs: typeof h.rttMs === 'number' ? Math.round(h.rttMs) : null,
          computeTimeMs: typeof h.computeTimeMs === 'number' ? Math.round(h.computeTimeMs) : null,
          chainIndex: typeof h.chainIndex === 'number' ? h.chainIndex : null,
          issues: Array.isArray(h.issues) ? h.issues : [],
          loadPercent: typeof h.loadPercent === 'number' ? h.loadPercent : null,
        }));
        const attestEntries = attestHistory.map((h) => ({
          ts: typeof h.ts === 'number' ? h.ts : 0,
          id: typeof h.id === 'string' ? h.id : '',
          time: h.ts ? new Date(h.ts).toLocaleString('en-GB') : '—',
          role: 'attested',
          source: 'peer',
          type: h.type || '?',
          ok: !!h.ok,
          timedOut: false,
          wallClockMs: typeof h.wallClockMs === 'number' ? Math.round(h.wallClockMs) : null,
          rttMs: typeof h.rttMs === 'number' ? Math.round(h.rttMs) : null,
          computeTimeMs: typeof h.computeTimeMs === 'number' ? Math.round(h.computeTimeMs) : null,
          chainIndex: typeof h.chainIndex === 'number' ? h.chainIndex : null,
          workerId: typeof h.workerId === 'string' ? h.workerId : '',
          pixelHash: typeof h.pixelHash === 'string' ? h.pixelHash : '',
          proof: typeof h.proof === 'string' ? h.proof : '',
          issues: Array.isArray(h.issues) ? h.issues : [],
          loadPercent: typeof h.loadPercent === 'number' ? h.loadPercent : null,
        }));

        setProbeLog((prev) => {
          const seen = new Set(prev.map((e) => e.ts));
          const newEntries = [...selfEntries, ...attestEntries].filter((e) => e.ts > 0 && !seen.has(e.ts));
          if (newEntries.length === 0) return prev;
          return [...newEntries, ...prev].sort((a, b) => b.ts - a.ts).slice(0, 150);
        });
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }
    }

    mergeBackendHistory();
    const interval = setInterval(mergeBackendHistory, 20_000);
    return () => clearInterval(interval);
  }, [setProbeLog]);

  // High-precision: Estimate power usage (W) using exact model TDP lookup, then family regex, then benchmark fallback
  // Show 0W until a real estimate is available
  let powerW = 0;
  // Exact TDP tables (expand as needed)
  const cpuTDPTable = React.useMemo(
    () => ({
      // ── Intel Core 14th Gen (Raptor Lake Refresh) — PL2 sustained all-core ─
      'Intel(R) Core(TM) i9-14900KS': 253,
      'Intel(R) Core(TM) i9-14900K': 253,
      'Intel(R) Core(TM) i9-14900KF': 253,
      'Intel(R) Core(TM) i9-14900': 65,
      'Intel(R) Core(TM) i9-14900F': 65,
      'Intel(R) Core(TM) i9-14900T': 35,
      'Intel(R) Core(TM) i7-14700K': 192,
      'Intel(R) Core(TM) i7-14700KF': 192,
      'Intel(R) Core(TM) i7-14700': 65,
      'Intel(R) Core(TM) i7-14700F': 65,
      'Intel(R) Core(TM) i7-14700T': 35,
      'Intel(R) Core(TM) i5-14600K': 181,
      'Intel(R) Core(TM) i5-14600KF': 181,
      'Intel(R) Core(TM) i5-14600': 65,
      'Intel(R) Core(TM) i5-14500': 65,
      'Intel(R) Core(TM) i5-14400': 65,
      'Intel(R) Core(TM) i5-14400F': 65,
      'Intel(R) Core(TM) i5-14400T': 35,
      'Intel(R) Core(TM) i3-14100': 60,
      'Intel(R) Core(TM) i3-14100F': 58,
      'Intel(R) Core(TM) i3-14100T': 35,
      // ── Intel Core 13th Gen (Raptor Lake) — PL2 sustained all-core ─────────
      'Intel(R) Core(TM) i9-13900KS': 253,
      'Intel(R) Core(TM) i9-13900K': 253,
      'Intel(R) Core(TM) i9-13900KF': 253,
      'Intel(R) Core(TM) i9-13900': 65,
      'Intel(R) Core(TM) i9-13900F': 65,
      'Intel(R) Core(TM) i9-13900T': 35,
      'Intel(R) Core(TM) i7-13700K': 192,
      'Intel(R) Core(TM) i7-13700KF': 192,
      'Intel(R) Core(TM) i7-13700': 65,
      'Intel(R) Core(TM) i7-13700F': 65,
      'Intel(R) Core(TM) i7-13700T': 35,
      'Intel(R) Core(TM) i5-13600K': 181,
      'Intel(R) Core(TM) i5-13600KF': 181,
      'Intel(R) Core(TM) i5-13600': 65,
      'Intel(R) Core(TM) i5-13500': 65,
      'Intel(R) Core(TM) i5-13400': 65,
      'Intel(R) Core(TM) i5-13400F': 65,
      'Intel(R) Core(TM) i5-13400T': 35,
      'Intel(R) Core(TM) i3-13100': 60,
      'Intel(R) Core(TM) i3-13100F': 58,
      'Intel(R) Core(TM) i3-13100T': 35,
      'Intel(R) Core(TM) i3-13300': 60,
      // ── Intel Core 12th Gen (Alder Lake) — PL2 sustained all-core ──────────
      'Intel(R) Core(TM) i9-12900KS': 241,
      'Intel(R) Core(TM) i9-12900K': 241,
      'Intel(R) Core(TM) i9-12900KF': 241,
      'Intel(R) Core(TM) i9-12900': 65,
      'Intel(R) Core(TM) i9-12900F': 65,
      'Intel(R) Core(TM) i9-12900T': 35,
      'Intel(R) Core(TM) i7-12700K': 190,
      'Intel(R) Core(TM) i7-12700KF': 190,
      'Intel(R) Core(TM) i7-12700': 65,
      'Intel(R) Core(TM) i7-12700F': 65,
      'Intel(R) Core(TM) i7-12700T': 35,
      'Intel(R) Core(TM) i5-12600K': 150,
      'Intel(R) Core(TM) i5-12600KF': 150,
      'Intel(R) Core(TM) i5-12600': 65,
      'Intel(R) Core(TM) i5-12500': 65,
      'Intel(R) Core(TM) i5-12400': 65,
      'Intel(R) Core(TM) i5-12400F': 65,
      'Intel(R) Core(TM) i5-12400T': 35,
      'Intel(R) Core(TM) i3-12300': 60,
      'Intel(R) Core(TM) i3-12100': 60,
      'Intel(R) Core(TM) i3-12100F': 58,
      'Intel(R) Core(TM) i3-12100T': 35,
      // ── Intel Core 11th Gen (Rocket Lake) — PL2 sustained all-core ─────────
      'Intel(R) Core(TM) i9-11900K': 250,
      'Intel(R) Core(TM) i9-11900KF': 250,
      'Intel(R) Core(TM) i9-11900': 65,
      'Intel(R) Core(TM) i9-11900F': 65,
      'Intel(R) Core(TM) i9-11900T': 35,
      'Intel(R) Core(TM) i7-11700K': 250,
      'Intel(R) Core(TM) i7-11700KF': 250,
      'Intel(R) Core(TM) i7-11700': 65,
      'Intel(R) Core(TM) i7-11700F': 65,
      'Intel(R) Core(TM) i7-11700T': 35,
      'Intel(R) Core(TM) i5-11600K': 154,
      'Intel(R) Core(TM) i5-11600KF': 154,
      'Intel(R) Core(TM) i5-11600': 65,
      'Intel(R) Core(TM) i5-11500': 65,
      'Intel(R) Core(TM) i5-11500T': 35,
      'Intel(R) Core(TM) i5-11400': 65,
      'Intel(R) Core(TM) i5-11400F': 65,
      'Intel(R) Core(TM) i5-11400T': 35,
      // ── Intel Core 10th Gen (Comet Lake) — PL2 sustained all-core ──────────
      'Intel(R) Core(TM) i9-10900KS': 250,
      'Intel(R) Core(TM) i9-10900K': 250,
      'Intel(R) Core(TM) i9-10900KF': 250,
      'Intel(R) Core(TM) i9-10900': 65,
      'Intel(R) Core(TM) i9-10900F': 65,
      'Intel(R) Core(TM) i9-10900T': 35,
      'Intel(R) Core(TM) i9-10850K': 250,
      'Intel(R) Core(TM) i7-10700K': 229,
      'Intel(R) Core(TM) i7-10700KF': 229,
      'Intel(R) Core(TM) i7-10700': 65,
      'Intel(R) Core(TM) i7-10700F': 65,
      'Intel(R) Core(TM) i7-10700T': 35,
      'Intel(R) Core(TM) i5-10600K': 182,
      'Intel(R) Core(TM) i5-10600KF': 182,
      'Intel(R) Core(TM) i5-10600': 65,
      'Intel(R) Core(TM) i5-10500': 65,
      'Intel(R) Core(TM) i5-10500T': 35,
      'Intel(R) Core(TM) i5-10400': 65,
      'Intel(R) Core(TM) i5-10400F': 65,
      'Intel(R) Core(TM) i5-10400T': 35,
      'Intel(R) Core(TM) i3-10320': 65,
      'Intel(R) Core(TM) i3-10300': 65,
      'Intel(R) Core(TM) i3-10105': 65,
      'Intel(R) Core(TM) i3-10105F': 65,
      'Intel(R) Core(TM) i3-10100': 65,
      'Intel(R) Core(TM) i3-10100F': 65,
      // ── Intel Core 9th Gen (Coffee Lake Refresh) — PL2 sustained all-core ──
      'Intel(R) Core(TM) i9-9900KS': 212,
      'Intel(R) Core(TM) i9-9900K': 212,
      'Intel(R) Core(TM) i9-9900KF': 212,
      'Intel(R) Core(TM) i9-9900': 65,
      'Intel(R) Core(TM) i7-9700K': 180,
      'Intel(R) Core(TM) i7-9700KF': 180,
      'Intel(R) Core(TM) i7-9700': 65,
      'Intel(R) Core(TM) i7-9700F': 65,
      'Intel(R) Core(TM) i5-9600K': 152,
      'Intel(R) Core(TM) i5-9600KF': 152,
      'Intel(R) Core(TM) i5-9600': 65,
      'Intel(R) Core(TM) i5-9500': 65,
      'Intel(R) Core(TM) i5-9500F': 65,
      'Intel(R) Core(TM) i5-9400': 65,
      'Intel(R) Core(TM) i5-9400F': 65,
      'Intel(R) Core(TM) i3-9350K': 91,
      'Intel(R) Core(TM) i3-9300': 62,
      'Intel(R) Core(TM) i3-9100': 65,
      'Intel(R) Core(TM) i3-9100F': 65,
      // ── Intel Core 8th Gen (Coffee Lake) — PL2 sustained all-core ──────────
      'Intel(R) Core(TM) i7-8700K': 180,
      'Intel(R) Core(TM) i7-8700': 65,
      'Intel(R) Core(TM) i5-8600K': 152,
      'Intel(R) Core(TM) i5-8600': 65,
      'Intel(R) Core(TM) i5-8500': 65,
      'Intel(R) Core(TM) i5-8400': 65,
      'Intel(R) Core(TM) i3-8350K': 91,
      'Intel(R) Core(TM) i3-8300': 62,
      'Intel(R) Core(TM) i3-8100': 65,
      // ── Intel Core Ultra 200S (Arrow Lake, desktop) — PL2 sustained ────────
      'Intel(R) Core(TM) Ultra 9 285K': 250,
      'Intel(R) Core(TM) Ultra 7 265K': 225,
      'Intel(R) Core(TM) Ultra 7 265KF': 225,
      'Intel(R) Core(TM) Ultra 5 245K': 159,
      'Intel(R) Core(TM) Ultra 5 245KF': 159,
      // ── Intel Core Ultra 100H/U (Meteor Lake, mobile) ─────────────────────
      'Intel(R) Core(TM) Ultra 9 185H': 45,
      'Intel(R) Core(TM) Ultra 7 165H': 45,
      'Intel(R) Core(TM) Ultra 7 155H': 45,
      'Intel(R) Core(TM) Ultra 5 135H': 45,
      'Intel(R) Core(TM) Ultra 5 125H': 45,
      'Intel(R) Core(TM) Ultra 7 165U': 15,
      'Intel(R) Core(TM) Ultra 7 155U': 15,
      'Intel(R) Core(TM) Ultra 5 135U': 15,
      // ── Intel 13th Gen Mobile (HX / H / U) ────────────────────────────────
      'Intel(R) Core(TM) i9-13950HX': 55,
      'Intel(R) Core(TM) i9-13900HX': 55,
      'Intel(R) Core(TM) i9-13900H': 45,
      'Intel(R) Core(TM) i7-13700HX': 55,
      'Intel(R) Core(TM) i7-13700H': 45,
      'Intel(R) Core(TM) i5-13600H': 45,
      'Intel(R) Core(TM) i5-13500H': 45,
      'Intel(R) Core(TM) i5-13450H': 45,
      'Intel(R) Core(TM) i7-1365U': 15,
      'Intel(R) Core(TM) i7-1355U': 15,
      'Intel(R) Core(TM) i5-1345U': 15,
      'Intel(R) Core(TM) i5-1335U': 15,
      'Intel(R) Core(TM) i3-1315U': 15,
      // ── Intel 12th Gen Mobile ─────────────────────────────────────────────
      'Intel(R) Core(TM) i9-12950HX': 55,
      'Intel(R) Core(TM) i9-12900HK': 45,
      'Intel(R) Core(TM) i9-12900H': 45,
      'Intel(R) Core(TM) i7-12700H': 45,
      'Intel(R) Core(TM) i7-12650H': 45,
      'Intel(R) Core(TM) i5-12500H': 45,
      'Intel(R) Core(TM) i5-12450H': 45,
      'Intel(R) Core(TM) i7-1280P': 28,
      'Intel(R) Core(TM) i7-1270P': 28,
      'Intel(R) Core(TM) i5-1240P': 28,
      'Intel(R) Core(TM) i7-1255U': 15,
      'Intel(R) Core(TM) i5-1235U': 15,
      // ── Intel 11th Gen Mobile ─────────────────────────────────────────────
      'Intel(R) Core(TM) i9-11980HK': 45,
      'Intel(R) Core(TM) i9-11900H': 45,
      'Intel(R) Core(TM) i7-11800H': 45,
      'Intel(R) Core(TM) i5-11500H': 45,
      'Intel(R) Core(TM) i7-1185G7': 28,
      'Intel(R) Core(TM) i7-1165G7': 28,
      'Intel(R) Core(TM) i5-1135G7': 28,
      'Intel(R) Core(TM) i3-1125G4': 28,
      'Intel(R) Core(TM) i3-1115G4': 15,
      // ── Intel 10th Gen Mobile ─────────────────────────────────────────────
      'Intel(R) Core(TM) i7-10875H': 45,
      'Intel(R) Core(TM) i7-10750H': 45,
      'Intel(R) Core(TM) i5-10500H': 45,
      'Intel(R) Core(TM) i5-10300H': 45,
      'Intel(R) Core(TM) i7-1065G7': 15,
      'Intel(R) Core(TM) i5-1035G1': 15,
      'Intel(R) Core(TM) i3-1005G1': 15,
      // ── Intel Xeon ────────────────────────────────────────────────────────
      'Intel(R) Xeon(R) w9-3595X': 350,
      'Intel(R) Xeon(R) w9-3575X': 300,
      'Intel(R) Xeon(R) w7-3465X': 300,
      'Intel(R) Xeon(R) w7-2495X': 225,
      'Intel(R) Xeon(R) W-3175X': 255,
      'Intel(R) Xeon(R) W-2295': 165,
      'Intel(R) Xeon(R) W-2255': 165,
      'Intel(R) Xeon(R) W-2245': 155,
      'Intel(R) Xeon(R) Gold 6258R': 205,
      'Intel(R) Xeon(R) Gold 6248R': 205,
      'Intel(R) Xeon(R) Gold 6154': 200,
      'Intel(R) Xeon(R) Silver 4310': 120,
      'Intel(R) Xeon(R) Silver 4210R': 100,
      'Intel(R) Xeon(R) Silver 4210': 85,
      'Intel(R) Xeon(R) E5-2699 v4': 145,
      'Intel(R) Xeon(R) E5-2690 v4': 135,
      'Intel(R) Xeon(R) E5-2680 v4': 120,
      'Intel(R) Xeon(R) E5-2670 v3': 120,
      // ── AMD Ryzen 9000 Series (Zen 5, AM5) — PPT (actual all-core power) ──
      'AMD Ryzen 9 9950X': 230,
      'AMD Ryzen 9 9900X': 162,
      'AMD Ryzen 7 9800X3D': 162,
      'AMD Ryzen 7 9700X': 88,
      'AMD Ryzen 5 9600X': 88,
      'AMD Ryzen 5 9600': 65,
      // ── AMD Ryzen 7000 Series (Zen 4, AM5) — PPT (actual all-core power) ──
      'AMD Ryzen 9 7950X': 230,
      'AMD Ryzen 9 7950X3D': 162,
      'AMD Ryzen 9 7900X': 230,
      'AMD Ryzen 9 7900X3D': 162,
      'AMD Ryzen 9 7900': 88,
      'AMD Ryzen 7 7800X3D': 162,
      'AMD Ryzen 7 7700X': 142,
      'AMD Ryzen 7 7700': 88,
      'AMD Ryzen 5 7600X': 142,
      'AMD Ryzen 5 7600': 88,
      'AMD Ryzen 5 7500F': 88,
      // ── AMD Ryzen 5000 Series (Zen 3, AM4) ────────────────────────────────
      'AMD Ryzen 9 5950X': 142,
      'AMD Ryzen 9 5900X': 142,
      'AMD Ryzen 9 5900': 88,
      'AMD Ryzen 9 5900HX': 45,
      'AMD Ryzen 7 5800X3D': 88,
      'AMD Ryzen 7 5800X': 142,
      'AMD Ryzen 7 5800': 88,
      'AMD Ryzen 7 5800H': 45,
      'AMD Ryzen 7 5700X': 88,
      'AMD Ryzen 7 5700G': 88,
      'AMD Ryzen 5 5600X': 88,
      'AMD Ryzen 5 5600': 88,
      'AMD Ryzen 5 5600G': 88,
      'AMD Ryzen 5 5600H': 45,
      'AMD Ryzen 5 5500': 88,
      'AMD Ryzen 3 5300G': 88,
      'AMD Ryzen 3 5100': 88,
      // ── AMD Ryzen 3000 Series (Zen 2, AM4) ────────────────────────────────
      'AMD Ryzen 9 3950X': 142,
      'AMD Ryzen 9 3900XT': 142,
      'AMD Ryzen 9 3900X': 142,
      'AMD Ryzen 9 3900': 88,
      'AMD Ryzen 7 3800XT': 142,
      'AMD Ryzen 7 3800X': 142,
      'AMD Ryzen 7 3700X': 88,
      'AMD Ryzen 5 3600XT': 128,
      'AMD Ryzen 5 3600X': 128,
      'AMD Ryzen 5 3600': 88,
      'AMD Ryzen 5 3500X': 88,
      'AMD Ryzen 5 3500': 88,
      'AMD Ryzen 3 3300X': 88,
      'AMD Ryzen 3 3100': 88,
      // ── AMD Ryzen 2000 Series (Zen+, AM4) ─────────────────────────────────
      'AMD Ryzen 7 2700X': 128,
      'AMD Ryzen 7 2700': 88,
      'AMD Ryzen 5 2600X': 110,
      'AMD Ryzen 5 2600': 88,
      'AMD Ryzen 3 2300X': 88,
      'AMD Ryzen 3 2200G': 88,
      // ── AMD Threadripper ──────────────────────────────────────────────────
      'AMD Ryzen Threadripper PRO 7995WX': 350,
      'AMD Ryzen Threadripper PRO 7985WX': 350,
      'AMD Ryzen Threadripper PRO 7975WX': 350,
      'AMD Ryzen Threadripper PRO 5995WX': 280,
      'AMD Ryzen Threadripper PRO 5975WX': 280,
      'AMD Ryzen Threadripper PRO 5965WX': 280,
      'AMD Ryzen Threadripper 3990X': 280,
      'AMD Ryzen Threadripper 3970X': 280,
      'AMD Ryzen Threadripper 3960X': 280,
      'AMD Ryzen Threadripper 2990WX': 250,
      'AMD Ryzen Threadripper 2970WX': 250,
      'AMD Ryzen Threadripper 2950X': 180,
      'AMD Ryzen Threadripper 2920X': 180,
      // ── AMD EPYC ──────────────────────────────────────────────────────────
      'AMD EPYC 9654': 360,
      'AMD EPYC 9554': 360,
      'AMD EPYC 9454': 290,
      'AMD EPYC 9354': 280,
      'AMD EPYC 7763': 280,
      'AMD EPYC 7742': 225,
      'AMD EPYC 7713': 225,
      'AMD EPYC 7663': 240,
      'AMD EPYC 7601': 180,
      'AMD EPYC 7551': 180,
      'AMD EPYC 7543': 225,
      'AMD EPYC 7502': 180,
      'AMD EPYC 7401': 170,
      'AMD EPYC 7301': 155,
      // ── Apple Silicon ─────────────────────────────────────────────────────
      'Apple M1': 20,
      'Apple M1 Pro': 30,
      'Apple M1 Max': 60,
      'Apple M1 Ultra': 100,
      'Apple M2': 22,
      'Apple M2 Pro': 35,
      'Apple M2 Max': 60,
      'Apple M2 Ultra': 100,
      'Apple M3': 22,
      'Apple M3 Pro': 35,
      'Apple M3 Max': 92,
      'Apple M4': 20,
      'Apple M4 Pro': 31,
      'Apple M4 Max': 50,
      // ── Intel Core 7th Gen (Kaby Lake) ────────────────────────────────────
      'Intel(R) Core(TM) i7-7700K': 91,
      'Intel(R) Core(TM) i7-7700': 65,
      'Intel(R) Core(TM) i7-7700T': 35,
      'Intel(R) Core(TM) i5-7600K': 91,
      'Intel(R) Core(TM) i5-7600': 65,
      'Intel(R) Core(TM) i5-7500': 65,
      'Intel(R) Core(TM) i5-7400': 65,
      'Intel(R) Core(TM) i5-7400T': 35,
      'Intel(R) Core(TM) i3-7350K': 60,
      'Intel(R) Core(TM) i3-7300': 51,
      'Intel(R) Core(TM) i3-7100': 51,
      'Intel(R) Core(TM) i3-7100T': 35,
      'Intel(R) Core(TM) i7-7700HQ': 45,
      'Intel(R) Core(TM) i7-7500U': 15,
      'Intel(R) Core(TM) i5-7300HQ': 45,
      'Intel(R) Core(TM) i5-7200U': 15,
      'Intel(R) Core(TM) i3-7100U': 15,
      // ── Intel Core 6th Gen (Skylake) ───────────────────────────────────────
      'Intel(R) Core(TM) i7-6700K': 91,
      'Intel(R) Core(TM) i7-6700': 65,
      'Intel(R) Core(TM) i7-6700T': 35,
      'Intel(R) Core(TM) i5-6600K': 91,
      'Intel(R) Core(TM) i5-6600': 65,
      'Intel(R) Core(TM) i5-6500': 65,
      'Intel(R) Core(TM) i5-6400': 65,
      'Intel(R) Core(TM) i5-6400T': 35,
      'Intel(R) Core(TM) i3-6300': 51,
      'Intel(R) Core(TM) i3-6100': 51,
      'Intel(R) Core(TM) i3-6100T': 35,
      'Intel(R) Core(TM) i7-6700HQ': 45,
      'Intel(R) Core(TM) i7-6500U': 15,
      'Intel(R) Core(TM) i5-6300HQ': 45,
      'Intel(R) Core(TM) i5-6200U': 15,
      'Intel(R) Core(TM) i3-6100U': 15,
      // ── Intel Core 5th Gen (Broadwell) ────────────────────────────────────
      'Intel(R) Core(TM) i7-5775C': 65,
      'Intel(R) Core(TM) i5-5675C': 65,
      'Intel(R) Core(TM) i7-5700HQ': 47,
      'Intel(R) Core(TM) i7-5500U': 15,
      'Intel(R) Core(TM) i5-5300U': 15,
      'Intel(R) Core(TM) i3-5005U': 15,
      // ── Intel Core 4th Gen (Haswell) ──────────────────────────────────────
      'Intel(R) Core(TM) i7-4790K': 88,
      'Intel(R) Core(TM) i7-4790': 84,
      'Intel(R) Core(TM) i7-4770K': 84,
      'Intel(R) Core(TM) i7-4770': 84,
      'Intel(R) Core(TM) i7-4770T': 45,
      'Intel(R) Core(TM) i5-4690K': 88,
      'Intel(R) Core(TM) i5-4690': 84,
      'Intel(R) Core(TM) i5-4670K': 84,
      'Intel(R) Core(TM) i5-4670': 84,
      'Intel(R) Core(TM) i5-4590': 84,
      'Intel(R) Core(TM) i5-4570': 84,
      'Intel(R) Core(TM) i5-4460': 84,
      'Intel(R) Core(TM) i3-4370': 54,
      'Intel(R) Core(TM) i3-4160': 54,
      'Intel(R) Core(TM) i3-4130': 54,
      'Intel(R) Core(TM) i7-4720HQ': 47,
      'Intel(R) Core(TM) i7-4700MQ': 47,
      'Intel(R) Core(TM) i7-4500U': 15,
      'Intel(R) Core(TM) i5-4300U': 15,
      'Intel(R) Core(TM) i3-4010U': 15,
      // ── Intel Core 3rd Gen (Ivy Bridge) ───────────────────────────────────
      'Intel(R) Core(TM) i7-3770K': 77,
      'Intel(R) Core(TM) i7-3770': 77,
      'Intel(R) Core(TM) i7-3770T': 45,
      'Intel(R) Core(TM) i5-3570K': 77,
      'Intel(R) Core(TM) i5-3570': 77,
      'Intel(R) Core(TM) i5-3570T': 45,
      'Intel(R) Core(TM) i5-3470': 77,
      'Intel(R) Core(TM) i5-3450': 77,
      'Intel(R) Core(TM) i3-3240': 55,
      'Intel(R) Core(TM) i3-3225': 55,
      'Intel(R) Core(TM) i3-3220': 55,
      'Intel(R) Core(TM) i7-3720QM': 45,
      'Intel(R) Core(TM) i7-3630QM': 45,
      'Intel(R) Core(TM) i5-3320M': 35,
      'Intel(R) Core(TM) i5-3210M': 35,
      'Intel(R) Core(TM) i3-3110M': 35,
      // ── Intel Core 2nd Gen (Sandy Bridge) ─────────────────────────────────
      'Intel(R) Core(TM) i7-2700K': 95,
      'Intel(R) Core(TM) i7-2600K': 95,
      'Intel(R) Core(TM) i7-2600': 95,
      'Intel(R) Core(TM) i7-2600S': 65,
      'Intel(R) Core(TM) i5-2500K': 95,
      'Intel(R) Core(TM) i5-2500': 95,
      'Intel(R) Core(TM) i5-2400': 95,
      'Intel(R) Core(TM) i5-2310': 95,
      'Intel(R) Core(TM) i3-2120': 65,
      'Intel(R) Core(TM) i3-2100': 65,
      'Intel(R) Core(TM) i7-2630QM': 45,
      'Intel(R) Core(TM) i5-2520M': 35,
      'Intel(R) Core(TM) i5-2410M': 35,
      'Intel(R) Core(TM) i3-2310M': 35,
      // ── Intel Xeon E3 (v1-v4) ─────────────────────────────────────────────
      'Intel(R) Xeon(R) E3-1280 v5': 80,
      'Intel(R) Xeon(R) E3-1270 v5': 80,
      'Intel(R) Xeon(R) E3-1240 v5': 80,
      'Intel(R) Xeon(R) E3-1230 v5': 80,
      'Intel(R) Xeon(R) E3-1280 v3': 84,
      'Intel(R) Xeon(R) E3-1270 v3': 80,
      'Intel(R) Xeon(R) E3-1240 v3': 80,
      'Intel(R) Xeon(R) E3-1230 v3': 80,
      'Intel(R) Xeon(R) E3-1220 v3': 80,
      'Intel(R) Xeon(R) E3-1275 v2': 77,
      'Intel(R) Xeon(R) E3-1245 v2': 77,
      'Intel(R) Xeon(R) E3-1225 v2': 77,
      // ── Intel Pentium / Celeron (Desktop) ─────────────────────────────────
      'Intel(R) Pentium(R) Gold G7400': 46,
      'Intel(R) Pentium(R) Gold G6605': 58,
      'Intel(R) Pentium(R) Gold G6400': 58,
      'Intel(R) Pentium(R) Gold G5620': 54,
      'Intel(R) Pentium(R) Gold G5600': 54,
      'Intel(R) Pentium(R) Gold G5400': 54,
      'Intel(R) Pentium(R) G4560': 54,
      'Intel(R) Pentium(R) G4400': 54,
      'Intel(R) Pentium(R) G3258': 53,
      'Intel(R) Pentium(R) G3220': 53,
      'Intel(R) Celeron(R) G6900': 46,
      'Intel(R) Celeron(R) G5905': 58,
      'Intel(R) Celeron(R) G4900': 54,
      'Intel(R) Celeron(R) G3900': 51,
      // ── AMD Ryzen 1000 Series (Zen 1, AM4) ────────────────────────────────
      'AMD Ryzen 7 1800X': 95,
      'AMD Ryzen 7 1700X': 95,
      'AMD Ryzen 7 1700': 65,
      'AMD Ryzen 5 1600X': 95,
      'AMD Ryzen 5 1600': 65,
      'AMD Ryzen 5 1500X': 65,
      'AMD Ryzen 5 1400': 65,
      'AMD Ryzen 3 1300X': 65,
      'AMD Ryzen 3 1200': 65,
      // ── AMD FX Series (Vishera / Piledriver, AM3+) ────────────────────────
      'AMD FX-9590': 220,
      'AMD FX-9370': 220,
      'AMD FX-8370': 125,
      'AMD FX-8350': 125,
      'AMD FX-8320E': 95,
      'AMD FX-8320': 125,
      'AMD FX-8300': 95,
      'AMD FX-6350': 125,
      'AMD FX-6300': 95,
      'AMD FX-4350': 125,
      'AMD FX-4300': 95,
      // ── AMD A-Series APU (FM2+) ───────────────────────────────────────────
      'AMD A10-7890K': 95,
      'AMD A10-7870K': 95,
      'AMD A10-7850K': 95,
      'AMD A10-7800': 65,
      'AMD A8-7670K': 95,
      'AMD A8-7650K': 65,
      'AMD A6-7470K': 65,
      'AMD A6-7400K': 65,
      // ── AMD Phenom II (AM3) ───────────────────────────────────────────────
      'AMD Phenom(tm) II X6 1100T': 125,
      'AMD Phenom(tm) II X6 1090T': 125,
      'AMD Phenom(tm) II X4 980': 125,
      'AMD Phenom(tm) II X4 970': 125,
      'AMD Phenom(tm) II X4 965': 125,
      'AMD Phenom(tm) II X4 955': 125,
      'AMD Phenom(tm) II X4 945': 95,
      // ── Intel Core 7th Gen Mobile (Kaby Lake-H, additional) ─────────────────
      'Intel(R) Core(TM) i7-7920HQ': 45,
      'Intel(R) Core(TM) i7-7820HK': 45,
      'Intel(R) Core(TM) i7-7820HQ': 45,
      'Intel(R) Core(TM) i5-7440HQ': 45,
      'Intel(R) Core(TM) i3-7100H': 35,
      // ── Intel Core 6th Gen Mobile (Skylake-H, additional) ───────────────────
      'Intel(R) Core(TM) i7-6970HQ': 45,
      'Intel(R) Core(TM) i7-6920HQ': 45,
      'Intel(R) Core(TM) i7-6870HQ': 45,
      'Intel(R) Core(TM) i7-6820HQ': 45,
      'Intel(R) Core(TM) i7-6820HK': 45,
      'Intel(R) Core(TM) i7-6770HQ': 45,
      'Intel(R) Core(TM) i5-6440HQ': 45,
      'Intel(R) Core(TM) i5-6350HQ': 45,
      'Intel(R) Core(TM) i3-6100H': 35,
      // ── Intel Core 5th Gen Mobile (Broadwell-H, additional) ─────────────────
      'Intel(R) Core(TM) i7-5950HQ': 47,
      'Intel(R) Core(TM) i7-5850HQ': 47,
      'Intel(R) Core(TM) i7-5750HQ': 47,
      'Intel(R) Core(TM) i5-5350H': 47,
      // ── Intel Core 4th Gen Mobile (Haswell MQ/HQ, additional) ───────────────
      'Intel(R) Core(TM) i7-4980HQ': 47,
      'Intel(R) Core(TM) i7-4960HQ': 47,
      'Intel(R) Core(TM) i7-4940MX': 57,
      'Intel(R) Core(TM) i7-4930MX': 57,
      'Intel(R) Core(TM) i7-4910MQ': 47,
      'Intel(R) Core(TM) i7-4900MQ': 47,
      'Intel(R) Core(TM) i7-4870HQ': 47,
      'Intel(R) Core(TM) i7-4860HQ': 47,
      'Intel(R) Core(TM) i7-4850HQ': 47,
      'Intel(R) Core(TM) i7-4810MQ': 47,
      'Intel(R) Core(TM) i7-4800MQ': 47,
      'Intel(R) Core(TM) i7-4770HQ': 47,
      'Intel(R) Core(TM) i7-4760HQ': 47,
      'Intel(R) Core(TM) i7-4750HQ': 47,
      'Intel(R) Core(TM) i7-4710HQ': 47,
      'Intel(R) Core(TM) i7-4712MQ': 37,
      'Intel(R) Core(TM) i7-4702MQ': 37,
      'Intel(R) Core(TM) i7-4702HQ': 37,
      'Intel(R) Core(TM) i5-4340M': 37,
      'Intel(R) Core(TM) i5-4330M': 37,
      'Intel(R) Core(TM) i5-4310M': 37,
      'Intel(R) Core(TM) i5-4300M': 37,
      'Intel(R) Core(TM) i5-4210M': 37,
      'Intel(R) Core(TM) i5-4200M': 37,
      'Intel(R) Core(TM) i5-4200H': 47,
      'Intel(R) Core(TM) i3-4110M': 37,
      'Intel(R) Core(TM) i3-4100M': 37,
      'Intel(R) Core(TM) i3-4000M': 37,
      // ── Intel Core 3rd Gen Mobile (Ivy Bridge M/QM/XM, additional) ──────────
      'Intel(R) Core(TM) i7-3940XM': 55,
      'Intel(R) Core(TM) i7-3920XM': 55,
      'Intel(R) Core(TM) i7-3840QM': 45,
      'Intel(R) Core(TM) i7-3820QM': 45,
      'Intel(R) Core(TM) i7-3740QM': 45,
      'Intel(R) Core(TM) i7-3610QM': 45,
      'Intel(R) Core(TM) i7-3632QM': 35,
      'Intel(R) Core(TM) i7-3612QM': 35,
      'Intel(R) Core(TM) i7-3540M': 35,
      'Intel(R) Core(TM) i7-3520M': 35,
      'Intel(R) Core(TM) i5-3380M': 35,
      'Intel(R) Core(TM) i5-3360M': 35,
      'Intel(R) Core(TM) i5-3340M': 35,
      'Intel(R) Core(TM) i5-3230M': 35,
      'Intel(R) Core(TM) i3-3130M': 35,
      'Intel(R) Core(TM) i3-3120M': 35,
      // ── Intel Core 8th Gen Mobile (Kaby Lake-R / Coffee Lake-H) ─────────────
      'Intel(R) Core(TM) i9-8950HK': 45,
      'Intel(R) Core(TM) i7-8850H': 45,
      'Intel(R) Core(TM) i7-8750H': 45,
      'Intel(R) Core(TM) i5-8400H': 45,
      'Intel(R) Core(TM) i5-8300H': 45,
      'Intel(R) Core(TM) i3-8100H': 45,
      'Intel(R) Core(TM) i7-8650U': 15,
      'Intel(R) Core(TM) i7-8550U': 15,
      'Intel(R) Core(TM) i5-8350U': 15,
      'Intel(R) Core(TM) i5-8250U': 15,
      'Intel(R) Core(TM) i3-8130U': 15,
      // ── Intel Core 9th Gen Mobile (Coffee Lake-H Refresh) ───────────────────
      'Intel(R) Core(TM) i9-9980HK': 45,
      'Intel(R) Core(TM) i9-9880H': 45,
      'Intel(R) Core(TM) i7-9850H': 45,
      'Intel(R) Core(TM) i7-9750H': 45,
      'Intel(R) Core(TM) i5-9400H': 45,
      'Intel(R) Core(TM) i5-9300H': 45,
      'Intel(R) Core(TM) i5-9300HF': 45,
      // ── Intel Core 11th Gen H35 (Tiger Lake H35, 35W) ───────────────────────
      'Intel(R) Core(TM) i7-11390H': 35,
      'Intel(R) Core(TM) i7-11370H': 35,
      'Intel(R) Core(TM) i5-11300H': 35,
      // ── Intel Core 14th Gen Mobile (Raptor Lake HX/H/U Refresh) ─────────────
      'Intel(R) Core(TM) i9-14900HX': 55,
      'Intel(R) Core(TM) i7-14700HX': 55,
      'Intel(R) Core(TM) i7-14650HX': 55,
      'Intel(R) Core(TM) i5-14500HX': 55,
      'Intel(R) Core(TM) i5-14450HX': 55,
      'Intel(R) Core(TM) i9-14900H': 45,
      'Intel(R) Core(TM) i7-14700H': 45,
      'Intel(R) Core(TM) i5-14500H': 45,
      'Intel(R) Core(TM) i5-14400H': 45,
      'Intel(R) Core(TM) i7-1465U': 15,
      'Intel(R) Core(TM) i5-1455U': 15,
      'Intel(R) Core(TM) i3-1415U': 15,
      // ── Intel Core m / Y-series (Broadwell–Amber Lake) ──────────────────────
      'Intel(R) Core(TM) m3-7Y30': 4.5,
      'Intel(R) Core(TM) m3-7Y32': 4.5,
      'Intel(R) Core(TM) m3-6Y30': 4.5,
      'Intel(R) Core(TM) m5-6Y57': 4.5,
      'Intel(R) Core(TM) m7-6Y75': 4.5,
      'Intel(R) Core(TM) i7-7Y75': 4.5,
      'Intel(R) Core(TM) i5-7Y54': 4.5,
      'Intel(R) Core(TM) i7-8500Y': 5,
      'Intel(R) Core(TM) i5-8200Y': 5,
      'Intel(R) Core(TM) i7-10510Y': 7,
      'Intel(R) Core(TM) i5-10310Y': 7,
      // ── Intel N-series (Alder Lake-N / Jasper Lake / Tremont) ───────────────
      'Intel(R) N305': 15,
      'Intel(R) N300': 7,
      'Intel(R) N200': 6,
      'Intel(R) N100': 6,
      'Intel(R) N97': 12,
      'Intel(R) N95': 15,
      'Intel(R) N50': 6,
      'Intel(R) Pentium(R) Silver N6005': 10,
      'Intel(R) Pentium(R) Silver N6000': 6,
      'Intel(R) Pentium(R) Silver N5030': 6,
      'Intel(R) Pentium(R) Silver N5000': 6,
      'Intel(R) Celeron(R) N5105': 10,
      'Intel(R) Celeron(R) N5100': 6,
      'Intel(R) Celeron(R) N5095': 15,
      'Intel(R) Celeron(R) N4505': 10,
      'Intel(R) Celeron(R) N4500': 6,
      'Intel(R) Celeron(R) N4120': 6,
      'Intel(R) Celeron(R) N4100': 6,
      'Intel(R) Celeron(R) N4020': 6,
      'Intel(R) Celeron(R) N4000': 6,
      'Intel(R) Celeron(R) N3450': 6,
      'Intel(R) Celeron(R) N3350': 6,
      'Intel(R) Celeron(R) N3160': 6,
      'Intel(R) Celeron(R) N3150': 6,
      'Intel(R) Celeron(R) N3060': 6,
      'Intel(R) Celeron(R) N3050': 6,
      'Intel(R) Celeron(R) N2940': 7.5,
      'Intel(R) Celeron(R) N2930': 7.5,
      'Intel(R) Celeron(R) N2920': 7.5,
      'Intel(R) Celeron(R) N2910': 7.5,
      'Intel(R) Celeron(R) J4125': 10,
      'Intel(R) Celeron(R) J4105': 10,
      'Intel(R) Celeron(R) J4005': 10,
      'Intel(R) Celeron(R) J3455': 10,
      'Intel(R) Celeron(R) J3355': 10,
      'Intel(R) Celeron(R) J3160': 6,
      'Intel(R) Celeron(R) J3060': 6,
      // ── Intel Pentium / Celeron Mobile (older) ──────────────────────────────
      'Intel(R) Pentium(R) 4415U': 15,
      'Intel(R) Pentium(R) 4410Y': 6,
      'Intel(R) Pentium(R) 4405U': 15,
      'Intel(R) Celeron(R) 3865U': 15,
      'Intel(R) Celeron(R) 3855U': 15,
      'Intel(R) Celeron(R) 3205U': 15,
      // ── AMD Ryzen 4000 Mobile (Renoir, Zen 2) ───────────────────────────────
      'AMD Ryzen 9 4900H': 45,
      'AMD Ryzen 9 4900HS': 35,
      'AMD Ryzen 7 4800H': 45,
      'AMD Ryzen 7 4800HS': 35,
      'AMD Ryzen 5 4600H': 45,
      'AMD Ryzen 7 4800U': 15,
      'AMD Ryzen 5 4600U': 15,
      'AMD Ryzen 5 4500U': 15,
      'AMD Ryzen 3 4300U': 15,
      'AMD Ryzen 3 4200U': 15,
      // ── AMD Ryzen 5000 Mobile (Cezanne, Zen 3) ──────────────────────────────
      'AMD Ryzen 9 5980HX': 45,
      'AMD Ryzen 9 5980HS': 35,
      'AMD Ryzen 9 5900HS': 35,
      'AMD Ryzen 7 5800HS': 35,
      'AMD Ryzen 7 5700U': 15,
      'AMD Ryzen 5 5600U': 15,
      'AMD Ryzen 5 5500U': 15,
      'AMD Ryzen 3 5400U': 15,
      // ── AMD Ryzen 6000 Mobile (Rembrandt, Zen 3+) ───────────────────────────
      'AMD Ryzen 9 6980HX': 45,
      'AMD Ryzen 9 6900HX': 45,
      'AMD Ryzen 9 6900HS': 35,
      'AMD Ryzen 7 6800H': 45,
      'AMD Ryzen 7 6800HS': 35,
      'AMD Ryzen 5 6600H': 45,
      'AMD Ryzen 5 6600HS': 35,
      'AMD Ryzen 7 6800U': 15,
      'AMD Ryzen 5 6600U': 15,
      // ── AMD Ryzen 7000 Mobile (Dragon Range HX / Phoenix HS) ────────────────
      'AMD Ryzen 9 7945HX3D': 55,
      'AMD Ryzen 9 7945HX': 55,
      'AMD Ryzen 9 7845HX': 55,
      'AMD Ryzen 7 7745HX': 55,
      'AMD Ryzen 5 7645HX': 55,
      'AMD Ryzen 9 7940HS': 45,
      'AMD Ryzen 7 7840HS': 45,
      'AMD Ryzen 5 7640HS': 45,
      'AMD Ryzen 7 7840U': 15,
      'AMD Ryzen 5 7640U': 15,
      'AMD Ryzen 5 7540U': 15,
      'AMD Ryzen 3 7440U': 15,
      // ── AMD Ryzen 8000 Mobile (Hawk Point, Zen 4) ───────────────────────────
      'AMD Ryzen 9 8945HS': 45,
      'AMD Ryzen 7 8845HS': 45,
      'AMD Ryzen 7 8745HS': 45,
      'AMD Ryzen 5 8645HS': 45,
      'AMD Ryzen 5 8640HS': 45,
      'AMD Ryzen 7 8840U': 15,
      'AMD Ryzen 5 8640U': 15,
      'AMD Ryzen 5 8540U': 15,
      'AMD Ryzen 3 8440U': 15,
      // ── AMD Ryzen 9000 Mobile (Strix Point, Zen 5) ──────────────────────────
      'AMD Ryzen AI 9 HX 370': 28,
      'AMD Ryzen AI 9 365': 28,
      'AMD Ryzen AI 7 PRO 360': 28,
      // ── AMD Ryzen 3000 Mobile (Picasso, Zen+) ───────────────────────────────
      'AMD Ryzen 7 3750H': 35,
      'AMD Ryzen 5 3550H': 35,
      'AMD Ryzen 7 3700U': 15,
      'AMD Ryzen 5 3500U': 15,
      'AMD Ryzen 3 3300U': 15,
      'AMD Ryzen 3 3200U': 15,
      // ── AMD Ryzen 2000 Mobile (Raven Ridge, Zen 1) ──────────────────────────
      'AMD Ryzen 7 2700U': 15,
      'AMD Ryzen 5 2500U': 15,
      'AMD Ryzen 3 2300U': 15,
      'AMD Ryzen 3 2200U': 15,
      // ── AMD A-series Mobile / PRO ───────────────────────────────────────────
      'AMD A12-9720P': 15,
      'AMD A12-9700P': 15,
      'AMD A10-9620P': 15,
      'AMD A10-9600P': 15,
      'AMD A8-8600P': 15,
      'AMD A6-8500P': 15,
      'AMD A10-8700P': 12,
      'AMD A8-7410': 15,
      'AMD A6-7310': 15,
      'AMD A4-7210': 15,
      'AMD A8-6410': 15,
      'AMD A6-6310': 15,
      'AMD A4-6210': 15,
      'AMD E2-7110': 12,
      'AMD E2-6110': 15,
      // ── AMD E / C-series (Bobcat / Jaguar) ──────────────────────────────────
      'AMD E-350': 18,
      'AMD E-450': 18,
      'AMD E-240': 18,
      'AMD E-300': 15,
      'AMD E-350D': 18,
      'AMD E-450D': 18,
      'AMD C-60': 9,
      'AMD C-50': 9,
      'AMD C-30': 9,
      'AMD C-70': 9,
      'AMD Z-60': 5,
      'AMD Z-01': 6,
    }),
    [],
  );
  const gpuTDPTable = React.useMemo(
    () => ({
      // ── NVIDIA GeForce RTX 50 Series ──────────────────────────────────────
      'NVIDIA GeForce RTX 5090': 575,
      'NVIDIA GeForce RTX 5080': 360,
      'NVIDIA GeForce RTX 5070 Ti': 300,
      'NVIDIA GeForce RTX 5070': 250,
      'NVIDIA GeForce RTX 5060 Ti': 180,
      'NVIDIA GeForce RTX 5060': 150,
      // ── NVIDIA GeForce RTX 40 Series ──────────────────────────────────────
      'NVIDIA GeForce RTX 4090': 450,
      'NVIDIA GeForce RTX 4080 SUPER': 320,
      'NVIDIA GeForce RTX 4080': 320,
      'NVIDIA GeForce RTX 4070 Ti SUPER': 285,
      'NVIDIA GeForce RTX 4070 Ti': 285,
      'NVIDIA GeForce RTX 4070 SUPER': 220,
      'NVIDIA GeForce RTX 4070': 200,
      'NVIDIA GeForce RTX 4060 Ti': 160,
      'NVIDIA GeForce RTX 4060': 115,
      'NVIDIA GeForce RTX 4050': 115,
      // ── NVIDIA GeForce RTX 30 Series ──────────────────────────────────────
      'NVIDIA GeForce RTX 3090 Ti': 450,
      'NVIDIA GeForce RTX 3090': 350,
      'NVIDIA GeForce RTX 3080 Ti': 350,
      'NVIDIA GeForce RTX 3080 12GB': 350,
      'NVIDIA GeForce RTX 3080 10GB': 320,
      'NVIDIA GeForce RTX 3080': 320,
      'NVIDIA GeForce RTX 3070 Ti': 290,
      'NVIDIA GeForce RTX 3070': 220,
      'NVIDIA GeForce RTX 3060 Ti': 200,
      'NVIDIA GeForce RTX 3060 12GB': 170,
      'NVIDIA GeForce RTX 3060': 170,
      'NVIDIA GeForce RTX 3050 OEM': 90,
      'NVIDIA GeForce RTX 3050': 130,
      // ── NVIDIA GeForce RTX 20 Series ──────────────────────────────────────
      'NVIDIA GeForce RTX 2080 Ti': 250,
      'NVIDIA GeForce RTX 2080 SUPER': 250,
      'NVIDIA GeForce RTX 2080': 215,
      'NVIDIA GeForce RTX 2070 SUPER': 215,
      'NVIDIA GeForce RTX 2070': 175,
      'NVIDIA GeForce RTX 2060 SUPER': 175,
      'NVIDIA GeForce RTX 2060': 160,
      // ── NVIDIA GeForce GTX 16 Series ──────────────────────────────────────
      'NVIDIA GeForce GTX 1660 Ti': 120,
      'NVIDIA GeForce GTX 1660 SUPER': 125,
      'NVIDIA GeForce GTX 1660': 120,
      'NVIDIA GeForce GTX 1650 SUPER': 100,
      'NVIDIA GeForce GTX 1650': 75,
      // ── NVIDIA GeForce GTX 10 Series ──────────────────────────────────────
      'NVIDIA GeForce GTX 1080 Ti': 250,
      'NVIDIA GeForce GTX 1080': 180,
      'NVIDIA GeForce GTX 1070 Ti': 180,
      'NVIDIA GeForce GTX 1070': 150,
      'NVIDIA GeForce GTX 1060 6GB': 120,
      'NVIDIA GeForce GTX 1060 3GB': 120,
      'NVIDIA GeForce GTX 1060': 120,
      'NVIDIA GeForce GTX 1050 Ti': 75,
      'NVIDIA GeForce GTX 1050': 75,
      'NVIDIA GeForce GTX 1030': 30,
      // ── NVIDIA GeForce GTX 9 Series ───────────────────────────────────────
      'NVIDIA GeForce GTX 980 Ti': 250,
      'NVIDIA GeForce GTX 980': 165,
      'NVIDIA GeForce GTX 970': 145,
      'NVIDIA GeForce GTX 960': 120,
      'NVIDIA GeForce GTX 950': 90,
      // ── NVIDIA RTX Workstation / Professional ─────────────────────────────
      'NVIDIA RTX 6000 Ada': 300,
      'NVIDIA RTX 5000 Ada': 250,
      'NVIDIA RTX 4500 Ada': 210,
      'NVIDIA RTX 4000 Ada': 130,
      'NVIDIA RTX 2000 Ada': 70,
      'NVIDIA RTX A6000': 300,
      'NVIDIA RTX A5000': 230,
      'NVIDIA RTX A4000': 140,
      'NVIDIA RTX A2000': 70,
      'NVIDIA Quadro RTX 8000': 295,
      'NVIDIA Quadro RTX 6000': 295,
      'NVIDIA Quadro RTX 5000': 230,
      'NVIDIA Quadro RTX 4000': 160,
      // ── AMD Radeon RX 9000 Series (RDNA 4) ───────────────────────────────
      'AMD Radeon RX 9070 XT': 304,
      'AMD Radeon RX 9070': 220,
      // ── AMD Radeon RX 7000 Series (RDNA 3) ───────────────────────────────
      'AMD Radeon RX 7900 XTX': 355,
      'AMD Radeon RX 7900 XT': 315,
      'AMD Radeon RX 7900 GRE': 260,
      'AMD Radeon RX 7800 XT': 263,
      'AMD Radeon RX 7700 XT': 245,
      'AMD Radeon RX 7600 XT': 190,
      'AMD Radeon RX 7600': 165,
      'AMD Radeon RX 7500 XT': 100,
      // ── AMD Radeon RX 6000 Series (RDNA 2) ───────────────────────────────
      'AMD Radeon RX 6950 XT': 335,
      'AMD Radeon RX 6900 XT': 300,
      'AMD Radeon RX 6800 XT': 300,
      'AMD Radeon RX 6800': 250,
      'AMD Radeon RX 6750 XT': 250,
      'AMD Radeon RX 6700 XT': 230,
      'AMD Radeon RX 6700': 175,
      'AMD Radeon RX 6650 XT': 180,
      'AMD Radeon RX 6600 XT': 160,
      'AMD Radeon RX 6600': 132,
      'AMD Radeon RX 6500 XT': 107,
      'AMD Radeon RX 6400': 53,
      // ── AMD Radeon RX 5000 Series (RDNA 1) ───────────────────────────────
      'AMD Radeon RX 5700 XT': 225,
      'AMD Radeon RX 5700': 180,
      'AMD Radeon RX 5600 XT': 150,
      'AMD Radeon RX 5500 XT': 130,
      // ── AMD Radeon Vega / GCN ─────────────────────────────────────────────
      'AMD Radeon RX Vega 64': 295,
      'AMD Radeon RX Vega 56': 210,
      'AMD Radeon VII': 300,
      'AMD Radeon RX 590': 225,
      'AMD Radeon RX 580': 185,
      'AMD Radeon RX 570': 150,
      'AMD Radeon RX 480': 150,
      'AMD Radeon RX 470': 120,
      // ── AMD Radeon PRO Workstation ────────────────────────────────────────
      'AMD Radeon PRO W7900': 295,
      'AMD Radeon PRO W7800': 260,
      'AMD Radeon PRO W6800': 250,
      'AMD Radeon PRO W6600': 130,
      'AMD Radeon PRO W6400': 50,
      // ── Intel Arc ────────────────────────────────────────────────────────
      'Intel Arc A770': 225,
      'Intel Arc A750': 225,
      'Intel Arc A580': 185,
      'Intel Arc A380': 75,
      'Intel Arc A310': 30,
      'Intel Arc B580': 190,
      'Intel Arc B570': 150,
      // ── NVIDIA GeForce GTX 700 Series (Kepler) ────────────────────────────
      'NVIDIA GeForce GTX 780 Ti': 250,
      'NVIDIA GeForce GTX 780': 250,
      'NVIDIA GeForce GTX 770': 230,
      'NVIDIA GeForce GTX 760': 170,
      'NVIDIA GeForce GTX 750 Ti': 60,
      'NVIDIA GeForce GTX 750': 55,
      // ── NVIDIA GeForce GTX 600 Series (Kepler) ────────────────────────────
      'NVIDIA GeForce GTX 690': 300,
      'NVIDIA GeForce GTX 680': 195,
      'NVIDIA GeForce GTX 670': 170,
      'NVIDIA GeForce GTX 660 Ti': 150,
      'NVIDIA GeForce GTX 660': 140,
      'NVIDIA GeForce GTX 650 Ti': 110,
      'NVIDIA GeForce GTX 650': 64,
      // ── NVIDIA GeForce GTX 500 Series (Fermi) ─────────────────────────────
      'NVIDIA GeForce GTX 590': 365,
      'NVIDIA GeForce GTX 580': 244,
      'NVIDIA GeForce GTX 570': 219,
      'NVIDIA GeForce GTX 560 Ti': 170,
      'NVIDIA GeForce GTX 560': 150,
      'NVIDIA GeForce GTX 550 Ti': 116,
      // ── AMD Radeon RX 400 Series (Polaris) ───────────────────────────────
      'AMD Radeon RX 460': 75,
      // ── AMD Radeon R9 / R7 / R5 (GCN 1â€“3) ───────────────────────────────
      'AMD Radeon R9 Fury X': 275,
      'AMD Radeon R9 Fury': 275,
      'AMD Radeon R9 Nano': 175,
      'AMD Radeon R9 390X': 275,
      'AMD Radeon R9 390': 275,
      'AMD Radeon R9 380X': 190,
      'AMD Radeon R9 380': 190,
      'AMD Radeon R9 290X': 290,
      'AMD Radeon R9 290': 275,
      'AMD Radeon R9 285': 190,
      'AMD Radeon R9 280X': 250,
      'AMD Radeon R9 280': 200,
      'AMD Radeon R9 270X': 180,
      'AMD Radeon R9 270': 150,
      'AMD Radeon R7 370': 110,
      'AMD Radeon R7 360': 80,
      'AMD Radeon R7 265': 150,
      'AMD Radeon R7 260X': 95,
      'AMD Radeon R5 230': 19,
      // ── AMD Radeon HD 7000 Series (GCN 1) ─────────────────────────────────
      'AMD Radeon HD 7990': 375,
      'AMD Radeon HD 7970': 250,
      'AMD Radeon HD 7950': 200,
      'AMD Radeon HD 7870': 175,
      'AMD Radeon HD 7850': 130,
      'AMD Radeon HD 7790': 100,
      'AMD Radeon HD 7770': 80,
      'AMD Radeon HD 7750': 55,
    }),
    [],
  );

  // Family regex fallback tables
  const cpuPowerTable = [
    // ── Mobile/ULP suffix-specific fallback (checked first — more specific) ──
    { regex: /HX$|HK$/i, power: 55 },
    { regex: /HS$/i, power: 35 },
    { regex: /H$|HQ$|QM$/i, power: 45 },
    { regex: /P$/i, power: 28 },
    { regex: /U$/i, power: 15 },
    { regex: /Y$/i, power: 9 },
    { regex: /M$/i, power: 35 },
    { regex: /G[147]$/i, power: 15 }, // Tiger Lake / Alder Lake U-series (G7/G4/G1)
    { regex: /\bN\d{3,4}$/i, power: 8 },
    { regex: /\bJ\d{4}$/i, power: 10 },
    { regex: /GE$/i, power: 35 }, // AMD low-power desktop APU
    { regex: /GT$/i, power: 65 }, // AMD high-clock desktop APU
    { regex: /G$/i, power: 65 }, // AMD desktop APU
    { regex: /T$/i, power: 35 }, // Intel low-power desktop T-series
    // ── Generic tier-based (desktop fallback) ─────────────────────────────────
    { regex: /i9|Ryzen 9/i, power: 125 },
    { regex: /i7|Ryzen 7/i, power: 95 },
    { regex: /i5|Ryzen 5/i, power: 75 },
    { regex: /i3|Ryzen 3/i, power: 55 },
    { regex: /Celeron|Pentium|Atom|Athlon|A4|A6|A8|A9|A10|A12/i, power: 35 },
    { regex: /M1|M2|M3/i, power: 25 }, // Apple Silicon
    { regex: /Xeon|EPYC/i, power: 180 },
  ];
  const gpuPowerTable = [
    { regex: /4090|4080|7900|3090|3080|6900|2080|1080/i, power: 350 },
    { regex: /3070|6800|2070|1070/i, power: 220 },
    { regex: /3060|1660|2060|6600|3050/i, power: 170 },
    { regex: /Arc|Iris|HD|UHD|Intel/i, power: 60 },
    { regex: /Quadro|FirePro/i, power: 120 },
    { regex: /RTX/i, power: 250 },
    { regex: /GTX/i, power: 180 },
    { regex: /Radeon/i, power: 200 },
  ];
  const asicPowerTable = [
    { regex: /Antminer.*S21\s*XP/i, power: 3650 },
    { regex: /Antminer.*S21/i, power: 3500 },
    { regex: /Antminer.*T21/i, power: 3610 },
    { regex: /Antminer.*S19\s*XP/i, power: 3010 },
    { regex: /Antminer.*S19\s*Pro\+/i, power: 5000 },
    { regex: /Antminer.*S19\s*Pro/i, power: 3250 },
    { regex: /Antminer.*S19j\s*Pro\+/i, power: 3220 },
    { regex: /Antminer.*S19j\s*Pro/i, power: 3050 },
    { regex: /Antminer.*S19j/i, power: 3100 },
    { regex: /Antminer.*S19/i, power: 3250 },
    { regex: /Antminer.*T19/i, power: 3150 },
    { regex: /Antminer.*S17\+/i, power: 2920 },
    { regex: /Antminer.*S17\s*Pro/i, power: 2090 },
    { regex: /Antminer.*T17\+/i, power: 2800 },
    { regex: /Antminer.*T17/i, power: 2200 },
    { regex: /Antminer.*S15/i, power: 1590 },
    { regex: /Antminer.*T15/i, power: 1540 },
    { regex: /Antminer.*S9[kji]|S9\s*\(/i, power: 1400 },
    { regex: /Antminer.*S9/i, power: 1350 },
    { regex: /Whatsminer.*M66/i, power: 5500 },
    { regex: /Whatsminer.*M60S/i, power: 3500 },
    { regex: /Whatsminer.*M60/i, power: 3306 },
    { regex: /Whatsminer.*M56/i, power: 5500 },
    { regex: /Whatsminer.*M50S\+\+/i, power: 3470 },
    { regex: /Whatsminer.*M50S/i, power: 3500 },
    { regex: /Whatsminer.*M50/i, power: 3270 },
    { regex: /Whatsminer.*M30S\+\+/i, power: 3472 },
    { regex: /Whatsminer.*M30S\+/i, power: 3400 },
    { regex: /Whatsminer.*M30S/i, power: 3260 },
    { regex: /Whatsminer.*M30/i, power: 3260 },
    { regex: /Whatsminer.*M32/i, power: 3200 },
    { regex: /Whatsminer.*M31S/i, power: 3360 },
    { regex: /Whatsminer.*M21S/i, power: 3360 },
    { regex: /Whatsminer.*M20S/i, power: 3400 },
    { regex: /Whatsminer.*M20/i, power: 2800 },
    { regex: /Avalon.*A1466I/i, power: 3320 },
    { regex: /Avalon.*A1366I/i, power: 3570 },
    { regex: /Avalon.*A1266/i, power: 3420 },
    { regex: /Avalon.*A1166\s*Pro/i, power: 3400 },
    { regex: /Avalon.*A1166/i, power: 3250 },
    { regex: /Avalon.*A1066/i, power: 3200 },
  ];

  // 1. Try exact model TDP for CPU + sum TDP of ALL detected GPUs
  let matched = false;
  let cpuTDP = null;
  let gpuTDP = null; // total across all detected GPUs
  const cpuSocketCount = Math.max(1, Number(hardware.cpuSockets) || 1);
  // Core-count cross-validation: cap socket count against navigator.hardwareConcurrency.
  // Prevents inflated multi-socket claims from multiplying TDP fraudulently.
  const navCores = Math.max(1, navigator.hardwareConcurrency || 1);
  const maxCredibleSockets = Math.max(1, Math.floor(navCores / 2));
  const coreValidatedSocketCount = Math.min(cpuSocketCount, maxCredibleSockets);
  let cpuKey = '';

  if (hardware.cpu) {
    cpuKey = hardware.cpu.split(' (')[0].replace(/(?: CPU)? @ [\d.]+GHz?$/i, '');
    const w = cpuTDPTable[cpuKey];
    if (w) {
      cpuTDP = w * coreValidatedSocketCount;
      matched = true;
    }
  }
  if (allGpuModels.length > 0) {
    let gpuTDPSum = 0;
    let anyGpuMatched = false;
    for (const gpuModel of allGpuModels) {
      const w = gpuTDPTable[gpuModel];
      if (w) {
        gpuTDPSum += w;
        anyGpuMatched = true;
      }
    }
    if (anyGpuMatched) {
      gpuTDP = gpuTDPSum;
      matched = true;
    }
  }
  // Memory power estimate — per-type W/GB based on JEDEC specs at active load.
  // LPDDR (mobile): ~0.15 W/GB (1.1 V, low-power)
  // DDR5 / LPDDR5: ~0.25 W/GB (1.1 V; faster but lower voltage than DDR4)
  // DDR4: ~0.375 W/GB (1.2 V; ~3 W per 8 GB DIMM)
  // DDR3: ~0.5 W/GB (1.35–1.5 V; older generation)
  // ECC RDIMM (servers): ~0.6 W/GB — raw cells + register + ECC logic overhead;
  //   server memory runs hotter per GB under sustained load.
  // Cap: consumer/laptop capped at 40 W (≤128 GB practical); servers uncapped
  //   because a 4-socket server with 512 GB ECC draws ~300 W from memory alone.
  const memType = (hardware.memType || '').toUpperCase();
  const isServer = hardware.deviceType === 'Server';
  const isLaptop = hardware.deviceType === 'Laptop' || hardware.deviceType === 'Mini PC';
  const isLPDDR = /LPDDR/.test(memType);
  const isDDR5 = /DDR5/.test(memType);
  const isDDR3 = /DDR3/.test(memType);
  const wPerGB = isServer
    ? 0.6
    : isLPDDR
      ? 0.15
      : isDDR5
        ? isLaptop
          ? 0.2
          : 0.25
        : isDDR3
          ? isLaptop
            ? 0.4
            : 0.5
          : isLaptop
            ? 0.3
            : 0.375;
  const memCapW = isServer ? Infinity : 40;
  const memPowerW = Math.min(memCapW, Math.max(0, Math.round((Number(hardware.memTotalGB) || 0) * wPerGB)));

  // Regex fallback for whichever component was not in the exact tables.
  // Without this, a PC with only one matched side (e.g. CPU in table but GPU not)
  // would silently omit the other component from the estimate.
  if (cpuTDP === null && cpuKey) {
    for (const entry of cpuPowerTable) {
      if (entry.regex.test(cpuKey)) {
        cpuTDP = entry.power * coreValidatedSocketCount;
        if (!matched) matched = true;
        break;
      }
    }
  }
  if (gpuTDP === null && allGpuModels.length > 0) {
    let gpuRegexSum = 0;
    for (const gpuModel of allGpuModels) {
      for (const entry of gpuPowerTable) {
        if (entry.regex.test(gpuModel)) {
          gpuRegexSum += entry.power;
          break;
        }
      }
    }
    if (gpuRegexSum > 0) {
      gpuTDP = gpuRegexSum;
      if (!matched) matched = true;
    }
  }

  if (matched) {
    if (hardware.deviceType === 'ASIC') {
      // ASICs are whole-device units — look up model power, don't decompose.
      let asicPower = null;
      for (const entry of asicPowerTable) {
        if (entry.regex.test(hardware.gpu)) {
          asicPower = entry.power;
          break;
        }
      }
      if (asicPower !== null) powerW = asicPower;
    } else if (
      hardware.deviceType === 'Desktop' ||
      hardware.deviceType === 'PC' ||
      hardware.deviceType === 'Server' ||
      hardware.deviceType === 'Mac'
    ) {
      if (cpuTDP !== null && gpuTDP !== null) powerW = cpuTDP + gpuTDP;
      else if (cpuTDP !== null) powerW = cpuTDP;
      else if (gpuTDP !== null) powerW = gpuTDP;
      powerW += memPowerW;
    } else if (hardware.deviceType === 'Laptop' || isWholeDeviceMiniPcModel) {
      // Laptops and Mini PCs mine CPU-only — iGPU power is inside CPU TDP envelope.
      if (cpuTDP !== null) {
        totalHardwareTDPRef.current = cpuTDP;
        powerW = cpuTDP + memPowerW;
      }
    }
  }

  // 2. Try device type and family regex if not matched — iterate all GPUs for sum
  if (!matched) {
    if (hardware.deviceType === 'Laptop' || isWholeDeviceMiniPcModel) {
      // CPU-only: use regex fallback table; no GPU contribution.
      let regexCpuTDP = null;
      if (cpuKey) {
        for (const entry of cpuPowerTable) {
          if (entry.regex.test(cpuKey)) {
            regexCpuTDP = entry.power * coreValidatedSocketCount;
            break;
          }
        }
      }
      if (regexCpuTDP !== null) {
        totalHardwareTDPRef.current = regexCpuTDP;
        powerW = regexCpuTDP + memPowerW;
        matched = true;
      }
      // If still not matched, powerW stays 0 (mining impossible)
    } else if (hardware.deviceType === 'Desktop' || hardware.deviceType === 'PC' || hardware.deviceType === 'Server') {
      // Sum regex TDP estimates across ALL GPUs
      let gpuRegexSum = 0;
      for (const gpuModel of allGpuModels) {
        for (const entry of gpuPowerTable) {
          if (entry.regex.test(gpuModel)) {
            gpuRegexSum += entry.power;
            break;
          }
        }
      }
      if (gpuRegexSum > 0) {
        powerW = gpuRegexSum;
        matched = true;
      }
      if (!matched && cpuKey) {
        for (const entry of cpuPowerTable) {
          if (entry.regex.test(cpuKey)) {
            powerW = entry.power * coreValidatedSocketCount;
            matched = true;
            break;
          }
        }
      }
      // Add CPU regex estimate when a GPU sum was used as base
      if (matched && gpuRegexSum > 0 && cpuKey) {
        for (const entry of cpuPowerTable) {
          if (entry.regex.test(cpuKey)) {
            powerW += entry.power * coreValidatedSocketCount;
            break;
          }
        }
      }
      if (matched) powerW += memPowerW;
    } else if (hardware.deviceType === 'ASIC') {
      let asicPower = null;
      for (const entry of asicPowerTable) {
        if (entry.regex.test(hardware.gpu)) {
          asicPower = entry.power;
          break;
        }
      }
      if (asicPower !== null) powerW = asicPower;
    }
  }

  const clampedLoadPercent = Math.min(MAX_HARDWARE_LOAD_PERCENT, Math.max(0, Number(loadPercent) || 0));

  // Benchmark-verified cap: clamp hardware-profile estimate to max credible power from measured throughput.
  const hwProfileRaw = powerW;

  // unitFullPowerW must be captured BEFORE the benchmark cap so "Max hardware power" always reflects
  // the trust-adjusted unit TDP ceiling, not a potentially lower early-benchmark reading.
  // Each TDP component is scaled by its own calibration factor (CPU speed ratio, memory bandwidth
  // ratio, and GPU ALU score ratio).  Blend formula: 0.5 + 0.5×ratio, clamped 0.20–1.20.
  const trustFactor = Math.min(1.0, 0.2 + (trustScore / 100) * 0.8);
  // Calibrated component breakdown (used for both unitFullPowerW and display).
  const calibratedCpuTDP = (cpuTDP !== null ? cpuTDP : 0) * benchmarkOpsCalibration;
  const calibratedGpuTDP = (gpuTDP !== null ? gpuTDP : 0) * benchmarkGpuCalibration;
  const calibratedMemPowerW = memPowerW * benchmarkMemCalibration;
  // Re-derive total with calibrated components; keep original powerW path for laptop (single unit).
  let calibratedPowerW;
  if (hardware.deviceType === 'Laptop' || isWholeDeviceMiniPcModel) {
    // Laptop is modelled as one whole-unit TDP — apply CPU calibration to the whole.
    calibratedPowerW = (Number(powerW) || 0) * benchmarkOpsCalibration;
  } else if (cpuTDP !== null || gpuTDP !== null) {
    calibratedPowerW = calibratedCpuTDP + calibratedGpuTDP + calibratedMemPowerW;
  } else {
    // No component breakdown available — fall back to single-factor calibration.
    calibratedPowerW = (Number(powerW) || 0) * benchmarkOpsCalibration;
  }
  const unitFullPowerW = Math.max(0, Math.round(calibratedPowerW));
  unitFullPowerWRef.current = unitFullPowerW; // keep ref in sync for runBenchmark
  const basePowerW = Math.round(unitFullPowerW * trustFactor); // trust-capped ceiling → "Max hardware power"
  // Effective load: slider capped at the trust ceiling. Moving the slider above the ceiling
  // has no effect until trust grows — the machine simply won't run hotter than it can be credited for.
  const effectiveLoadPercent = Math.min(clampedLoadPercent, Math.round(trustFactor * 100));

  const hasEstimate = (Number(powerW) || 0) > 0;
  if (!hasEstimate) powerW = 0;

  // Step 1: apply slider fraction to the full hardware power estimate.
  // Step 2: cap at the trust ceiling (basePowerW).
  // Step 3: cap at the benchmark-verified ceiling (benchmarkPowerCapW) as a hard safety limit.
  // Keeping slider and trust applied before the benchmark cap means the slider always
  // expresses a true fraction of creditable power — Wh-per-coin stays constant.
  powerW = Math.min(powerW * (effectiveLoadPercent / 100), basePowerW);
  if (benchmarkPowerCapW !== null && benchmarkPowerCapW > 0) {
    powerW = Math.min(powerW, benchmarkPowerCapW);
  }
  // Zero out power contribution while hardware is on hold after consecutive drift failures.
  if (isHardwareOnHold) powerW = 0;
  const totalPowerUsedW = powerW;
  const _miningPowerUsedW = mining ? Math.max(0, powerW) : 0;

  const _normalizedConfidenceTier = 'estimated';
  const _normalizedSourceName = 'local hardware profile model';

  const powerSourceAccent = '#4a7a4a';
  const powerSourceLabel =
    Number(benchPower) > 0 && basePowerW === Number(benchPower)
      ? 'benchmark fallback estimate'
      : 'hardware profile estimate';
  const hardwareCardPowerCalcBreakdown = (() => {
    const dt = hardware.deviceType;
    const isLaptop = dt === 'Laptop';
    const isPC = dt === 'Desktop' || dt === 'PC' || dt === 'Server';
    const isASIC = dt === 'ASIC';
    const isMac = dt === 'Mac';
    if (isLaptop || isASIC || isMac || isWholeDeviceMiniPcModel) {
      return `unit: ${Math.round(hwProfileRaw || 0)} W`;
    }
    if (isPC) {
      const parts = [];
      if (Math.round(gpuTDP || 0) > 0) parts.push(`GPU: ${Math.round(gpuTDP)} W`);
      if (Math.round(cpuTDP || 0) > 0) parts.push(`CPU: ${Math.round(cpuTDP)} W`);
      if (Math.round(memPowerW || 0) > 0) parts.push(`Mem: ${Math.round(memPowerW)} W`);
      if (parts.length > 0) return parts.join(' + ');
    }
    return `unit: ${Math.round(hwProfileRaw || 0)} W`;
  })();
  const _powerCalcBreakdown = (() => {
    const dt = hardware.deviceType;
    const isLaptop = dt === 'Laptop';
    const isPC = dt === 'Desktop' || dt === 'PC' || dt === 'Server';
    const isASIC = dt === 'ASIC';
    const isMac = dt === 'Mac';
    if (isLaptop) {
      return `unit: ${Math.round(unitFullPowerW)} W`;
    }
    if (isASIC) return `unit: ${unitFullPowerW > 0 ? unitFullPowerW : 3500} W`;
    if (isMac) return `unit: ${unitFullPowerW} W`;
    if (isPC) {
      const parts = [];
      if (Math.round(calibratedGpuTDP) > 0) parts.push(`GPU: ${Math.round(calibratedGpuTDP)} W`);
      if (Math.round(calibratedCpuTDP) > 0) parts.push(`CPU: ${Math.round(calibratedCpuTDP)} W`);
      if (Math.round(calibratedMemPowerW) > 0) parts.push(`Mem: ${Math.round(calibratedMemPowerW)} W`);
      if (parts.length > 0) return parts.join(' + ');
      return `unit: ${unitFullPowerW} W`;
    }
    return `unit: ${unitFullPowerW} W`;
  })();
  const _liveWattageSmallLabel = `Power used live (estimated): ${fmtNum(totalPowerUsedW, 2)} W`;
  const _normalizedConfidenceLabel = CONFIDENCE_TIER_LABELS.estimated;
  const _normalizedEnergyLabel = 'Telemetry energy: model-driven (local miner accounting only)';
  const _powerTrustLabel = 'unattested (no live sensors)';

  // Track non-mining baseline power to estimate mining-only delta from live telemetry.
  React.useEffect(() => {
    if (mining) return;
    const sample = Math.max(0, Number(totalPowerUsedW) || 0);
    if (sample <= 0) return;
    setBaselinePowerW((prev) => (prev > 0 ? prev * 0.9 + sample * 0.1 : sample));
  }, [mining, totalPowerUsedW]);
  const totalTiers = TOTAL_TIERS;
  const totalCoinSupply = COINS_PER_TIER * totalTiers;
  const appEstimatedCoins = Math.max(0, computeCoinsFromEnergy(energy));
  const nodeMatured = Math.max(0, Number(maturedCoins) || 0);
  const nodeUnmatured = Math.max(0, Number(unmaturedCoins) || 0);
  const nodeTotal = Math.max(0, Number(coins) || 0, nodeMatured + nodeUnmatured);
  const _nodeStatusCoins = Math.max(0, nodeMatured + nodeUnmatured);
  const chainEmittedCoins = (() => {
    if (chainHeight < 0) return 0;
    let total = 1_000_000; // genesis premine (Tier 0)
    let remaining = chainHeight; // energy blocks 1..height
    for (let tier = 1; tier < TOTAL_TIERS; tier++) {
      if (remaining <= 0) break;
      const reward = rewardForTier(tier);
      const blocksThisTier = Math.round(COINS_PER_TIER / reward);
      const mined = Math.min(remaining, blocksThisTier);
      total += mined * reward;
      remaining -= mined;
    }
    return total;
  })();
  const chainTier = globalTierFromHeight(chainHeight);
  const currentTier = Math.max(chainTier, Math.min(Math.floor(appEstimatedCoins / COINS_PER_TIER), totalTiers - 1));
  const statusTier = Math.max(chainTier, Math.min(Math.floor(chainEmittedCoins / COINS_PER_TIER), totalTiers - 1));
  const tierEnergyPerCoinWh = energyForTier(currentTier);
  const tierRewardCoins = rewardForTier(currentTier);
  const minedPct = totalCoinSupply > 0 ? Math.min(100, (chainEmittedCoins / totalCoinSupply) * 100) : 0;
  const hardwareRecognitionFinished = !!(hardware && hardware.source);
  const hardwareUnknown =
    hardwareRecognitionFinished &&
    (!hardwareRecognizedByNetwork ||
      hardware.deviceType === 'Unknown' ||
      hardware.cpu === 'Unknown' ||
      (Array.isArray(hardware.gpus) && hardware.gpus.some((g) => g === 'Unknown' || !g)));
  const startupBenchmarkPending = hardwareRecognitionFinished && !benchmarkState.startupDone && clampedLoadPercent > 0;
  // Persist the card's rendered width once hardware is fully loaded so the next
  // launch pre-sizes the card and avoids a layout jump.
  React.useEffect(() => {
    if (!hardwareRecognitionFinished) return;
    if (!hwCardRef.current) return;
    const t = setTimeout(() => {
      const w = hwCardRef.current && hwCardRef.current.offsetWidth;
      if (w > 0) {
        try {
          localStorage.setItem('wattcoin-hw-card-width', String(w));
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }
        setSavedHwCardWidth(w);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [hardwareRecognitionFinished, hardware]); // eslint-disable-line react-hooks/exhaustive-deps
  // Once hardware recognition finishes, confirm against the coordinator's authoritative tables.
  React.useEffect(() => {
    if (!hardwareRecognitionFinished) return;
    let cancelled = false;
    const gpuModels = [];
    if (Array.isArray(hardware.gpus)) {
      for (const g of hardware.gpus) {
        if (g && g !== 'Unknown') gpuModels.push(g);
      }
    }
    const cpuModel = hardware.cpu && hardware.cpu !== 'Unknown' ? hardware.cpu : null;
    const asicModel =
      hardware.deviceType === 'ASIC' && hardware.gpu && hardware.gpu !== 'Unknown' ? hardware.gpu : null;
    const deviceType = hardware.deviceType || 'Unknown';
    if (deviceType === 'Laptop' || deviceType === 'Mini PC') {
      // iGPU TDP is inside CPU envelope; dGPU is not used for mining
      gpuModels.length = 0;
    }
    if (gpuModels.length === 0 && !cpuModel && !asicModel) {
      setHardwareRecognizedByNetwork(false);
      return;
    }
    window.wattcoinHardware
      .isHardwareRecognized({ deviceType, gpuModels, cpuModel, asicModel })
      .then((res) => {
        if (!cancelled && res && !res.recognized) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Unrecognized hardware:', res.unrecognized);
          setHardwareRecognizedByNetwork(false);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hardwareRecognitionFinished]); // eslint-disable-line react-hooks/exhaustive-deps

  // Weighted suspicious-event trigger: anomaly score increases benchmark trigger probability.
  // Run on a timer while mining is active so stable sessions still receive surprise checks.
  React.useEffect(() => {
    if (!ENABLE_BACKGROUND_BENCHMARKS) return;
    if (isHardwareOnHold) return;
    if (!mining) return;

    let cancelled = false;
    const evaluateSuspiciousBenchmark = async () => {
      if (cancelled) return;
      if (benchmarkInFlightRef.current) return;

      const nowMs = Date.now();
      const minCooldownMs = 8000;
      if (nowMs - lastSuspiciousBenchmarkMsRef.current < minCooldownMs) return;

      let suspicionScore = 0;
      const reasons = [];
      const currentIssues = Array.isArray(benchmarkState.issues) ? benchmarkState.issues : [];
      const currentJitterPct = Number(benchmarkState.lastJitterPct) || 0;
      const lastTrustDelta = Number(benchmarkState.lastTrustDelta) || 0;
      const effectiveLoad = Math.max(0, Number(effectiveLoadPercent) || 0);

      if (benchmarkRetryPendingRef.current) {
        suspicionScore += 3;
        reasons.push('extended-retry-pending');
      }

      if (currentIssues.length > 0) {
        suspicionScore += 3;
        reasons.push('benchmark-issues-present');
      }

      if (currentJitterPct >= 20) {
        suspicionScore += 2;
        reasons.push(`elevated-jitter-${currentJitterPct.toFixed(1)}pct`);
      }

      if (lastTrustDelta < 0) {
        suspicionScore += 2;
        reasons.push(`trust-drop-${lastTrustDelta}`);
      }

      if (effectiveLoad >= 50) {
        try {
          if (window.wattcoinHardware && window.wattcoinHardware.getHardwareLoadState) {
            const hwState = await window.wattcoinHardware.getHardwareLoadState();
            const cpuDuty = Math.max(0, Math.min(1, Number(hwState && hwState.avgCpuWorkerDuty) || 0));
            const memDuty = Math.max(0, Math.min(1, Number(hwState && hwState.memDuty) || 0));
            const gpuDuty = Math.max(0, Math.min(1, Number(gpuMeasuredDutyRef.current) || 0));
            const peakDuty = Math.max(cpuDuty, memDuty, gpuDuty);
            const expectedFloor = Math.max(0.08, (effectiveLoad / 100) * 0.35);
            if (peakDuty > 0 && peakDuty < expectedFloor) {
              suspicionScore += 2;
              reasons.push(`load-duty-mismatch-${Math.round(effectiveLoad)}pct-vs-${Math.round(peakDuty * 100)}pct`);
            }
          }
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }
      }

      if (suspicionScore <= 0) return;

      const triggerProbability = Math.min(0.9, suspicionScore * 0.15);
      if (Math.random() < triggerProbability) {
        lastSuspiciousBenchmarkMsRef.current = nowMs;
        setLog((log) => [
          {
            time: now(),
            msg: `Suspicious telemetry trigger (score=${suspicionScore}, p=${(triggerProbability * 100).toFixed(0)}%, reasons=${reasons.join('|')})`,
            type: 'warn',
          },
          ...log,
        ]);
        runBenchmark('surprise-suspicious');
      }
    };

    const timer = setInterval(() => {
      evaluateSuspiciousBenchmark().catch(() => {});
    }, SUSPICIOUS_BENCH_EVAL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    benchmarkState.issues,
    benchmarkState.lastJitterPct,
    benchmarkState.lastTrustDelta,
    effectiveLoadPercent,
    isHardwareOnHold,
    mining,
    runBenchmark,
    setLog,
    now,
  ]);

  const coinsPerHour = tierEnergyPerCoinWh > 0 ? powerW / tierEnergyPerCoinWh : 0;
  const displayUnmatured = Math.max(0, nodeUnmatured);
  const displayMatured = Math.max(0, nodeMatured);
  const coinsPerDay = coinsPerHour * 24;
  const coinsPerWeek = coinsPerDay * 7;
  const coinsPerMonth = coinsPerDay * 30;
  const coinsPerYear = coinsPerDay * 365;

  const coinsRateLabel = (() => {
    if (coinsPerHour >= 1) return `${fmtNum(coinsPerHour, 4)} coins/hour`;
    if (coinsPerDay >= 1) return `${fmtNum(coinsPerDay, 4)} coins/day`;
    if (coinsPerWeek >= 1) return `${fmtNum(coinsPerWeek, 4)} coins/week`;
    if (coinsPerMonth >= 1) return `${fmtNum(coinsPerMonth, 4)} coins/month`;
    return `${fmtNum(coinsPerYear, 6)} coins/year`;
  })();

  const timePerCoinHours = coinsPerHour > 0 ? 1 / coinsPerHour : Infinity;
  const timePerCoinLabel = (() => {
    if (!Number.isFinite(timePerCoinHours)) return 'infinite (no mining power estimate yet)';
    if (timePerCoinHours < 24) return `${fmtNum(timePerCoinHours, 2)} hours`;
    if (timePerCoinHours < 24 * 7) return `${fmtNum(timePerCoinHours / 24, 2)} days`;
    if (timePerCoinHours < 24 * 30) return `${fmtNum(timePerCoinHours / (24 * 7), 2)} weeks`;
    if (timePerCoinHours < 24 * 365) return `${fmtNum(timePerCoinHours / (24 * 30), 2)} months`;
    return `${fmtNum(timePerCoinHours / (24 * 365), 2)} years`;
  })();

  React.useEffect(() => {
    const wasMining = prevMiningStateRef.current;
    prevMiningStateRef.current = mining;

    const targetAddress =
      typeof miningAddress === 'string' && miningAddress.trim()
        ? miningAddress.trim()
        : 'auto (primary wallet address)';
    const energyPerBlockWh = tierEnergyPerCoinWh * tierRewardCoins;

    if (!wasMining && mining) {
      // Fetch current round contribution so the start log shows running total.
      (async () => {
        let roundWhStr = '';
        try {
          if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
            const bal = await window.wattcoinHardware
              .invoke('wattcoin-ledger-get-balances', targetAddress)
              .catch(() => null);
            const roundWh =
              bal && typeof bal.currentRoundContributionWh === 'number' ? bal.currentRoundContributionWh : 0;
            if (roundWh > 0) roundWhStr = ` (round so far: ${fmtEnergy(roundWh)})`;
          }
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }
        setLog((log) => [
          {
            time: now(),
            msg: `Mining started (tier ${currentTier}, target ${fmtEnergy(energyPerBlockWh)} per block, address=${targetAddress})${roundWhStr}`,
            type: 'info',
          },
          ...log,
        ]);
      })();
    } else if (wasMining && !mining) {
      // Fetch current round contribution so the stop log shows how much was contributed.
      (async () => {
        let roundWhStr = '';
        try {
          if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
            const bal = await window.wattcoinHardware
              .invoke('wattcoin-ledger-get-balances', targetAddress)
              .catch(() => null);
            const roundWh =
              bal && typeof bal.currentRoundContributionWh === 'number' ? bal.currentRoundContributionWh : 0;
            if (roundWh > 0) roundWhStr = ` (contributed ${fmtEnergy(roundWh)} this round)`;
          }
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }
        setLog((log) => [
          {
            time: now(),
            msg: `Mining stopped${roundWhStr}`,
            type: 'info',
          },
          ...log,
        ]);
      })();
    }
  }, [mining, miningAddress, currentTier, tierEnergyPerCoinWh, tierRewardCoins, setLog, now]);

  // Notify main process when mining starts/stops so it can forward the status
  // to coordinators. Also start/stop ASIC miners together with the PC.
  React.useEffect(() => {
    const hw = window.wattcoinHardware;
    if (!hw) return;
    if (hw.invoke) {
      hw.invoke('wattcoin-mining-status', { mining: !!mining }).catch(() => {});
    }
    if (mining) {
      if (hw.startAsicMining) hw.startAsicMining().catch(() => {});
    } else {
      if (hw.stopAsicMining) hw.stopAsicMining().catch(() => {});
    }
  }, [mining]);

  // Poll per-ASIC liveness status every 30s while mining is active.
  React.useEffect(() => {
    if (!mining) {
      setAsicLiveness([]);
      return;
    }
    const hw = window.wattcoinHardware;
    if (!hw || !hw.invoke) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await hw.invoke('wattcoin-asic-liveness-status');
        if (!cancelled && res && res.ok) setAsicLiveness(res.status || []);
      } catch (_) {
        /* timeout — ignore */
      }
    };
    poll();
    const timer = setInterval(poll, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [mining]);

  // Continuous mining loop where power->energy drives when blocks are mined.
  React.useEffect(() => {
    if (!mining) {
      energyBudgetWhRef.current = 0;
      lastRoundAttemptRef.current = { id: 0, atMs: 0 };
      setRealMineStatus('Mining stopped');
      return;
    }

    const blockRewardCoins = tierRewardCoins;
    const energyPerBlockWh = tierEnergyPerCoinWh * blockRewardCoins;
    const tickMs = 250;
    const maxBlocksPerTick = 3;

    let cancelled = false;
    let timer = null;
    let lastMs = Date.now();

    const tick = async () => {
      if (cancelled) return;
      if (peerDownRef.current) {
        setRealMineStatus('Waiting for peers...');
        return;
      }

      const nowMs = Date.now();
      const elapsedSeconds = Math.max(0, (nowMs - lastMs) / 1000);
      lastMs = nowMs;

      const effectivePowerW = Math.max(0, Number(powerW) || 0);
      if (effectivePowerW <= 0 || energyPerBlockWh <= 0) {
        setRealMineStatus('Waiting for power estimate...');
        timer = setTimeout(tick, tickMs);
        return;
      }

      try {
        if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
          const roundSummary = await window.wattcoinHardware
            .invoke('wattcoin-ledger-get-round-summary')
            .catch(() => null);
          if (roundSummary && roundSummary.ok) {
            const roundId = Math.max(0, Number(roundSummary.roundId) || 0);
            const sharedTotalWh = Math.max(0, Number(roundSummary.totalWh) || 0);
            const nowAttemptMs = Date.now();
            const lastAttempt = lastRoundAttemptRef.current || { id: 0, atMs: 0 };

            if (sharedTotalWh < energyPerBlockWh) {
              if (lastAttempt.id !== roundId) {
                lastRoundAttemptRef.current = { id: roundId, atMs: 0 };
              }
              setRealMineStatus(`Mining running... pool ${fmtEnergy(sharedTotalWh)} / ${fmtEnergy(energyPerBlockWh)}`);
              timer = setTimeout(tick, tickMs);
              return;
            }

            if (lastAttempt.id === roundId && nowAttemptMs - (lastAttempt.atMs || 0) < 5000) {
              setRealMineStatus('Shared round threshold reached, awaiting block...');
              timer = setTimeout(tick, tickMs);
              return;
            }

            lastRoundAttemptRef.current = { id: roundId, atMs: nowAttemptMs };
            const result = await mineOneRealBlock(sharedTotalWh);
            if (!cancelled && result !== 'NO_PEERS') {
              timer = setTimeout(tick, tickMs);
            }
            return;
          }
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }

      if (peerDownRef.current) {
        setRealMineStatus('Waiting for peers...');
        return;
      }

      // Accumulate available mining energy from power over elapsed time.
      energyBudgetWhRef.current += (effectivePowerW * elapsedSeconds) / 3600;

      let blocksToMine = Math.floor(energyBudgetWhRef.current / energyPerBlockWh);
      if (blocksToMine <= 0) {
        setRealMineStatus('Mining running...');
        timer = setTimeout(tick, tickMs);
        return;
      }

      blocksToMine = Math.min(blocksToMine, maxBlocksPerTick);
      let minedCount = 0;
      for (let i = 0; i < blocksToMine && !cancelled; i++) {
        const result = await mineOneRealBlock(energyPerBlockWh);
        if (result === 'NO_PEERS') break;
        if (result === true) minedCount++;
      }
      // Only deduct budget for blocks that were actually mined.
      energyBudgetWhRef.current = Math.max(0, energyBudgetWhRef.current - minedCount * energyPerBlockWh);

      if (!cancelled && !peerDownRef.current) {
        timer = setTimeout(tick, tickMs);
      }
    };

    setRealMineStatus('Mining started...');
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    mining,
    miningAddress,
    powerW,
    tierEnergyPerCoinWh,
    tierRewardCoins,
    onBlockMined,
    mineOneRealBlock,
    peerDownToggle,
  ]);

  // NEW: lift powerW to parent
  React.useEffect(() => {
    if (typeof setPowerW === 'function') setPowerW(powerW);
  }, [powerW, setPowerW]);

  // Initialize WebGL on the hidden GPU load canvas once it mounts.
  React.useEffect(() => {
    if (!allowGpuWorkloads) return;
    const canvas = gpuLoadCanvasRef.current;
    if (!canvas) return;
    const state = gpuLoadGlStateRef.current;
    if (state.initialized) return;
    try {
      // WebGL2 required: readPixels on a WebGL2 context guarantees the GPU pipeline
      // drains synchronously, giving an accurate measuredFrameMs for duty-cycle pacing.
      // WebGL1 readPixels does NOT reliably stall the pipeline on ANGLE/D3D paths,
      // causing measuredFrameMs to floor at 0.5 ms and the duty cycle to be wrong.
      const gl = canvas.getContext('webgl2');
      if (!gl) return;
      const vSrc = `#version 300 es\n        in vec2 p;\n        void main() { gl_Position = vec4(p, 0.0, 1.0); }\n      `;
      // Heavy MAD loop — same workload class as runWebGLBenchmark.
      const fSrc = `#version 300 es\n        precision highp float;\n        uniform float u;\n        out vec4 fragColor;\n        void main() {\n          vec4 v = vec4(gl_FragCoord.xy / 2048.0, u, 1.0 - u);\n          for (int i = 0; i < 256; i++) {\n            v.x = v.x * v.y + v.z * 0.00013;\n            v.y = v.y * v.z + v.w * 0.00017;\n            v.z = v.z * v.w + v.x * 0.00019;\n            v.w = v.w * v.x + v.y * 0.00023;\n          }\n          fragColor = v;\n        }\n      `;
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, vSrc);
      gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, fSrc);
      gl.compileShader(fs);
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const pLoc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(pLoc);
      gl.vertexAttribPointer(pLoc, 2, gl.FLOAT, false, 0, 0);
      const seedLoc = gl.getUniformLocation(prog, 'u');
      // Calibrate GPU frame time. WebGL2 readPixels blocks until GPU pipeline drains.
      const syncBuf = new Uint8Array(4);
      for (let i = 0; i < 3; i++) {
        // warmup: JIT + shader compile
        gl.uniform1f(seedLoc, i * 0.001);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncBuf);
      }
      const tCalib = performance.now();
      for (let i = 0; i < 5; i++) {
        gl.uniform1f(seedLoc, 0.5 + i * 0.001);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncBuf);
      const measuredFrameMs = Math.max(0.5, (performance.now() - tCalib) / 5);
      state.gl = gl;
      state.prog = prog;
      state.seedLoc = seedLoc;
      state.syncBuf = syncBuf;
      state.measuredFrameMs = measuredFrameMs;
      state.initialized = true;
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
    }
  }, [allowGpuWorkloads]);

  // GPU load loop: render heavy WebGL frames while mining is active (loads GPU like CPU workers load CPU).
  // Uses setTimeout (not requestAnimationFrame) so it continues when the window is minimized or another
  // app tab is shown -- rAF pauses in hidden pages but setTimeout keeps firing.
  // Controls GPU utilization via duty-cycle pacing: after each draw call, sleep for
  //   idleMs = ((1 - f) / f) * 16   (where f = loadFraction, 16 ms ~= one 60 fps frame)
  // so GPU busy-time / cycle-time ~= loadFraction regardless of the GPU's raw render speed.
  React.useEffect(() => {
    if (!allowGpuWorkloads) {
      if (gpuLoadRafRef.current) {
        clearTimeout(gpuLoadRafRef.current);
        gpuLoadRafRef.current = null;
      }
      return;
    }
    // Intentionally NOT gated on isActive -- GPU mining continues when other app tabs are open.
    // Peer-down stops GPU load too so the hardware is not wasted while waiting.
    const gpuLoadActive = (mining && !peerDownRef.current) || benchmarkState.running;
    if (!gpuLoadActive || isHardwareOnHold || loadPercent <= 0) {
      if (gpuLoadRafRef.current) {
        clearTimeout(gpuLoadRafRef.current);
        gpuLoadRafRef.current = null;
      }
      return;
    }
    const { gl, seedLoc, syncBuf, measuredFrameMs, initialized } = gpuLoadGlStateRef.current;
    if (!initialized || !gl) return;

    let cancelled = false;
    // Duty-cycle pacing: target GPU utilisation = loadFraction.
    // currentRenderMs tracks actual GPU render time via EMA — updated every
    // NORMAL_CALIB_TICKS ticks on the normal path, and every 50 ticks on the
    // fast-GPU path, both via a single-frame readPixels calibration pulse.
    // Between calibrations gl.flush() submits GPU work non-blocking so the JS
    // thread is free during GPU execution and window dragging stays smooth.
    // The feedback controller corrects any duty-cycle drift from EMA imprecision.
    //
    // IMPORTANT: On Windows, setTimeout has a minimum resolution floor of ~4 ms even
    // for setTimeout(fn, 0).  For fast GPUs (idleMs < TIMER_FLOOR_MS), the
    // calculated idleMs is always rounded up to ~4 ms by the OS.
    //
    // Normal path (idleMs >= 4 ms): draw + flush (non-blocking), calib readPixels every 20 ticks.
    // Fast-GPU path (idleMs < 4 ms): render busyFrames per tick, sleep 0 (OS floor ~4 ms).
    const TIMER_FLOOR_MS = 4; // Windows minimum setTimeout resolution
    const NORMAL_CALIB_TICKS = 20; // readPixels sync once every N normal-path ticks
    // Seed from calibrated value; updated per-frame by EMA so boost/throttle shifts track.
    let currentRenderMs = Math.max(0.1, measuredFrameMs || 1);
    // RENDER_MS_FLOOR prevents the EMA from collapsing to near-zero when the app is minimized
    // and the GPU driver skips actual rasterization (frames complete in ~0 ms).  Without the
    // floor, currentRenderMs → 0 and the fast-GPU path pushes 1000 frames that take ~0 ms
    // total — duty cycle collapses to ~33% (1-2 ms busy / 4 ms OS floor).
    // Floor of 0.2 ms: still below any real GPU render time; just stops the EMA death spiral.
    const RENDER_MS_FLOOR = 0.2;
    // Use effectiveLoadPercent (trust-capped slider, 0-100) so GPU duty cycle matches the
    // same fraction used by the power formula and the CPU workers.
    // Old formula was loadPercent / MAX_HARDWARE_LOAD_PERCENT (e.g. 60/85 = 70.6%) which
    // over-drove the GPU by ~10 pp and pinned it at 100% when the slider was at max.
    const loadFraction = Math.max(0.01, Math.min(1, effectiveLoadPercent / 100));
    let fastCalibTick = 0; // counts ticks since last fast-path calibration pulse
    let normalCalibTick = 0; // counts ticks since last normal-path calibration pulse

    // -------------------------------------------------------------------------
    // Rolling-window proportional feedback controller (same design as CPU/DDR workers).
    // Measures actual GPU duty cycle over the last GPU_WINDOW ticks and applies a
    // proportional correction to each upcoming idle sleep so the target is always met.
    // Timer imprecision, GPU boost/throttle shifts, and occasional scheduling spikes
    // are all automatically corrected within ~6 cycles (~few hundred ms).
    // -------------------------------------------------------------------------
    const GPU_WINDOW = 16;
    const gpuBurnBuf = new Float64Array(GPU_WINDOW);
    const gpuTotalBuf = new Float64Array(GPU_WINDOW);
    let gpuWIdx = 0;
    let gpuWFull = false;

    function gpuFeedbackIdle(nominalIdle) {
      const n = gpuWFull ? GPU_WINDOW : gpuWIdx;
      if (n < 4) return nominalIdle;
      let sumBurn = 0,
        sumTotal = 0;
      for (let i = 0; i < n; i++) {
        sumBurn += gpuBurnBuf[i];
        sumTotal += gpuTotalBuf[i];
      }
      const measuredDuty = sumBurn / sumTotal;
      const error = loadFraction - measuredDuty; // positive = under-shooting
      const avgCycle = sumTotal / n;
      return Math.max(0, nominalIdle - error * avgCycle * 2);
    }

    function gpuRecordCycle(burnMs, totalMs) {
      gpuBurnBuf[gpuWIdx] = burnMs;
      gpuTotalBuf[gpuWIdx] = totalMs;
      gpuWIdx = (gpuWIdx + 1) % GPU_WINDOW;
      if (gpuWIdx === 0) gpuWFull = true;
      const n = gpuWFull ? GPU_WINDOW : gpuWIdx;
      if (n > 0) {
        let sumBurn = 0;
        let sumTotal = 0;
        for (let i = 0; i < n; i++) {
          sumBurn += gpuBurnBuf[i];
          sumTotal += gpuTotalBuf[i];
        }
        gpuMeasuredDutyRef.current = sumTotal > 0 ? Math.max(0, Math.min(1, sumBurn / sumTotal)) : 0;
      }
    }

    function frame() {
      if (cancelled) return;

      // Recompute nominal idleMs each frame using latest measured render time.
      const nominalIdle = ((1 - loadFraction) / loadFraction) * currentRenderMs;
      // Apply feedback correction to eliminate sustained under/over-shoot.
      const idleMs = gpuFeedbackIdle(nominalIdle);

      if (idleMs >= TIMER_FLOOR_MS) {
        // Normal path: draw + non-blocking flush so JS thread is free while GPU renders.
        // Every NORMAL_CALIB_TICKS ticks do one blocking readPixels to re-measure render
        // time and keep the EMA accurate.  GPU work runs concurrently with the JS sleep
        // (async), so: measuredDuty = burnMs / actualSleep.  Feedback drives idle until
        // burnMs / idle = loadFraction  →  true GPU duty ≈ loadFraction. ✓
        normalCalibTick++;
        const t0 = performance.now();
        gl.uniform1f(seedLoc, t0 * 0.001);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        let burnMs;
        if (normalCalibTick >= NORMAL_CALIB_TICKS) {
          normalCalibTick = 0;
          // Calibration pulse: block once to measure actual GPU render time.
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncBuf);
          burnMs = Math.max(0.1, performance.now() - t0);
          currentRenderMs = Math.max(RENDER_MS_FLOOR, 0.85 * currentRenderMs + 0.15 * burnMs);
        } else {
          // Non-blocking: submit GPU work without stalling the JS thread.
          gl.flush();
          burnMs = currentRenderMs; // EMA estimate
        }
        const sleepT0 = performance.now();
        gpuLoadRafRef.current = setTimeout(() => {
          // GPU executes concurrently with JS sleep — record (burnMs, actualSleep) so
          // feedback measuredDuty = burnMs/sleep converges to loadFraction.
          if (!cancelled) gpuRecordCycle(burnMs, Math.max(burnMs, performance.now() - sleepT0));
          frame();
        }, Math.round(idleMs));
      } else {
        // Fast-GPU path: GPU render time is below the OS timer floor (~4 ms on Windows).
        // setTimeout(fn, 0) always waits ~TIMER_FLOOR_MS regardless of the requested delay,
        // so the "idle" portion of every cycle is fixed at ~TIMER_FLOOR_MS.  The correct
        // busyFrames to hit the target duty cycle is therefore:
        //   busyTime / (busyTime + TIMER_FLOOR_MS) = loadFraction
        //   busyFrames = TIMER_FLOOR_MS * loadFraction / (renderBaseMs * (1 - loadFraction))
        //
        // The feedback controller adjusts busyFrames by scaling via the duty error so the
        // window-measured actual duty converges to loadFraction each cycle.
        //
        // IMPORTANT: do NOT use readPixels every frame here — it synchronously drains the
        // entire GPU pipeline, blocking the JS thread for the full busyFrames render time
        // and making window dragging laggy.  Instead, every 50 ticks we render one frame,
        // readPixels-sync just that single frame to re-measure render time, then push the
        // remaining busyFrames non-blocking with gl.flush().  ~1% timing cost per 50 ticks.
        const n = gpuWFull ? GPU_WINDOW : gpuWIdx;
        let dutyScale = 1;
        if (n >= 4) {
          let sumBurn = 0,
            sumTotal = 0;
          for (let i = 0; i < n; i++) {
            sumBurn += gpuBurnBuf[i];
            sumTotal += gpuTotalBuf[i];
          }
          const measuredDuty = sumBurn / sumTotal;
          // Scale busyFrames proportionally to correct measured vs target duty.
          // Clamp to [0.25, 4] to avoid extreme oscillation on first few cycles.
          dutyScale = Math.max(0.25, Math.min(4, loadFraction / Math.max(0.001, measuredDuty)));
        }
        // Fast-GPU path: GPU renders concurrently with the CPU sleep, so the duty cycle is
        // busyTime / (busyTime + sleepTime).  When sleepTime is fixed at TIMER_FLOOR_MS, the
        // required busyTime = TIMER_FLOOR_MS × f / (1 - f) only holds for the BLOCKING normal
        // path.  In the async path the GPU works DURING the sleep, so the total cycle ≈ sleepMs
        // and the required busyTime = TIMER_FLOOR_MS × f  (no (1-f) denominator).
        const nominalFrames = (TIMER_FLOOR_MS * loadFraction) / currentRenderMs;
        const busyFrames = Math.min(1000, Math.max(1, Math.round(nominalFrames * dutyScale)));
        const seed0 = performance.now() * 0.001;
        fastCalibTick++;
        let burnMs = busyFrames * currentRenderMs; // estimate; overwritten on calib tick
        if (fastCalibTick >= 50) {
          fastCalibTick = 0;
          // Calibration pulse: drain all pending GPU work first so only ONE new frame
          // is timed — without this, readPixels drains the accumulated queue from the
          // previous non-calib busyFrames, inflating actualMs by Nx and causing
          // nominalFrames to shrink, which collapses real GPU duty to ~20-33%.
          gl.finish();
          const t0 = performance.now();
          gl.uniform1f(seedLoc, seed0);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncBuf);
          const actualMs = Math.max(0.1, performance.now() - t0);
          currentRenderMs = Math.max(RENDER_MS_FLOOR, 0.85 * currentRenderMs + 0.15 * actualMs);
          burnMs = actualMs * busyFrames;
          // Push remaining busyFrames non-blocking.
          for (let i = 1; i < busyFrames; i++) {
            gl.uniform1f(seedLoc, seed0 + i * 0.0001);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          }
        } else {
          for (let i = 0; i < busyFrames; i++) {
            gl.uniform1f(seedLoc, seed0 + i * 0.0001);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          }
        }
        gl.flush(); // non-blocking: submit queued GPU work without waiting for completion
        const sleepT0 = performance.now();
        gpuLoadRafRef.current = setTimeout(() => {
          // In the async fast path the GPU executes concurrently with the CPU sleep, so the
          // total cycle time ≈ sleepMs, not burnMs + sleepMs.  Recording (burnMs, sleepMs)
          // gives measuredDuty = burnMs/sleepMs which correctly tracks actual GPU duty.
          if (!cancelled) gpuRecordCycle(burnMs, Math.max(burnMs, performance.now() - sleepT0));
          frame();
        }, 0);
      }
    }
    gpuLoadRafRef.current = setTimeout(frame, 0);

    return () => {
      cancelled = true;
      if (gpuLoadRafRef.current) {
        clearTimeout(gpuLoadRafRef.current);
        gpuLoadRafRef.current = null;
      }
      gpuMeasuredDutyRef.current = 0;
    };
  }, [
    allowGpuWorkloads,
    mining,
    benchmarkState.running,
    loadPercent,
    effectiveLoadPercent,
    isHardwareOnHold,
    peerDownToggle,
  ]);

  // Hold countdown: tick holdSecondsLeft down every second; auto-clear when expired.
  React.useEffect(() => {
    if (!ENABLE_HARDWARE_HOLD) {
      setHoldSecondsLeft(0);
      return;
    }
    if (hardwareHoldUntilMs <= 0) {
      setHoldSecondsLeft(0);
      return;
    }
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((hardwareHoldUntilMs - Date.now()) / 1000));
      setHoldSecondsLeft(remaining);
      if (remaining <= 0) {
        setHardwareHoldUntilMs(0);
        try {
          localStorage.removeItem(HW_HOLD_STORAGE_KEY);
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [hardwareHoldUntilMs]);

  // Safety net: if a hold is active while mining is true, force-stop mining and load.
  React.useEffect(() => {
    if (!isHardwareOnHold || !mining) return;
    let cancelled = false;

    (async () => {
      setMining(false);
      setRealMineStatus('Mining stopped: hardware on hold');
      try {
        if (window.wattcoinHardware && window.wattcoinHardware.stopHardwareLoad) {
          await window.wattcoinHardware.stopHardwareLoad();
        } else if (window.wattcoinHardware && window.wattcoinHardware.setHardwareLoad) {
          await window.wattcoinHardware.setHardwareLoad(0);
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }
      if (!cancelled) {
        setLog((log) => [
          {
            time: now(),
            msg: 'Mining auto-stopped because hardware is currently on hold.',
            type: 'warn',
          },
          ...log,
        ]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isHardwareOnHold, mining, setMining, setLog, now]);

  // Poll peer count every 10 seconds while the dashboard is active.
  React.useEffect(() => {
    if (!isActive) return;
    const hw = window.wattcoinHardware;
    if (!hw || !hw.getPeerCount) return;
    let cancelled = false;
    const fetch = async () => {
      try {
        const res = await hw.getPeerCount();
        if (!cancelled && res && res.ok) {
          setPeerCount(res.onlineCount ?? res.count ?? null);
          setConnectedPeerCount(Number(res.connectedCount ?? res.activeCount ?? res.tunnelCount) || 0);
          setPeerCountSource(res.source || null);
          setPeerDiscoveryInfo({
            configuredPeers: Number(res.configuredPeers) || 0,
            seedPeers: Number(res.seedPeers) || 0,
            discoveredPeers: Number(res.discoveredPeers) || 0,
          });
          setLastSyncInfo({
            trigger: String(res.lastSyncTrigger || ''),
            ok: Boolean(res.lastSyncOk),
          });
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }
    };
    fetch();
    const id = setInterval(fetch, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isActive]);

  // Pause mining when the 5‑second peer poll reports 0 online peers.
  // Without this the tick loop's round‑summary path can spin indefinitely
  // (setting timeout → tick → setting timeout …) without ever calling
  // mineOneRealBlock, which is the only other code path that sets
  // peerDownRef.current = true.
  React.useEffect(() => {
    if (peerCount === 0) {
      peerDownRef.current = true;
      setPeerDownToggle((t) => t + 1);
    }
  }, [peerCount]);

  // Restart mining when a peer reconnects after all peers were offline.
  React.useEffect(() => {
    if (!isActive) return;
    if (peerDownRef.current && peerCount > 0) {
      peerDownRef.current = false;
      setRealMineStatus('Mining started...');
      setPeerDownToggle((t) => t + 1);
    }
  }, [isActive, peerCount]);

  // Poll wallet/chain readiness every 10 seconds while the dashboard is active.
  React.useEffect(() => {
    if (!isActive) return;
    const hw = window.wattcoinHardware;
    if (!hw || !hw.invoke) return;
    let cancelled = false;
    const fetchReadiness = async () => {
      try {
        const res = await hw.invoke('wattcoin-get-wallet-readiness');
        if (!cancelled && res) setChainReadiness(res);
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }
    };
    fetchReadiness();
    const id = setInterval(fetchReadiness, 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isActive]);

  React.useEffect(() => {
    if (!isActive) return;
    const hw = window.wattcoinHardware;
    if (!hw || !hw.invoke) return;
    let cancelled = false;
    const fetchRoundSummary = async () => {
      try {
        const res = await hw.invoke('wattcoin-ledger-get-round-summary');
        if (!cancelled && res && res.ok) {
          setSharedRoundTotalWh(Math.max(0, Number(res.totalWh) || 0));
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }
    };
    fetchRoundSummary();
    const id = setInterval(fetchRoundSummary, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isActive]);

  const hasConfiguredOrBundledPeerTargets = peerDiscoveryInfo.configuredPeers + peerDiscoveryInfo.seedPeers > 0;
  const hasAnyKnownPeerTargets = hasConfiguredOrBundledPeerTargets || peerDiscoveryInfo.discoveredPeers > 0;
  const peerCountZeroLabel = !hasConfiguredOrBundledPeerTargets
    ? '0 • no bundled public seeds configured'
    : !hasAnyKnownPeerTargets
      ? '0 • no peers known yet'
      : '0 • known peers unreachable';
  const readinessZeroLabel = !hasConfiguredOrBundledPeerTargets
    ? `Block height ${chainReadiness.blocks || 0} • Peers 0 • No bundled public seeds configured`
    : !hasAnyKnownPeerTargets
      ? `Block height ${chainReadiness.blocks || 0} • Peers 0 • Looking for peers...`
      : `Block height ${chainReadiness.blocks || 0} • Peers 0 • Known peers unreachable`;
  const lastSyncLabel = lastSyncInfo.trigger ? lastSyncInfo.trigger.replace(/^event:/, '').replace(/,/g, ', ') : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, width: '100%' }}>
      {hardwareUnknown && (
        <div
          style={{
            background: '#1e1b4b',
            border: '1px solid #6366f1',
            borderRadius: 8,
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            color: '#c7d2fe',
            fontSize: 13,
            fontWeight: 600,
            marginBottom: 16,
          }}
        >
          <span style={{ fontSize: 16 }}>⚠</span>
          <span>
            Hardware not recognized — mining is unavailable. Please contact{' '}
            <a href="mailto:info@wattcoin.ee" style={{ color: '#a5b4fc', textDecoration: 'underline' }}>
              info@wattcoin.ee
            </a>{' '}
            to have your hardware added.
          </span>
        </div>
      )}
      {isHardwareOnHold && (
        <div
          style={{
            background: '#7f1d1d',
            border: '1px solid #ef4444',
            borderRadius: 8,
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            color: '#fecaca',
            fontSize: 13,
            fontWeight: 600,
            marginBottom: 16,
          }}
        >
          <span style={{ fontSize: 16 }}>⚠</span>
          <span>
            Hardware on hold — consecutive benchmark drift detected. Mining and energy accounting paused. Resumes in{' '}
            {Math.floor(holdSecondsLeft / 60)}:{String(holdSecondsLeft % 60).padStart(2, '0')}
          </span>
        </div>
      )}
      {firewallBlocked && (
        <div
          style={{
            background: '#7f1d1d',
            border: '1px solid #ef4444',
            borderRadius: 8,
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            color: '#fecaca',
            fontSize: 13,
            fontWeight: 600,
            marginBottom: 16,
          }}
        >
          <span style={{ fontSize: 16 }}>⚠</span>
          <span>
            No Windows Firewall rule was created during install — peer attestation cannot receive inbound connections.
            Mining is disabled.
          </span>
          {typeof onHealFirewall === 'function' && (
            <button
              onClick={onHealFirewall}
              disabled={firewallHealing}
              style={{
                marginLeft: 'auto',
                background: firewallHealing ? '#881337' : '#dc2626',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                padding: '6px 14px',
                cursor: firewallHealing ? 'not-allowed' : 'pointer',
                fontWeight: 600,
                fontSize: 12,
                whiteSpace: 'nowrap',
                opacity: firewallHealing ? 0.6 : 1,
              }}
            >
              {firewallHealing ? 'Fixing...' : 'Fix Firewall'}
            </button>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'row', gap: 32, alignItems: 'stretch', width: '100%' }}>
        {/* Left column: Hardware recognition */}
        <div
          ref={hwCardRef}
          style={{
            flex: '0 0 auto',
            width: savedHwCardWidth ? `${savedHwCardWidth}px` : 'max-content',
            minWidth: `${HARDWARE_COLUMN_WIDTH_PX}px`,
            maxWidth: '380px',
            boxSizing: 'border-box',
            background: '#0d1a0d',
            border: '1px solid #1e3a1e',
            borderRadius: 12,
            padding: '32px 24px',
            minHeight: `${HARDWARE_CARD_HEIGHT_PX}px`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
          }}
        >
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 15, color: '#4ade80', marginBottom: 12 }}>
            Hardware Recognition
          </div>
          <div style={{ color: '#e8f5e8', fontSize: 15, marginBottom: 8 }}>
            <b>Device Type:</b> {hardware.deviceType || 'Unknown'}
          </div>
          <div style={{ color: '#e8f5e8', fontSize: 15, marginBottom: 8 }}>
            <b>Manufacturer:</b> {hardware.manufacturer || 'Unknown'}
          </div>
          <div style={{ color: '#e8f5e8', fontSize: 15, marginBottom: 8 }}>
            <b>Version:</b> {hardware.version || 'Unknown'}
          </div>
          <div style={{ color: '#e8f5e8', fontSize: 15, marginBottom: 8 }}>
            <b>CPU:</b> {hardware.cpu || 'Unknown'}
          </div>
          <div style={{ color: '#e8f5e8', fontSize: 15, marginBottom: 8 }}>
            <b>GPU{allGpuModels.length > 1 ? `s (${allGpuModels.length})` : ''}:</b>{' '}
            {allGpuModels.length === 0
              ? 'Unknown'
              : (() => {
                  const details =
                    Array.isArray(hardware.gpuDetailsList) && hardware.gpuDetailsList.length > 0
                      ? hardware.gpuDetailsList
                      : allGpuModels.map((m) => ({ model: m, vramGb: 0, memType: '' }));
                  const fmt = (d) => {
                    let s = d.model;
                    let vramGb = d.vramGb;
                    let memType = d.memType;
                    // Fallback to static lookup table when systeminformation didn't populate these
                    if (!vramGb || !memType) {
                      const info = getGpuVramInfo(d.model);
                      if (!vramGb && info.vramGb) vramGb = info.vramGb;
                      if (!memType && info.memType) memType = info.memType;
                    }
                    if (vramGb > 0) s += ` ${vramGb} GB`;
                    if (memType) s += ` ${memType}`;
                    return s;
                  };
                  return details.length === 1
                    ? fmt(details[0])
                    : details.map((d, i) => (
                        <span key={i} style={{ display: 'block', paddingLeft: 8 }}>
                          {i + 1}. {fmt(d)}
                        </span>
                      ));
                })()}
          </div>
          <div style={{ color: '#e8f5e8', fontSize: 15, marginBottom: 8 }}>
            <b>Memory:</b> {hardware.memory || 'Unknown'}
          </div>
          <div
            style={{
              color: '#e8f5e8',
              fontSize: 15,
              marginBottom: 8,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            <b>Operating System:</b> {hardware.osName || 'Unknown'}
          </div>
          <div style={{ color: '#4ade80', fontSize: 13, marginTop: 8, wordBreak: 'break-all' }}>
            <b>Hardware info:</b> {hardware.source || 'Unknown'}
          </div>
          <div
            style={{
              color: powerSourceAccent,
              fontSize: 13,
              marginTop: 4,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              width: '100%',
            }}
            title={powerSourceLabel}
          >
            <b>Power estimate:</b> {powerSourceLabel}
          </div>
          <div
            style={{
              color: '#6aaa6a',
              fontSize: 13,
              marginTop: 2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              width: '100%',
            }}
            title={hardwareCardPowerCalcBreakdown}
          >
            <b>Power calculation:</b> {hardwareCardPowerCalcBreakdown}
          </div>
          <div style={{ marginTop: 8, borderTop: '1px solid #1e3a1e', paddingTop: 8 }}>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 15, color: '#4ade80', marginBottom: 12 }}>
              ASIC Recognition
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
              <button
                onClick={async () => {
                  setAsicConfigStatus('Scanning...');
                  setScanning(true);
                  try {
                    const res = await window.wattcoinHardware.scanAsicNetwork();
                    if (res.ok) {
                      const asics = res.asics || [];
                      if (asics.length > 0) {
                        const config = asics.map((a) => ({
                          ip: a.ip,
                          apiPort: a.port || 4028,
                          stratumPort: 3333,
                          driverName: a.driverName || '',
                          driverConfig: a.driverConfig || null,
                        }));
                        await window.wattcoinHardware.setAsicConfig(config);
                        setDiscoveredAsics(asics);
                        setAsicConfigStatus(`Scan complete: ${asics.length} ASIC(s) configured`);
                      } else {
                        setDiscoveredAsics([]);
                        await window.wattcoinHardware.setAsicConfig([]);
                        setAsicConfigStatus('Scan complete: no ASICs found');
                      }
                    } else {
                      setAsicConfigStatus('Scan failed');
                    }
                  } catch (err) {
                    setAsicConfigStatus(`Scan error: ${String(err.message || err).slice(0, 80)}`);
                  }
                  setScanning(false);
                }}
                disabled={scanning}
                style={{
                  background: '#1e3a1e',
                  color: '#4ade80',
                  border: '1px solid #2a5a2a',
                  borderRadius: 4,
                  padding: '4px 10px',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                {scanning ? 'Scanning...' : 'Scan Network'}
              </button>
            </div>
            {discoveredAsics.length > 0 && (
              <div style={{ marginBottom: 6 }}>
                {discoveredAsics.map((asic) => (
                  <div
                    key={asic.ip}
                    style={{
                      background: '#0f2a0f',
                      border: '1px solid #1e3a1e',
                      borderRadius: 4,
                      padding: '6px 8px',
                      marginBottom: 4,
                      fontSize: 11,
                      color: '#e8f5e8',
                    }}
                  >
                    <div>
                      <b>{asic.model}</b> @ {asic.ip}:{asic.port}
                    </div>
                    {asic.hashrateTHs > 0 && (
                      <div style={{ color: '#6aaa6a', marginTop: 2 }}>Hashrate: {asic.hashrateTHs.toFixed(3)} TH/s</div>
                    )}
                    {asic.telemetry && (asic.telemetry.tempInlet > 0 || asic.telemetry.fanSpeedRpm > 0) && (
                      <div style={{ color: '#888', marginTop: 1 }}>
                        {asic.telemetry.tempInlet > 0 &&
                          `${asic.telemetry.tempInlet}-${asic.telemetry.tempOutlet || '?'}-${asic.telemetry.tempChip || '?'} C`}
                        {asic.telemetry.fanSpeedRpm > 0 && ` | Fan: ${asic.telemetry.fanSpeedRpm} RPM`}
                        {asic.telemetry.chipCount > 0 && ` | Chips: ${asic.telemetry.chipCount}`}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {asicConfigStatus && <div style={{ color: '#facc15', fontSize: 11, marginTop: 4 }}>{asicConfigStatus}</div>}
            {asicLiveness.length > 0 && (
              <div style={{ marginTop: 6, borderTop: '1px solid #1e3a1e', paddingTop: 4 }}>
                <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: '#4ade80', marginBottom: 4 }}>
                  Live status
                </div>
                {asicLiveness.map((a) => (
                  <div
                    key={`${a.ip}:${a.port}`}
                    style={{
                      fontSize: 10,
                      color: a.isActive ? '#4ade80' : '#ef4444',
                      marginBottom: 2,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    <span style={{ fontSize: 8 }}>{a.isActive ? '\u25CF' : '\u25CB'}</span>
                    {a.ip}:{a.port}
                    {a.isActive && a.totalShares > 0 && (
                      <span style={{ color: '#6aaa6a' }}>{a.totalShares} shares</span>
                    )}
                    {!a.isActive && <span style={{ color: '#ef4444' }}>idle</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{ marginTop: 'auto', width: '100%', borderTop: '1px solid #1e3a1e', paddingTop: 10 }}>
            <div
              style={{ color: benchmarkState.running || startupBenchmarkPending ? '#facc15' : '#4ade80', fontSize: 12 }}
            >
              <b>Benchmark score:</b>{' '}
              {benchmarkState.running || startupBenchmarkPending
                ? 'running...'
                : benchmarkState.lastScore === null
                  ? clampedLoadPercent === 0
                    ? 'Set hardware load'
                    : 'pending'
                  : `${benchmarkState.lastScore}/100`}
            </div>
            {!benchmarkState.running &&
              !startupBenchmarkPending &&
              benchmarkState.lastScore !== null &&
              (benchmarkState.lastJitterPct !== null ||
                benchmarkState.lastAvgCpuPct !== null ||
                benchmarkState.lastAvgMemPct !== null ||
                benchmarkState.lastAvgGpuPct !== null) && (
                <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                  {benchmarkState.lastJitterPct !== null && (
                    <div
                      style={{
                        fontSize: 11,
                        color:
                          benchmarkState.lastJitterPct <= 10
                            ? '#4ade80'
                            : benchmarkState.lastJitterPct <= 20
                              ? '#facc15'
                              : '#f97316',
                      }}
                    >
                      {(() => {
                        const j = benchmarkState.lastJitterPct;
                        const label = j <= 10 ? 'Low' : j <= 20 ? 'Moderate' : 'High';
                        return (
                          <span>
                            <b>Jitter:</b> {label}
                          </span>
                        );
                      })()}
                    </div>
                  )}
                  {(benchmarkState.lastAvgCpuPct !== null ||
                    benchmarkState.lastAvgMemPct !== null ||
                    benchmarkState.lastAvgGpuPct !== null) &&
                    (benchmarkState.lastWasBaseline ? (
                      <div style={{ fontSize: 11, color: '#6b7280' }}>
                        {(() => {
                          const p = benchmarkState.cpuPenaltyPct;
                          const label =
                            p < 0 ? 'Baseline' : p <= 10 ? 'Good' : p <= 20 ? 'Normal' : p <= 30 ? 'Poor' : 'Degraded';
                          const clr =
                            label === 'Good'
                              ? '#a7ffb0'
                              : label === 'Normal'
                                ? '#facc15'
                                : label === 'High'
                                  ? '#f97316'
                                  : label === 'Degraded'
                                    ? '#ef4444'
                                    : '#6b7280';
                          return <span style={{ color: clr, marginLeft: 0 }}>CPU: {label}</span>;
                        })()}
                        {(() => {
                          const p = benchmarkState.memPenaltyPct;
                          const label =
                            p < 0 ? 'Baseline' : p <= 10 ? 'Good' : p <= 20 ? 'Normal' : p <= 30 ? 'Poor' : 'Degraded';
                          const clr =
                            label === 'Good'
                              ? '#a7ffb0'
                              : label === 'Normal'
                                ? '#facc15'
                                : label === 'High'
                                  ? '#f97316'
                                  : label === 'Degraded'
                                    ? '#ef4444'
                                    : '#6b7280';
                          return <span style={{ color: clr, marginLeft: 8 }}>Mem: {label}</span>;
                        })()}
                        {benchmarkState.lastAvgGpuPct !== null &&
                          (() => {
                            const p = benchmarkState.gpuPenaltyPct;
                            const label =
                              p < 0
                                ? 'Baseline'
                                : p <= 10
                                  ? 'Good'
                                  : p <= 20
                                    ? 'Normal'
                                    : p <= 30
                                      ? 'Poor'
                                      : 'Degraded';
                            const clr =
                              label === 'Good'
                                ? '#a7ffb0'
                                : label === 'Normal'
                                  ? '#facc15'
                                  : label === 'High'
                                    ? '#f97316'
                                    : label === 'Degraded'
                                      ? '#ef4444'
                                      : '#6b7280';
                            return <span style={{ color: clr, marginLeft: 8 }}>GPU: {label}</span>;
                          })()}
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                        avg
                        {[
                          benchmarkState.lastAvgCpuPct !== null &&
                            (() => {
                              const v = benchmarkState.lastAvgCpuPct;
                              const c =
                                Math.abs(v) <= 10
                                  ? '#a7ffb0'
                                  : Math.abs(v) <= 25
                                    ? '#facc15'
                                    : v > 0
                                      ? '#4ade80'
                                      : '#f87171';
                              return (
                                <span key="cpu" style={{ color: c, marginLeft: 8 }}>
                                  CPU {v > 0 ? `+${v}` : v}%
                                </span>
                              );
                            })(),
                          benchmarkState.lastAvgMemPct !== null &&
                            (() => {
                              const v = benchmarkState.lastAvgMemPct;
                              const c =
                                Math.abs(v) <= 10
                                  ? '#a7ffb0'
                                  : Math.abs(v) <= 25
                                    ? '#facc15'
                                    : v > 0
                                      ? '#4ade80'
                                      : '#f87171';
                              return (
                                <span key="mem" style={{ color: c, marginLeft: 8 }}>
                                  Mem {v > 0 ? `+${v}` : v}%
                                </span>
                              );
                            })(),
                          benchmarkState.lastAvgGpuPct !== null &&
                            (() => {
                              const v = benchmarkState.lastAvgGpuPct;
                              const c =
                                Math.abs(v) <= 10
                                  ? '#a7ffb0'
                                  : Math.abs(v) <= 25
                                    ? '#facc15'
                                    : v > 0
                                      ? '#4ade80'
                                      : '#f87171';
                              return (
                                <span key="gpu" style={{ color: c, marginLeft: 8 }}>
                                  GPU {v > 0 ? `+${v}` : v}%
                                </span>
                              );
                            })(),
                        ].filter(Boolean)}
                      </div>
                    ))}
                </div>
              )}
            {!benchmarkState.running && !startupBenchmarkPending && benchmarkState.lastScore !== null && (
              <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                {benchmarkState.lastTrustDelta !== null && (
                  <div
                    style={{
                      fontSize: 11,
                      color:
                        benchmarkState.lastTrustDelta > 0
                          ? '#4ade80'
                          : benchmarkState.lastTrustDelta < 0
                            ? '#f87171'
                            : '#a7ffb0',
                    }}
                  >
                    <b>Trust:</b>{' '}
                    {benchmarkState.lastTrustDelta > 0
                      ? `+${benchmarkState.lastTrustDelta}`
                      : benchmarkState.lastTrustDelta < 0
                        ? `${benchmarkState.lastTrustDelta}`
                        : 'no change'}
                    {benchmarkState.lastTrustChangeTime && (
                      <span style={{ color: '#64748b', marginLeft: 6 }}>{benchmarkState.lastTrustChangeTime}</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* Hidden canvas for continuous GPU load during mining — 2048×2048 so
              modern discrete GPUs register measurable utilisation */}
          <canvas
            ref={gpuLoadCanvasRef}
            width={2048}
            height={2048}
            style={{ position: 'fixed', left: '-9999px', top: '-9999px', width: 1, height: 1, pointerEvents: 'none' }}
            aria-hidden="true"
          />
        </div>

        {/* Right top area: mining status + metric cards */}
        <div style={{ flex: '2 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div
            style={{
              background: '#0d1a0d',
              border: '1px solid #1e3a1e',
              borderRadius: 12,
              padding: '16px 18px',
              height: `${STATUS_CARD_HEIGHT_PX}px`,
              boxSizing: 'border-box',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 10,
                gap: 10,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div
                  style={{
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 11,
                    color: '#4ade80',
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                  }}
                >
                  Mining Status
                </div>
                {electricityPrice !== null && (
                  <div
                    title={
                      electricityPriceSource === 'live'
                        ? 'Live global average — globalpetrolprices.com'
                        : electricityPriceSource === 'cache'
                          ? 'Cached (updates every 24 h)'
                          : 'Estimated global average (live fetch unavailable)'
                    }
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      background: '#0a1f0a',
                      border: '1px solid #1e3a1e',
                      borderRadius: 6,
                      padding: '2px 7px',
                      cursor: 'default',
                    }}
                  >
                    <span style={{ fontSize: 10, color: electricityPriceSource === 'live' ? '#4ade80' : '#6b9b6b' }}>
                      ⚡
                    </span>
                    <span
                      style={{
                        fontFamily: "'DM Mono', monospace",
                        fontSize: 10,
                        color: '#a7ffb0',
                        letterSpacing: '0.03em',
                      }}
                    >
                      ${electricityPrice.toFixed(3)}
                      <span style={{ color: '#4a6a4a' }}>/kWh</span>
                    </span>
                    <span
                      style={{
                        fontSize: 8,
                        color: electricityPriceSource === 'live' ? '#4ade80' : '#4a6a4a',
                        marginLeft: 1,
                      }}
                    >
                      {electricityPriceSource === 'live' ? '●' : '○'}
                    </span>
                  </div>
                )}
                {electricityPrice !== null &&
                  (() => {
                    const wtcCostUsd = (electricityPrice * energyForTier(statusTier)) / 1000;
                    const fmt =
                      wtcCostUsd >= 1000
                        ? `$${(wtcCostUsd / 1000).toFixed(2)}k`
                        : wtcCostUsd >= 1
                          ? `$${wtcCostUsd.toFixed(2)}`
                          : wtcCostUsd >= 0.001
                            ? `$${wtcCostUsd.toFixed(4)}`
                            : `$${wtcCostUsd.toExponential(2)}`;
                    return (
                      <div
                        title={`Mining cost per WTC at current electricity price and Tier ${statusTier} energy requirement (${energyForTier(statusTier).toLocaleString()} Wh/coin × $${electricityPrice.toFixed(3)}/kWh)`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          background: '#0a1f0a',
                          border: '1px solid #1e3a1e',
                          borderRadius: 6,
                          padding: '2px 7px',
                          cursor: 'default',
                        }}
                      >
                        <span
                          style={{
                            fontFamily: "'DM Mono', monospace",
                            fontSize: 10,
                            color: '#4ade80',
                            letterSpacing: '0.05em',
                            fontWeight: 600,
                          }}
                        >
                          WTC
                        </span>
                        <span
                          style={{
                            fontFamily: "'DM Mono', monospace",
                            fontSize: 10,
                            color: '#a7ffb0',
                            letterSpacing: '0.03em',
                          }}
                        >
                          {fmt}
                        </span>
                      </div>
                    );
                  })()}
                <div
                  title="Total pooled energy contributed by all miners in the current shared round."
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    background: '#0a1f0a',
                    border: '1px solid #1e3a1e',
                    borderRadius: 6,
                    padding: '2px 7px',
                    cursor: 'default',
                  }}
                >
                  <span style={{ fontSize: 10, color: '#4ade80' }}>Σ</span>
                  <span
                    style={{
                      fontFamily: "'DM Mono', monospace",
                      fontSize: 10,
                      color: '#a7ffb0',
                      letterSpacing: '0.03em',
                    }}
                  >
                    {fmtEnergy(sharedRoundTotalWh, sharedRoundTotalWh >= 1000 ? 2 : 0)}
                  </span>
                  <span
                    style={{
                      fontFamily: "'DM Mono', monospace",
                      fontSize: 9,
                      color: '#4a6a4a',
                      letterSpacing: '0.05em',
                      textTransform: 'uppercase',
                    }}
                  >
                    round
                  </span>
                </div>
              </div>
              <div
                style={{ fontSize: 12, color: '#a7ffb0' }}
              >{`Tier ${statusTier} active · ${fmtEnergy(energyForTier(statusTier), 0)}/coin`}</div>
            </div>
            <div
              style={{
                height: 10,
                width: '100%',
                borderRadius: 999,
                background: '#122612',
                overflow: 'hidden',
                border: '1px solid #1e3a1e',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${minedPct}%`,
                  background: 'linear-gradient(90deg, #4ade80, #22c55e)',
                  transition: 'width 0.25s linear',
                }}
              />
            </div>
            <div style={{ marginTop: 8, display: 'flex', flex: 1, gap: 0 }}>
              {/* Left half: mined progress + mining address + peers */}
              <div
                style={{
                  flex: 1,
                  paddingRight: 14,
                  borderRight: '1px solid #1e3a1e',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  gap: 6,
                }}
              >
                <div style={{ fontSize: 12, color: '#4a6a4a' }}>
                  {`${fmtNum(chainEmittedCoins, 4)} WTC / ${fmtNum(totalCoinSupply)} WTC node mined (${minedPct.toFixed(4)}%)`}
                </div>
                <div style={{ fontSize: 12, color: '#a7ffb0', wordBreak: 'break-all' }}>
                  <b>Mining Address:</b> {miningAddress || 'Loading...'}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color:
                      peerCountSource === 'standalone'
                        ? '#4a6a4a'
                        : peerCount === null
                          ? '#4a6a4a'
                          : peerCount === 0
                            ? '#f87171'
                            : '#a7ffb0',
                  }}
                >
                  {peerCountSource === 'standalone' ? (
                    <>
                      <b>Peers online:</b> — standalone mode <span style={{ color: '#4a6a4a' }}>•</span>{' '}
                      <b>Peers connected:</b> —
                    </>
                  ) : peerCount === null ? (
                    <>
                      <b>Peers online:</b> — waiting... <span style={{ color: '#4a6a4a' }}>•</span>{' '}
                      <b>Peers connected:</b> —
                    </>
                  ) : peerCount === 0 ? (
                    <>
                      <b>Peers online:</b> {peerCountZeroLabel} <span style={{ color: '#4a6a4a' }}>•</span>{' '}
                      <b>Peers connected:</b> {connectedPeerCount}
                    </>
                  ) : (
                    <>
                      <b>Peers online:</b> {peerCount} <span style={{ color: '#4a6a4a' }}>•</span>{' '}
                      <b>Peers connected:</b> {connectedPeerCount}
                    </>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: chainReadiness.spendReady
                      ? '#4ade80'
                      : chainReadiness.connections === 0
                        ? '#f87171'
                        : '#fbbf24',
                  }}
                >
                  {chainReadiness.spendReady
                    ? 'Wallet Ready'
                    : chainReadiness.connections === 0
                      ? 'Connecting to Network'
                      : chainReadiness.reachableButNotAhead
                        ? 'Peers Reachable, No Higher Chain'
                        : 'Wallet Syncing'}
                  {' • '}
                  {chainReadiness.connections === 0
                    ? readinessZeroLabel
                    : chainReadiness.reachableButNotAhead
                      ? `Local height ${chainReadiness.localBlocks || 0} • Reachable peers ${chainReadiness.connections} • No higher sync source yet`
                      : `Block height ${chainReadiness.blocks || 0} • Peers ${chainReadiness.connections}`}
                </div>
                {!chainReadiness.spendReady && chainReadiness.syncBlockedReason && (
                  <div style={{ fontSize: 11, color: '#f87171' }}>
                    <b>Sync blocked:</b> {chainReadiness.syncBlockedReason}
                  </div>
                )}
                {lastSyncLabel && (
                  <div style={{ fontSize: 11, color: lastSyncInfo.ok ? '#4ade80' : '#fbbf24' }}>
                    <b>Last sync:</b> {lastSyncInfo.ok ? 'synced via ' : 'triggered by '}
                    {lastSyncLabel}
                  </div>
                )}
              </div>
              {/* Right: trust meter */}
              <div
                style={{
                  flex: 1,
                  paddingLeft: 14,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  gap: 6,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div
                    style={{
                      fontFamily: "'DM Mono', monospace",
                      fontSize: 10,
                      color: '#4ade80',
                      letterSpacing: '0.1em',
                      textTransform: 'uppercase',
                    }}
                  >
                    Trust Score
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: trustScore >= 70 ? '#4ade80' : trustScore >= 30 ? '#facc15' : '#f87171',
                    }}
                  >
                    {trustScore}/100
                  </div>
                </div>
                <div
                  style={{
                    height: 8,
                    width: '100%',
                    borderRadius: 999,
                    background: '#122612',
                    overflow: 'hidden',
                    border: '1px solid #1e3a1e',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${trustScore}%`,
                      background:
                        trustScore >= 70
                          ? 'linear-gradient(90deg, #4ade80, #22c55e)'
                          : trustScore >= 30
                            ? 'linear-gradient(90deg, #facc15, #eab308)'
                            : 'linear-gradient(90deg, #f87171, #ef4444)',
                      transition: 'width 0.5s ease',
                    }}
                  />
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'row', gap: 16, width: '100%', alignItems: 'stretch' }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <div
                style={{
                  background: '#0d1a0d',
                  border: '1px solid #1e3a1e',
                  borderRadius: 12,
                  padding: '20px 24px',
                  height: `${METRIC_CARD_HEIGHT_PX}px`,
                  boxSizing: 'border-box',
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                }}
              >
                <div
                  style={{
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 11,
                    color: '#4ade80',
                    letterSpacing: '0.1em',
                    marginBottom: 8,
                    textTransform: 'uppercase',
                  }}
                >
                  Power Used
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ color: '#a7ffb0', fontSize: 12 }}>Max hardware power</div>
                  <div
                    style={{
                      fontFamily: "'Playfair Display', serif",
                      fontSize: 24,
                      fontWeight: 700,
                      color: '#e8f5e8',
                      lineHeight: 1.1,
                    }}
                  >
                    {fmtNum(unitFullPowerW, 2)} W
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: trustScore >= 75 ? '#4ade80' : trustScore >= 50 ? '#facc15' : '#f87171',
                      marginTop: -4,
                    }}
                  >
                    {`Trust cap: ${Math.round(trustFactor * 100)}% → ${fmtNum(basePowerW, 0)} W  (trust ${trustScore}/100)`}
                  </div>
                  <div style={{ color: '#a7ffb0', fontSize: 12 }}>Mining power</div>
                  <div
                    style={{
                      fontFamily: "'Playfair Display', serif",
                      fontSize: 24,
                      fontWeight: 700,
                      color: '#e8f5e8',
                      lineHeight: 1.1,
                    }}
                  >
                    {fmtNum(totalPowerUsedW, 2)} W
                  </div>
                </div>
                <div style={{ marginTop: 10, borderTop: '1px solid #1e3a1e', paddingTop: 8 }}>
                  <div
                    style={{ fontSize: 12, color: '#a7ffb0', marginTop: 4 }}
                  >{`Base power ${fmtNum(basePowerW, 1)} W -> active mining power ${fmtNum(powerW, 1)} W`}</div>
                  <div
                    style={{ fontSize: 11, color: powerSourceAccent, marginTop: 4 }}
                  >{`Source: ${powerSourceLabel}`}</div>
                </div>
              </div>
            </div>
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                height: `${METRIC_CARD_HEIGHT_PX}px`,
                boxSizing: 'border-box',
              }}
            >
              {/* Energy Used — compact, auto height */}
              <div
                style={{
                  background: '#0d1a0d',
                  border: '1px solid #1e3a1e',
                  borderRadius: 12,
                  padding: '14px 20px',
                  flex: '0 0 auto',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                }}
              >
                <div
                  style={{
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 11,
                    color: '#4ade80',
                    letterSpacing: '0.1em',
                    marginBottom: 6,
                    textTransform: 'uppercase',
                  }}
                >
                  Energy Used
                </div>
                <div
                  style={{
                    fontFamily: "'Playfair Display', serif",
                    fontSize: 26,
                    fontWeight: 700,
                    color: '#e8f5e8',
                    lineHeight: 1.1,
                  }}
                >
                  {fmtEnergy(energy, 2)}
                </div>
                <div style={{ fontSize: 11, color: '#4a6a4a', marginTop: 5 }}>
                  {energy >= 1e3
                    ? `${fmtNum(energy, 0)} Wh total (${fmtEnergy(energy, 3)})`
                    : 'power × time integrated — upgrades to kWh at 1,000 Wh'}
                </div>
              </div>
              {/* Hardware Load — fills remaining height */}
              <div
                style={{
                  background: '#0d1a0d',
                  border: '1px solid #1e3a1e',
                  borderRadius: 12,
                  padding: '14px 20px',
                  flex: 1,
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 8,
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      fontFamily: "'DM Mono', monospace",
                      fontSize: 11,
                      color: '#4ade80',
                      letterSpacing: '0.1em',
                      textTransform: 'uppercase',
                    }}
                  >
                    Hardware Load
                  </div>
                  <div style={{ color: '#e8f5e8', fontSize: 15, fontWeight: 700 }}>
                    {effectiveLoadPercent}%
                    <span style={{ fontSize: 11, color: '#fbbf24', marginLeft: 6 }}>
                      (trust cap: {Math.round(trustFactor * 100)}%)
                    </span>
                  </div>
                </div>
                <input
                  type="range"
                  min="0"
                  max={String(MAX_HARDWARE_LOAD_PERCENT)}
                  step="1"
                  value={clampedLoadPercent}
                  onChange={(event) => {
                    setLoadPercent(Number(event.target.value));
                  }}
                  onMouseUp={() => {
                    const nowMs = Date.now();
                    if (nowMs - lastSliderCommitAtMsRef.current < 100) return;
                    lastSliderCommitAtMsRef.current = nowMs;
                    setSliderAdjustNonce((n) => n + 1);
                  }}
                  onTouchEnd={() => {
                    const nowMs = Date.now();
                    if (nowMs - lastSliderCommitAtMsRef.current < 100) return;
                    lastSliderCommitAtMsRef.current = nowMs;
                    setSliderAdjustNonce((n) => n + 1);
                  }}
                  onKeyUp={() => {
                    const nowMs = Date.now();
                    if (nowMs - lastSliderCommitAtMsRef.current < 100) return;
                    lastSliderCommitAtMsRef.current = nowMs;
                    setSliderAdjustNonce((n) => n + 1);
                  }}
                  // onBlur intentionally omitted: tab-switch would trigger it and
                  // cause a redundant slider-stop benchmark after adjusting the slider.
                  style={{ width: '100%', accentColor: '#4ade80', cursor: 'pointer' }}
                />
                <div
                  style={{ fontSize: 11, color: '#4a6a4a', marginTop: 6 }}
                >{`Applies ${effectiveLoadPercent}% of hardware power. Trust cap: ${Math.round(trustFactor * 100)}%.`}</div>
                <div
                  style={{ fontSize: 11, color: '#4a6a4a', marginTop: 3 }}
                >{`Est. time for 1 coin: ${timePerCoinLabel}`}</div>
              </div>
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <div
                style={{
                  background: '#0d1a0d',
                  border: '1px solid #1e3a1e',
                  borderRadius: 12,
                  padding: '20px 24px',
                  height: `${METRIC_CARD_HEIGHT_PX}px`,
                  boxSizing: 'border-box',
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <div
                    style={{
                      fontFamily: "'DM Mono', monospace",
                      fontSize: 11,
                      color: '#4ade80',
                      letterSpacing: '0.1em',
                      marginBottom: 8,
                      textTransform: 'uppercase',
                    }}
                  >
                    Coins Mined
                  </div>
                  <div
                    style={{
                      fontFamily: "'Playfair Display', serif",
                      fontSize: 28,
                      fontWeight: 700,
                      color: '#e8f5e8',
                      lineHeight: 1.1,
                    }}
                  >{`${fmtNum(nodeTotal, 2)} WTC`}</div>
                  <div
                    style={{ fontSize: 12, color: '#4a6a4a', marginTop: 6 }}
                  >{`Tier ${currentTier} · ${fmtEnergy(tierEnergyPerCoinWh, 0)}/coin · ${fmtNum(rewardForTier(currentTier), 2)} WTC/block`}</div>
                  <div
                    style={{ fontSize: 12, color: '#4a6a4a', marginTop: 3 }}
                  >{`${fmtNum(nodeTotal % COINS_PER_TIER, 2)} / ${fmtNum(COINS_PER_TIER)} coins this tier · ${fmtNum(totalCoinSupply)} WTC total supply`}</div>
                </div>
                <div style={{ marginTop: 10, borderTop: '1px solid #1e3a1e', paddingTop: 8 }}>
                  <div
                    style={{ fontSize: 12, color: '#a7ffb0', marginTop: 6 }}
                  >{`Matured: ${fmtNum(displayMatured, 2)} WTC | Unmatured: ${fmtNum(displayUnmatured, 2)} WTC`}</div>
                  <div
                    style={{ fontSize: 12, color: '#4a6a4a', marginTop: 4 }}
                  >{`App energy estimate: ${fmtNum(appEstimatedCoins, 2)} WTC`}</div>
                  <div
                    style={{ fontSize: 12, color: '#a7ffb0', marginTop: 4 }}
                  >{`Estimated mining rate: ${coinsRateLabel}`}</div>
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'row', gap: 16, width: '100%', alignItems: 'stretch' }}>
            {showRebenchPrompt ? (
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  background: '#78350f',
                  borderRadius: 8,
                  padding: '8px 12px',
                  fontSize: 12,
                  color: '#fed7aa',
                  fontWeight: 600,
                }}
              >
                <span style={{ flex: 1, lineHeight: 1.3 }}>
                  Startup benchmark shows degraded performance
                  {[
                    benchmarkState.cpuPenaltyPct > 30 && `CPU ${benchmarkState.cpuPenaltyPct}%`,
                    benchmarkState.memPenaltyPct > 30 && `Mem ${benchmarkState.memPenaltyPct}%`,
                    benchmarkState.gpuPenaltyPct > 30 && `GPU ${benchmarkState.gpuPenaltyPct}%`,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  . Re-benchmark?
                </span>
              </div>
            ) : (
              <div style={{ flex: 1 }} />
            )}
            <div style={{ flex: 1 }}>
              <button
                onClick={() => {
                  if (rebenchRef.current) {
                    rebenchRef.current = false;
                    setShowRebenchPrompt(false);
                    runBenchmark('startup');
                  } else {
                    if (showRebenchPrompt) return;
                    setMining(true);
                  }
                }}
                disabled={
                  mining ||
                  hardwareUnknown ||
                  !hardwareRecognitionFinished ||
                  benchmarkState.running ||
                  startupBenchmarkPending ||
                  isHardwareOnHold ||
                  firewallBlocked ||
                  peerCount === null ||
                  peerCount === 0 ||
                  clampedLoadPercent === 0
                }
                style={{
                  width: '100%',
                  background:
                    mining ||
                    hardwareUnknown ||
                    !hardwareRecognitionFinished ||
                    benchmarkState.running ||
                    startupBenchmarkPending ||
                    isHardwareOnHold ||
                    firewallBlocked ||
                    peerCount === null ||
                    peerCount === 0 ||
                    clampedLoadPercent === 0
                      ? '#7aa88a'
                      : showRebenchPrompt
                        ? '#ea580c'
                        : '#4ade80',
                  color: showRebenchPrompt ? '#fff' : '#0d1a0d',
                  border: 'none',
                  borderRadius: 8,
                  padding: '12px 32px',
                  fontWeight: 700,
                  fontSize: 20,
                  cursor:
                    mining ||
                    hardwareUnknown ||
                    !hardwareRecognitionFinished ||
                    benchmarkState.running ||
                    startupBenchmarkPending ||
                    isHardwareOnHold ||
                    firewallBlocked ||
                    peerCount === null ||
                    peerCount === 0 ||
                    clampedLoadPercent === 0
                      ? 'not-allowed'
                      : 'pointer',
                }}
              >
                {hardwareUnknown
                  ? 'Hardware unknown'
                  : isHardwareOnHold
                    ? `On hold (${Math.floor(holdSecondsLeft / 60)}:${String(holdSecondsLeft % 60).padStart(2, '0')})`
                    : mining
                      ? 'Mining active'
                      : benchmarkState.running || startupBenchmarkPending
                        ? 'Benchmarking...'
                        : firewallBlocked
                          ? 'Firewall blocked'
                          : peerCount === null || peerCount === 0
                            ? 'No peers'
                            : showRebenchPrompt
                              ? 'Re-Benchmark'
                              : clampedLoadPercent === 0
                                ? 'Set hardware load'
                                : hardwareRecognitionFinished
                                  ? 'Start mining'
                                  : 'Detecting hardware...'}
              </button>
            </div>
            <div style={{ flex: 1 }}>
              <button
                onClick={async () => {
                  setMining(false);
                  try {
                    if (window.wattcoinHardware && window.wattcoinHardware.stopHardwareLoad) {
                      await window.wattcoinHardware.stopHardwareLoad();
                    } else if (window.wattcoinHardware && window.wattcoinHardware.setHardwareLoad) {
                      await window.wattcoinHardware.setHardwareLoad(0);
                    }
                  } catch (_) {
                    if (process.env.WATTCOIN_DEBUG)
                      console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
                  }
                }}
                disabled={!mining}
                style={{
                  width: '100%',
                  background: !mining ? '#8a7a7a' : '#ef4444',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: 8,
                  padding: '12px 32px',
                  fontWeight: 700,
                  fontSize: 20,
                  cursor: !mining ? 'not-allowed' : 'pointer',
                }}
              >
                Stop
              </button>
            </div>
          </div>
          {coins >= totalCoinSupply && (
            <div style={{ color: '#4ade80', fontFamily: "'DM Mono', monospace" }}>Total supply cap reached (21M).</div>
          )}
        </div>
      </div>
    </div>
  );
}

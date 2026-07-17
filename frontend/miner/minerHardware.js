export function detectMotherboardFormFactor(...values) {
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

export const LAPTOP_MODEL_VENDOR_PRIORITIES = [
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

export const DEFAULT_LAPTOP_MODEL_FIELD_SCORES = {
  systemModel: 130,
  systemSku: 95,
  baseboardModel: 70,
  baseboardVersion: 25,
  systemVersion: -150,
};

export const LAPTOP_COMMERCIAL_MODEL_HINTS =
  /ThinkPad|ThinkBook|IdeaPad|Yoga|Legion|LOQ|MacBook|XPS|Latitude|EliteBook|Spectre|Surface|Aspire|TravelMate|Swift|Nitro|Predator|Zenbook|Vivobook|ExpertBook|ProBook|Pavilion|Omen|MateBook|Gram|Galaxy Book/i;
export const DESKTOP_COMMERCIAL_MODEL_HINTS =
  /ThinkCentre|ThinkStation|ThinkServer|OptiPlex|Precision|ProDesk|EliteDesk|Z2|Z4|Z6|Z8|NUC|Mini PC|Workstation/i;
export const MINI_PC_COMMERCIAL_MODEL_HINTS =
  /ThinkCentre\s+(?:M\d{3,4}[a-z]?q|Tiny)|OptiPlex\s+(?:Micro|Ultra)|ProDesk\s+Mini|EliteDesk\s+Mini|EliteMini|Mini\s+PC|Mini-PC|NUC|NUCBox|BRIX|Cubi|DeskMini|Veriton\s+N|ExpertCenter\s+PN|Chromebox|TinyMiniMicro|USFF|\bMicro\b(?!-)|\bTiny\b|\bNano\b/i;
export const MINI_PC_VENDOR_HINTS =
  /Beelink|Minisforum|Geekom|GMKtec|Zotac|Shuttle|ASUS|MSI|Gigabyte|Acer|Dell|HP|Lenovo|Intel/i;
export const MINI_PC_MODEL_SERIES_HINTS =
  /\b(?:PN\d{2,4}|SER\d|UM\d|GK\d|GT\d|NUC\d*|NUCBox|BRIX|Cubi|DeskMini|Tiny|Micro|Mini|Nano|USFF|DM\d{2,4})\b/i;
export const INTEGRATED_GPU_MODEL_HINTS =
  /Intel.*(?:HD|UHD|Iris(?!\s*(?:Xe\s*Max|Pro))|Xe(?!\s*Max))|Radeon\(TM\)\s+Graphics|Radeon\s+Graphics|Vega\s*(?:3|5|6|7|8|10|11)|Mali|Adreno/i;
export const DISCRETE_GPU_MODEL_HINTS =
  /RTX|GTX|MX\d|Arc\s*(?:A|B)|Quadro|Tesla|Titan|GeForce|Radeon\s*(?:RX|Pro|VII)|FirePro/i;

export function isWholeDeviceMiniPc(hardware = {}) {
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

export function hasOnlyIntegratedGpu(hardware = {}) {
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

export function pickLaptopModelCandidate({
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

export function pickDesktopModelCandidate({
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
export async function getHardwareInfo() {
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
        memType,
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

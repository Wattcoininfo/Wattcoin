// hardware-tables.cjs
// Authoritative hardware expected-ops and expected-memory-bandwidth lookup tables.
// Required by electron-main.js (main process) so calibration calculations cannot be
// spoofed by patching the renderer bundle.  Keep in sync with Miner.jsx.

'use strict';

function getExpectedCpuSpeedOps(cpuModel) {
  if (!cpuModel) return 0;
  const m = cpuModel;

  // ── Intel 14th / 13th Gen Desktop (Raptor Lake / Refresh) ────────────────────
  if (/Core.*i9-1[34]900KS/i.test(m))        return 620_000_000;
  if (/Core.*i9-1[34]900KF?/i.test(m))        return 600_000_000;
  if (/Core.*i9-1[34]900[FT]?/i.test(m))      return 575_000_000;
  if (/Core.*i7-1[34]700KF?/i.test(m))         return 560_000_000;
  if (/Core.*i7-1[34]700[FT]?/i.test(m))       return 540_000_000;
  if (/Core.*i5-1[34]600KF?/i.test(m))         return 530_000_000;
  if (/Core.*i5-1[34][5-9]0{2}[FT]?/i.test(m)) return 510_000_000;
  if (/Core.*i5-1[34]400[FT]?/i.test(m))       return 480_000_000;
  if (/Core.*i3-1[34]1[0-9]0[FT]?/i.test(m))   return 460_000_000;
  if (/Core.*i3-133[0-9]0/i.test(m))           return 460_000_000;

  // ── Intel 12th Gen Desktop (Alder Lake P-core) ───────────────────────────────
  if (/Core.*i9-12900KS/i.test(m))             return 520_000_000;
  if (/Core.*i9-12900KF?/i.test(m))             return 500_000_000;
  if (/Core.*i9-12900[FT]?/i.test(m))           return 490_000_000;
  if (/Core.*i7-12700KF?/i.test(m))             return 490_000_000;
  if (/Core.*i7-12700[FT]?/i.test(m))           return 470_000_000;
  if (/Core.*i5-12600KF?/i.test(m))             return 470_000_000;
  if (/Core.*i5-12[56]0{2}[FT]?/i.test(m))      return 450_000_000;
  if (/Core.*i5-124[024]0[FT]?/i.test(m))       return 430_000_000;
  if (/Core.*i3-12[13][02][015][FT]?/i.test(m)) return 420_000_000;

  // ── Intel 11th Gen Desktop (Rocket Lake) ─────────────────────────────────────
  if (/Core.*i9-11900KF?/i.test(m))             return 490_000_000;
  if (/Core.*i9-11900[FT]?/i.test(m))           return 480_000_000;
  if (/Core.*i7-11700KF?/i.test(m))             return 480_000_000;
  if (/Core.*i7-11700[FT]?/i.test(m))           return 460_000_000;
  if (/Core.*i5-11[456][0-9]0[FKT]?[F]?/i.test(m)) return 440_000_000;

  // ── Intel 10th Gen Desktop (Comet Lake) ──────────────────────────────────────
  if (/Core.*i9-10900KF?S?/i.test(m))           return 470_000_000;
  if (/Core.*i9-10[89][0-9]0[FKST]?/i.test(m))  return 460_000_000;
  if (/Core.*i7-10700KF?/i.test(m))             return 450_000_000;
  if (/Core.*i7-10700[FT]?/i.test(m))           return 420_000_000;
  if (/Core.*i5-10[456][0-9]0[FKST]?/i.test(m)) return 400_000_000;
  if (/Core.*i3-10[1-9][0-9]0[FT]?/i.test(m))  return 390_000_000;

  // ── Intel 9th / 8th Gen Desktop (Coffee Lake / Refresh) ─────────────────────
  if (/Core.*i9-9900KF?S?/i.test(m))            return 430_000_000;
  if (/Core.*i9-9900[FT]?/i.test(m))            return 430_000_000;
  if (/Core.*i7-9700KF?/i.test(m))              return 420_000_000;
  if (/Core.*i7-9700[FT]?/i.test(m))            return 400_000_000;
  if (/Core.*i5-9[456][0-9]0[FKT]?/i.test(m))  return 380_000_000;
  if (/Core.*i3-9[1-9][0-9]0[FKT]?/i.test(m))  return 360_000_000;
  if (/Core.*i7-8700KF?/i.test(m))              return 400_000_000;
  if (/Core.*i7-8700[FT]?/i.test(m))            return 385_000_000;
  if (/Core.*i5-8[456][0-9]0[FKT]?/i.test(m))  return 360_000_000;
  if (/Core.*i3-8[1-4][0-9]0[FKT]?/i.test(m))  return 340_000_000;

  // ── Intel 7th Gen Desktop (Kaby Lake) ────────────────────────────────────────
  if (/Core.*i7-7700KF?/i.test(m))              return 375_000_000;
  if (/Core.*i7-7700[T]?/i.test(m))             return 350_000_000;
  if (/Core.*i5-7[456][0-9]0[KT]?/i.test(m))   return 335_000_000;
  if (/Core.*i3-73[0-9]0[KT]?/i.test(m))       return 330_000_000;
  if (/Core.*i3-71[0-9]0[T]?/i.test(m))        return 320_000_000;

  // ── Intel 6th Gen Desktop (Skylake) ──────────────────────────────────────────
  if (/Core.*i7-6700KF?/i.test(m))              return 340_000_000;
  if (/Core.*i7-6700[T]?/i.test(m))             return 320_000_000;
  if (/Core.*i5-6[456][0-9]0[KT]?/i.test(m))   return 310_000_000;
  if (/Core.*i3-6[1-3][0-9]0[T]?/i.test(m))    return 300_000_000;

  // ── Intel 5th Gen Desktop (Broadwell) ────────────────────────────────────────
  if (/Core.*i[57]-5[67][0-9]5C/i.test(m))     return 285_000_000;

  // ── Intel 4th Gen Desktop (Haswell) ──────────────────────────────────────────
  if (/Core.*i7-4790K/i.test(m))                return 330_000_000;
  if (/Core.*i7-47[0-9]0[T]?/i.test(m))         return 300_000_000;
  if (/Core.*i5-4[5-9][0-9]0[KT]?/i.test(m))   return 295_000_000;
  if (/Core.*i5-4[34][0-9]0[T]?/i.test(m))      return 270_000_000;
  if (/Core.*i3-4[1-4][0-9]0[T]?/i.test(m))    return 265_000_000;

  // ── Intel 3rd Gen Desktop (Ivy Bridge) ───────────────────────────────────────
  if (/Core.*i7-377[0-9]K?/i.test(m))           return 260_000_000;
  if (/Core.*i5-35[2-7]0[KT]?/i.test(m))        return 250_000_000;
  if (/Core.*i5-34[3-7]0[T]?/i.test(m))         return 240_000_000;
  if (/Core.*i3-3[1-3][0-9]0/i.test(m))         return 220_000_000;

  // ── Intel 2nd Gen Desktop (Sandy Bridge) ─────────────────────────────────────
  if (/Core.*i7-2[6-7]00K?/i.test(m))           return 240_000_000;
  if (/Core.*i7-2[5-9][0-9]0[S]?/i.test(m))     return 230_000_000;
  if (/Core.*i5-2[3-6][0-9]0K?/i.test(m))       return 220_000_000;
  if (/Core.*i3-2[1-3][0-9]0/i.test(m))         return 200_000_000;

  // ── Intel Core Ultra 200S (Arrow Lake Desktop) ───────────────────────────────
  if (/Core.*Ultra 9 2[0-9]{2}K/i.test(m))      return 560_000_000;
  if (/Core.*Ultra 7 2[0-9]{2}KF?/i.test(m))    return 540_000_000;
  if (/Core.*Ultra 5 2[0-9]{2}KF?/i.test(m))    return 510_000_000;

  // ── Intel Core Ultra 100H/U (Meteor Lake Mobile) ─────────────────────────────
  if (/Core.*Ultra 9 1[0-9]{2}H/i.test(m))      return 430_000_000;
  if (/Core.*Ultra 7 1[0-9]{2}H/i.test(m))      return 415_000_000;
  if (/Core.*Ultra 5 1[0-9]{2}H/i.test(m))      return 390_000_000;
  if (/Core.*Ultra [579] 1[0-9]{2}U/i.test(m))  return 350_000_000;

  // ── Intel 13th Gen Mobile (HX / H / U) ───────────────────────────────────────
  if (/Core.*i9-139[0-9]0HX/i.test(m))          return 520_000_000;
  if (/Core.*i9-139[0-9]0H/i.test(m))           return 490_000_000;
  if (/Core.*i7-137[0-9]0HX/i.test(m))          return 480_000_000;
  if (/Core.*i7-137[0-9]0H/i.test(m))           return 460_000_000;
  if (/Core.*i5-13[3-6][0-9]0H/i.test(m))       return 440_000_000;
  if (/Core.*i[37]-13[3-7][0-9]U/i.test(m))     return 420_000_000;
  if (/Core.*i[35]-13[1-5][0-9]U/i.test(m))     return 390_000_000;

  // ── Intel 12th Gen Mobile ─────────────────────────────────────────────────────
  if (/Core.*i9-129[0-9]0H[KX]?/i.test(m))      return 450_000_000;
  if (/Core.*i7-127[0-9]0H/i.test(m))           return 420_000_000;
  if (/Core.*i5-12[45][0-9]0H/i.test(m))        return 400_000_000;
  if (/Core.*i7-12[78][0-9]P/i.test(m))         return 390_000_000;
  if (/Core.*i[35]-12[34][0-9]P/i.test(m))      return 360_000_000;
  if (/Core.*i[37]-12[25][0-9]U/i.test(m))      return 380_000_000;
  if (/Core.*i5-12[23][0-9]U/i.test(m))         return 350_000_000;

  // ── Intel 11th Gen Mobile ─────────────────────────────────────────────────────
  if (/Core.*i9-11980HK/i.test(m))              return 420_000_000;
  if (/Core.*i9-119[0-9]0H/i.test(m))           return 390_000_000;
  if (/Core.*i7-118[0-9]0H/i.test(m))           return 380_000_000;
  if (/Core.*i5-115[0-9]0H/i.test(m))           return 360_000_000;
  if (/Core.*i7-118[56]G[47]/i.test(m))         return 350_000_000;
  if (/Core.*i7-116[56]G7/i.test(m))            return 340_000_000;
  if (/Core.*i5-1135G7/i.test(m))               return 320_000_000;
  if (/Core.*i3-11[12][0-9]G[47]/i.test(m))     return 290_000_000;

  // ── Intel 10th Gen Mobile ─────────────────────────────────────────────────────
  if (/Core.*i7-108[0-9]5H/i.test(m))           return 380_000_000;
  if (/Core.*i7-107[0-9]0H/i.test(m))           return 360_000_000;
  if (/Core.*i5-103[0-9]0H/i.test(m))           return 340_000_000;
  if (/Core.*i7-1065G7/i.test(m))               return 320_000_000;
  if (/Core.*i5-1035G[14]/i.test(m))            return 290_000_000;
  if (/Core.*i3-1005G1/i.test(m))               return 260_000_000;

  // ── Intel Xeon ────────────────────────────────────────────────────────────────
  if (/Xeon.*w9-35[0-9]{2}X/i.test(m))          return 490_000_000;
  if (/Xeon.*w7-3[0-9]{3}X/i.test(m))           return 470_000_000;
  if (/Xeon.*w7-2[0-9]{3}X/i.test(m))           return 450_000_000;
  if (/Xeon.*W-3175X/i.test(m))                 return 390_000_000;
  if (/Xeon.*W-2[2-9][0-9]{2}/i.test(m))        return 410_000_000;
  if (/Xeon.*Gold 6[12][0-9]{2}R?/i.test(m))    return 360_000_000;
  if (/Xeon.*Silver 4[23][0-9]{2}/i.test(m))    return 330_000_000;
  if (/Xeon.*E5-2[6-9][0-9]{2}/i.test(m))       return 260_000_000;

  // ── AMD Ryzen 9000 (Zen 5) ────────────────────────────────────────────────────
  if (/Ryzen 9 9950X/i.test(m))                 return 580_000_000;
  if (/Ryzen 9 9900X/i.test(m))                 return 570_000_000;
  if (/Ryzen 7 9800X3D/i.test(m))               return 520_000_000;
  if (/Ryzen 7 9700X/i.test(m))                 return 560_000_000;
  if (/Ryzen 5 9600X/i.test(m))                 return 540_000_000;
  if (/Ryzen 5 9600/i.test(m))                  return 510_000_000;

  // ── AMD Ryzen 7000 (Zen 4) ────────────────────────────────────────────────────
  if (/Ryzen 9 7950X3D/i.test(m))               return 540_000_000;
  if (/Ryzen 9 7950X/i.test(m))                 return 560_000_000;
  if (/Ryzen 9 7900X3D/i.test(m))               return 530_000_000;
  if (/Ryzen 9 7900X/i.test(m))                 return 550_000_000;
  if (/Ryzen 9 7900/i.test(m))                  return 530_000_000;
  if (/Ryzen 7 7800X3D/i.test(m))               return 490_000_000;
  if (/Ryzen 7 7700X/i.test(m))                 return 530_000_000;
  if (/Ryzen 7 7700/i.test(m))                  return 520_000_000;
  if (/Ryzen 5 7600X/i.test(m))                 return 520_000_000;
  if (/Ryzen 5 7600/i.test(m))                  return 500_000_000;
  if (/Ryzen 5 7500F/i.test(m))                 return 490_000_000;

  // ── AMD Ryzen 5000 (Zen 3) ────────────────────────────────────────────────────
  if (/Ryzen 9 5950X/i.test(m))                 return 470_000_000;
  if (/Ryzen 9 5900X/i.test(m))                 return 460_000_000;
  if (/Ryzen 9 5900HX/i.test(m))                return 420_000_000;
  if (/Ryzen 9 5900/i.test(m))                  return 450_000_000;
  if (/Ryzen 7 5800X3D/i.test(m))               return 430_000_000;
  if (/Ryzen 7 5800X/i.test(m))                 return 450_000_000;
  if (/Ryzen 7 5800H/i.test(m))                 return 410_000_000;
  if (/Ryzen 7 5800/i.test(m))                  return 440_000_000;
  if (/Ryzen 7 5700[GX]?/i.test(m))             return 440_000_000;
  if (/Ryzen 5 5600X/i.test(m))                 return 440_000_000;
  if (/Ryzen 5 5600H/i.test(m))                 return 400_000_000;
  if (/Ryzen 5 5600[G]?/i.test(m))              return 420_000_000;
  if (/Ryzen 5 5500/i.test(m))                  return 400_000_000;
  if (/Ryzen 3 5[13][0-9]{2}G?/i.test(m))       return 385_000_000;

  // ── AMD Ryzen 3000 (Zen 2) ────────────────────────────────────────────────────
  if (/Ryzen 9 3950X/i.test(m))                 return 420_000_000;
  if (/Ryzen 9 3900X?T?/i.test(m))              return 415_000_000;
  if (/Ryzen 7 3800X?T?/i.test(m))              return 410_000_000;
  if (/Ryzen 7 3700X/i.test(m))                 return 400_000_000;
  if (/Ryzen 5 3600X?T?/i.test(m))              return 400_000_000;
  if (/Ryzen 5 3600/i.test(m))                  return 380_000_000;
  if (/Ryzen 5 3500X?/i.test(m))                return 360_000_000;
  if (/Ryzen 3 3[13][0-9]{2}X?/i.test(m))       return 370_000_000;

  // ── AMD Ryzen 2000 (Zen+) ─────────────────────────────────────────────────────
  if (/Ryzen 7 2700X/i.test(m))                 return 330_000_000;
  if (/Ryzen 7 2700/i.test(m))                  return 310_000_000;
  if (/Ryzen 5 2600X/i.test(m))                 return 320_000_000;
  if (/Ryzen 5 2600/i.test(m))                  return 300_000_000;
  if (/Ryzen 3 2[23][0-9]{2}[GX]?/i.test(m))   return 280_000_000;

  // ── AMD Threadripper ──────────────────────────────────────────────────────────
  if (/Threadripper PRO 79[0-9]{2}W/i.test(m))  return 490_000_000;
  if (/Threadripper PRO 59[0-9]{2}W/i.test(m))  return 440_000_000;
  if (/Threadripper 39[0-9]{2}X/i.test(m))      return 400_000_000;
  if (/Threadripper 29[0-9]{2}[WX]/i.test(m))   return 310_000_000;

  // ── AMD EPYC ──────────────────────────────────────────────────────────────────
  if (/EPYC 9[5-9][0-9]{2}/i.test(m))           return 390_000_000;
  if (/EPYC 9[1-4][0-9]{2}/i.test(m))           return 375_000_000;
  if (/EPYC 7[6-9][0-9]{2}/i.test(m))           return 310_000_000;
  if (/EPYC 7[3-5][0-9]{2}/i.test(m))           return 280_000_000;
  if (/EPYC 7[0-2][0-9]{2}/i.test(m))           return 260_000_000;

  // ── Apple Silicon ─────────────────────────────────────────────────────────────
  if (/M4 (Pro|Max|Ultra)/i.test(m))            return 620_000_000;
  if (/\bM4\b/i.test(m))                        return 590_000_000;
  if (/M3 Max/i.test(m))                        return 560_000_000;
  if (/M3 (Pro|Ultra)/i.test(m))                return 550_000_000;
  if (/\bM3\b/i.test(m))                        return 540_000_000;
  if (/M2 (Pro|Max|Ultra)/i.test(m))            return 500_000_000;
  if (/\bM2\b/i.test(m))                        return 480_000_000;
  if (/M1 (Pro|Max|Ultra)/i.test(m))            return 440_000_000;
  if (/\bM1\b/i.test(m))                        return 420_000_000;

  return 0; // unknown — skip validation
}

function getExpectedMemBandwidthMBps(memType, memSpeedMhz, memSticks) {
  if (!memSpeedMhz || memSpeedMhz <= 0) return 0;
  // Infer channel count: ≥2 sticks usually implies dual-channel for DDR4/DDR5.
  // LPDDR is always one "virtual channel" per package (spec-defined 128-bit bus treats as 2 ch).
  const isLPDDR = /LPDDR/i.test(memType || '');
  let channels = isLPDDR ? 2 : ((memSticks >= 2) ? 2 : 1);
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

// ── ASIC Power Lookup ─────────────────────────────────────────────────────────
// Known ASIC miners and their rated power draw in watts.
// Returns the power draw for a known ASIC model, or 0 if unknown.
function getAsicPowerW(model) {
  if (!model) return 0;
  const m = model;

  // ── Bitmain Antminer ────────────────────────────────────────────────────────
  if (/Antminer.*S21\s*XP/i.test(m))         return 3800;
  if (/Antminer.*S21/i.test(m))               return 3500;
  if (/Antminer.*T21/i.test(m))               return 3610;
  if (/Antminer.*S19\s*XP/i.test(m))          return 3010;
  if (/Antminer.*S19\s*Pro\+/i.test(m))       return 3300;
  if (/Antminer.*S19\s*Pro/i.test(m))         return 3250;
  if (/Antminer.*S19j\s*Pro\+/i.test(m))      return 3220;
  if (/Antminer.*S19j\s*Pro/i.test(m))        return 3050;
  if (/Antminer.*S19j/i.test(m))              return 3100;
  if (/Antminer.*S19/i.test(m))               return 3250;
  if (/Antminer.*T19/i.test(m))               return 3150;
  if (/Antminer.*S17\+/i.test(m))             return 2920;
  if (/Antminer.*S17\s*Pro/i.test(m))         return 2090;
  if (/Antminer.*T17\+/i.test(m))             return 2800;
  if (/Antminer.*T17/i.test(m))               return 2200;
  if (/Antminer.*S15/i.test(m))               return 1590;
  if (/Antminer.*T15/i.test(m))               return 1540;
  if (/Antminer.*S9[kji]|S9\s*\(/i.test(m))  return 1400;
  if (/Antminer.*S9/i.test(m))                return 1350;

  // ── MicroBT Whatsminer ─────────────────────────────────────────────────────
  if (/Whatsminer.*M66/i.test(m))             return 2988;
  if (/Whatsminer.*M60S/i.test(m))            return 3500;
  if (/Whatsminer.*M60/i.test(m))             return 3306;
  if (/Whatsminer.*M56/i.test(m))             return 3400;
  if (/Whatsminer.*M50S\+\+/i.test(m))        return 3470;
  if (/Whatsminer.*M50S/i.test(m))            return 3500;
  if (/Whatsminer.*M50/i.test(m))             return 3270;
  if (/Whatsminer.*M30S\+\+/i.test(m))        return 3472;
  if (/Whatsminer.*M30S\+/i.test(m))          return 3400;
  if (/Whatsminer.*M30S/i.test(m))            return 3260;
  if (/Whatsminer.*M30/i.test(m))             return 3260;
  if (/Whatsminer.*M32/i.test(m))             return 3200;
  if (/Whatsminer.*M31S/i.test(m))            return 2700;
  if (/Whatsminer.*M21S/i.test(m))            return 2700;
  if (/Whatsminer.*M20S/i.test(m))            return 2800;
  if (/Whatsminer.*M20/i.test(m))             return 2800;

  // ── Canaan Avalon ──────────────────────────────────────────────────────────
  if (/Avalon.*A1466I/i.test(m))              return 3320;
  if (/Avalon.*A1366I/i.test(m))              return 3250;
  if (/Avalon.*A1266/i.test(m))               return 3420;
  if (/Avalon.*A1166\s*Pro/i.test(m))         return 3400;
  if (/Avalon.*A1166/i.test(m))               return 3250;
  if (/Avalon.*A1066/i.test(m))               return 3200;

  return 0; // unknown — caller should fall back to defaults
}

// ── ASIC Hashrate Lookup ─────────────────────────────────────────────────────
// Known ASIC miners and their expected hashrate in TH/s.
// Returns the expected hashrate for a known ASIC model, or 0 if unknown.
function getAsicHashrateTHs(model) {
  if (!model) return 0;
  const m = model;

  // ── Bitmain Antminer ────────────────────────────────────────────────────────
  if (/Antminer.*S21\s*XP/i.test(m))         return 270;
  if (/Antminer.*S21/i.test(m))               return 200;
  if (/Antminer.*T21/i.test(m))               return 190;
  if (/Antminer.*S19\s*XP/i.test(m))          return 141;
  if (/Antminer.*S19\s*Pro\+/i.test(m))       return 120;
  if (/Antminer.*S19\s*Pro/i.test(m))         return 110;
  if (/Antminer.*S19j\s*Pro\+/i.test(m))      return 122;
  if (/Antminer.*S19j\s*Pro/i.test(m))        return 100;
  if (/Antminer.*S19j/i.test(m))              return 90;
  if (/Antminer.*S19/i.test(m))               return 95;
  if (/Antminer.*T19/i.test(m))               return 84;
  if (/Antminer.*S17\+/i.test(m))             return 73;
  if (/Antminer.*S17\s*Pro/i.test(m))         return 53;
  if (/Antminer.*T17\+/i.test(m))             return 64;
  if (/Antminer.*T17/i.test(m))               return 56;
  if (/Antminer.*S15/i.test(m))               return 28;
  if (/Antminer.*T15/i.test(m))               return 23;
  if (/Antminer.*S9[kji]|S9\s*\(/i.test(m))  return 14;
  if (/Antminer.*S9/i.test(m))                return 13.5;

  // ── MicroBT Whatsminer ─────────────────────────────────────────────────────
  if (/Whatsminer.*M66/i.test(m))             return 290;
  if (/Whatsminer.*M60S/i.test(m))            return 190;
  if (/Whatsminer.*M60/i.test(m))             return 186;
  if (/Whatsminer.*M56/i.test(m))             return 230;
  if (/Whatsminer.*M50S\+\+/i.test(m))        return 126;
  if (/Whatsminer.*M50S/i.test(m))            return 114;
  if (/Whatsminer.*M50/i.test(m))             return 118;
  if (/Whatsminer.*M30S\+\+/i.test(m))        return 112;
  if (/Whatsminer.*M30S\+/i.test(m))          return 100;
  if (/Whatsminer.*M30S/i.test(m))            return 86;
  if (/Whatsminer.*M30/i.test(m))             return 80;
  if (/Whatsminer.*M32/i.test(m))             return 60;
  if (/Whatsminer.*M31S/i.test(m))            return 76;
  if (/Whatsminer.*M21S/i.test(m))            return 56;
  if (/Whatsminer.*M20S/i.test(m))            return 68;
  if (/Whatsminer.*M20/i.test(m))             return 64;

  // ── Canaan Avalon ──────────────────────────────────────────────────────────
  if (/Avalon.*A1466I/i.test(m))              return 150;
  if (/Avalon.*A1366I/i.test(m))              return 130;
  if (/Avalon.*A1266/i.test(m))               return 90;
  if (/Avalon.*A1166\s*Pro/i.test(m))         return 81;
  if (/Avalon.*A1166/i.test(m))               return 70;
  if (/Avalon.*A1066/i.test(m))               return 50;

  return 0; // unknown — caller should fall back to defaults
}

// ── GPU TDP Lookup ───────────────────────────────────────────────────────
// Returns the rated TDP (W) for a known GPU model string, or 0 if unknown.
// Used by electron-main.js to cap GPU energy claims — the adapter name comes
// from the native binary (gpu-miner.exe via DXGI) so the renderer cannot
// lie about which GPU is installed.
function getGpuTdpW(model) {
  if (!model) return 0;
  const m = model;
  // ── NVIDIA RTX 40 series ─────────────────────────────────────────────────
  if (/GeForce.*RTX 4090/i.test(m))                   return 450;
  if (/GeForce.*RTX 4080 (SUPER|S)/i.test(m))         return 320;
  if (/GeForce.*RTX 4080/i.test(m))                   return 320;
  if (/GeForce.*RTX 4070 Ti SUPER/i.test(m))          return 285;
  if (/GeForce.*RTX 4070 Ti/i.test(m))                return 285;
  if (/GeForce.*RTX 4070 SUPER/i.test(m))             return 220;
  if (/GeForce.*RTX 4070/i.test(m))                   return 200;
  if (/GeForce.*RTX 4060 Ti/i.test(m))                return 165;
  if (/GeForce.*RTX 4060/i.test(m))                   return 115;
  if (/GeForce.*RTX 4050/i.test(m))                   return 50;
  // ── NVIDIA RTX 30 series ─────────────────────────────────────────────────
  if (/GeForce.*RTX 3090 Ti/i.test(m))                return 450;
  if (/GeForce.*RTX 3090/i.test(m))                   return 350;
  if (/GeForce.*RTX 3080 Ti/i.test(m))                return 350;
  if (/GeForce.*RTX 3080/i.test(m))                   return 320;
  if (/GeForce.*RTX 3070 Ti/i.test(m))                return 290;
  if (/GeForce.*RTX 3070/i.test(m))                   return 220;
  if (/GeForce.*RTX 3060 Ti/i.test(m))                return 200;
  if (/GeForce.*RTX 3060/i.test(m))                   return 170;
  if (/GeForce.*RTX 3050/i.test(m))                   return 130;
  // ── NVIDIA GTX 16 / 10 series ────────────────────────────────────────────
  if (/GeForce.*GTX 1660 Ti/i.test(m))                return 120;
  if (/GeForce.*GTX 1660 SUPER/i.test(m))             return 125;
  if (/GeForce.*GTX 1660/i.test(m))                   return 120;
  if (/GeForce.*GTX 1650/i.test(m))                   return 75;
  if (/GeForce.*GTX 1080 Ti/i.test(m))                return 250;
  if (/GeForce.*GTX 1080/i.test(m))                   return 180;
  if (/GeForce.*GTX 1070 Ti/i.test(m))                return 180;
  if (/GeForce.*GTX 1070/i.test(m))                   return 150;
  if (/GeForce.*GTX 1060/i.test(m))                   return 120;
  if (/GeForce.*GTX 1050 Ti/i.test(m))                return 75;
  // ── AMD RX 7000 series ───────────────────────────────────────────────────
  if (/Radeon.*RX 7900 XTX/i.test(m))                 return 355;
  if (/Radeon.*RX 7900 XT/i.test(m))                  return 300;
  if (/Radeon.*RX 7900 GRE/i.test(m))                 return 260;
  if (/Radeon.*RX 7800 XT/i.test(m))                  return 263;
  if (/Radeon.*RX 7700 XT/i.test(m))                  return 245;
  if (/Radeon.*RX 7600 XT/i.test(m))                  return 190;
  if (/Radeon.*RX 7600/i.test(m))                     return 165;
  // ── AMD RX 6000 series ───────────────────────────────────────────────────
  if (/Radeon.*RX 6950 XT/i.test(m))                  return 335;
  if (/Radeon.*RX 6900 XT/i.test(m))                  return 300;
  if (/Radeon.*RX 6800 XT/i.test(m))                  return 300;
  if (/Radeon.*RX 6800/i.test(m))                     return 250;
  if (/Radeon.*RX 6750 XT/i.test(m))                  return 250;
  if (/Radeon.*RX 6700 XT/i.test(m))                  return 230;
  if (/Radeon.*RX 6700/i.test(m))                     return 175;
  if (/Radeon.*RX 6650 XT/i.test(m))                  return 180;
  if (/Radeon.*RX 6600 XT/i.test(m))                  return 160;
  if (/Radeon.*RX 6600/i.test(m))                     return 132;
  if (/Radeon.*RX 6500 XT/i.test(m))                  return 107;
  if (/Radeon.*RX 6400/i.test(m))                     return 53;
  // ── AMD RX 5000 series ───────────────────────────────────────────────────
  if (/Radeon.*RX 5700 XT/i.test(m))                  return 225;
  if (/Radeon.*RX 5700/i.test(m))                     return 180;
  if (/Radeon.*RX 5600 XT/i.test(m))                  return 150;
  if (/Radeon.*RX 5500 XT/i.test(m))                  return 130;
  // ── Intel Arc ────────────────────────────────────────────────────────────
  if (/Intel.*Arc A770/i.test(m))                     return 225;
  if (/Intel.*Arc A750/i.test(m))                     return 225;
  if (/Intel.*Arc A580/i.test(m))                     return 175;
  if (/Intel.*Arc A380/i.test(m))                     return 75;
  // ── Intel integrated (fallback — low TDP) ───────────────────────────────
  if (/Intel.*UHD Graphics/i.test(m))                 return 15;
  if (/Intel.*Iris Xe/i.test(m))                      return 15;
  if (/Intel.*HD Graphics/i.test(m))                  return 10;
  // ── Microsoft Basic Render / WARP (no real GPU) ─────────────────────────
  if (/Microsoft Basic Render/i.test(m))              return 0;
  if (/Microsoft.*WARP/i.test(m))                     return 0;
  // Unknown — VRAM-based fallback
  return 0;
}

module.exports = { getExpectedCpuSpeedOps, getExpectedMemBandwidthMBps, getAsicPowerW, getAsicHashrateTHs, getGpuTdpW };

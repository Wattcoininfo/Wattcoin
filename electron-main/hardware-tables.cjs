// hardware-tables.cjs
// Authoritative hardware expected-ops lookup tables.
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

// ── ASIC Power Lookup ─────────────────────────────────────────────────────────
// Known ASIC miners and their rated power draw in watts.
// Returns the power draw for a known ASIC model, or 0 if unknown.
function getAsicPowerW(model) {
  if (!model) return 0;
  const m = model;

  // ── Bitmain Antminer ────────────────────────────────────────────────────────
  // S23 series (3nm, 2025-2026)
  if (/Antminer.*S23\s*Hyd\s*3U|Antminer.*U3S23H/i.test(m))  return 11020;
  if (/Antminer.*S23\s*E\s*U2H|Antminer.*S23e\s*U2H/i.test(m))  return 8650;
  if (/Antminer.*S23\s*Hyd/i.test(m))                          return 5510;
  if (/Antminer.*S23\s*Imm/i.test(m))                          return 5304;
  if (/Antminer.*S23/i.test(m))                                return 3498;
  // S21 series (5nm, 2024-2025)
  if (/Antminer.*S21\s*XP\s*Hyd/i.test(m))                    return 5676;
  if (/Antminer.*S21\s*XP\s*Imm/i.test(m))                    return 4050;
  if (/Antminer.*S21\s*XP/i.test(m))                           return 3650;
  if (/Antminer.*S21\s*Pro/i.test(m))                          return 3510;
  if (/Antminer.*S21\+\s*Hyd/i.test(m))                       return 4785;
  if (/Antminer.*S21\+/i.test(m))                              return 3564;
  if (/Antminer.*S21/i.test(m))                                return 3500;
  // T21
  if (/Antminer.*T21/i.test(m))                                return 3610;
  // S19 series
  if (/Antminer.*S19\s*XP\s*Hyd/i.test(m))                    return 5323;
  if (/Antminer.*S19\s*XP/i.test(m))                           return 3010;
  if (/Antminer.*S19\s*Pro\+\s*Hyd/i.test(m))                 return 5360;
  if (/Antminer.*S19\s*Pro\+/i.test(m))                        return 3250;
  if (/Antminer.*S19\s*Pro/i.test(m))                          return 3250;
  if (/Antminer.*S19\s*K\s*Pro/i.test(m))                      return 2760;
  if (/Antminer.*S19j\s*Pro\+/i.test(m))                       return 3220;
  if (/Antminer.*S19j\s*Pro/i.test(m))                         return 3050;
  if (/Antminer.*S19j/i.test(m))                               return 3100;
  if (/Antminer.*S19/i.test(m))                                return 3250;
  // Older models
  if (/Antminer.*T19/i.test(m))                                return 3150;
  if (/Antminer.*S17\+/i.test(m))                              return 2920;
  if (/Antminer.*S17\s*Pro/i.test(m))                          return 2090;
  if (/Antminer.*T17\+/i.test(m))                              return 2800;
  if (/Antminer.*T17/i.test(m))                                return 2200;
  if (/Antminer.*S15/i.test(m))                                return 1590;
  if (/Antminer.*T15/i.test(m))                                return 1540;
  if (/Antminer.*D3/i.test(m))                                 return 1350;
  if (/Antminer.*S9[kji]|S9\s*\(/i.test(m))                   return 1400;
  if (/Antminer.*S9/i.test(m))                                 return 1350;

  // ── MicroBT Whatsminer ─────────────────────────────────────────────────────
  // M79 series (hydro, 2025-2026)
  if (/Whatsminer.*M79S/i.test(m))            return 20000;
  if (/Whatsminer.*M79/i.test(m))             return 14500;
  // M78 series (immersion, 2025-2026)
  if (/Whatsminer.*M78S/i.test(m))            return 7000;
  if (/Whatsminer.*M78/i.test(m))             return 7000;
  // M76 series (immersion, 2025-2026)
  if (/Whatsminer.*M76S\+/i.test(m))          return 5200;
  if (/Whatsminer.*M76S/i.test(m))            return 5200;
  if (/Whatsminer.*M76/i.test(m))             return 5200;
  // M73 series (hydro, 2025-2026)
  if (/Whatsminer.*M73S\+/i.test(m))          return 7200;
  if (/Whatsminer.*M73S/i.test(m))            return 7200;
  if (/Whatsminer.*M73/i.test(m))             return 7200;
  // M72 series (air, 2025-2026)
  if (/Whatsminer.*M72S/i.test(m))            return 4000;
  if (/Whatsminer.*M72/i.test(m))             return 4030;
  // M70 series (air, 2025-2026)
  if (/Whatsminer.*M70S\+/i.test(m))          return 3275;
  if (/Whatsminer.*M70S/i.test(m))            return 3267;
  if (/Whatsminer.*M70/i.test(m))             return 3263;
  // M66 series (air, 2023)
  if (/Whatsminer.*M66S/i.test(m))            return 5364;
  if (/Whatsminer.*M66/i.test(m))             return 5550;
  // M60 series (air, 2023)
  if (/Whatsminer.*M60S\+/i.test(m))          return 3816;
  if (/Whatsminer.*M60S/i.test(m))            return 3441;
  if (/Whatsminer.*M60/i.test(m))             return 3184;
  // Older models
  if (/Whatsminer.*M56/i.test(m))             return 5500;
  if (/Whatsminer.*M50S\+\+/i.test(m))        return 3470;
  if (/Whatsminer.*M50S/i.test(m))            return 3500;
  if (/Whatsminer.*M50/i.test(m))             return 3270;
  if (/Whatsminer.*M30S\+\+/i.test(m))        return 3472;
  if (/Whatsminer.*M30S\+/i.test(m))          return 3400;
  if (/Whatsminer.*M30S/i.test(m))            return 3260;
  if (/Whatsminer.*M30/i.test(m))             return 3260;
  if (/Whatsminer.*M32/i.test(m))             return 3200;
  if (/Whatsminer.*M31S/i.test(m))            return 3360;
  if (/Whatsminer.*M21S/i.test(m))            return 3360;
  if (/Whatsminer.*M20S/i.test(m))            return 3400;
  if (/Whatsminer.*M20/i.test(m))             return 2800;

  // ── Canaan Avalon ──────────────────────────────────────────────────────────
  if (/Avalon.*A16\s*XP/i.test(m))            return 3850;
  if (/Avalon.*A16(?!.*XP)/i.test(m))         return 3900;
  if (/Avalon.*A15\s*Pro/i.test(m))           return 3662;
  if (/Avalon.*A15(?!6)/i.test(m))            return 3647;
  if (/Avalon.*A1566/i.test(m))               return 3420;
  if (/Avalon.*A1466I/i.test(m))              return 3320;
  if (/Avalon.*A1366I/i.test(m))              return 3570;
  if (/Avalon.*A1266/i.test(m))               return 3420;
  if (/Avalon.*A1166\s*Pro/i.test(m))         return 3400;
  if (/Avalon.*A1166/i.test(m))               return 3250;
  if (/Avalon.*A1066/i.test(m))               return 3200;

  // ── Bitdeer SealMiner ─────────────────────────────────────────────────────
  if (/Sealminer.*A3\s*Pro\s*Hyd/i.test(m))  return 8250;
  if (/Sealminer.*A3\s*Hyd/i.test(m))        return 6750;
  if (/Sealminer.*A3\s*Pro/i.test(m))         return 3625;
  if (/Sealminer.*A3(?!.*Pro)/i.test(m))      return 3640;
  if (/Sealminer.*A2\s*Pro\s*Hyd/i.test(m))  return 7450;
  if (/Sealminer.*A2\s*Pro/i.test(m))         return 3790;
  if (/Sealminer.*A2/i.test(m))               return 3729;

  // ── Auradine Teraflux ────────────────────────────────────────────────────
  if (/Auradine.*AH3880/i.test(m))            return 8700;
  if (/Auradine.*AI3680/i.test(m))            return 6840;

  return 0; // unknown — caller should fall back to defaults
}

// ── ASIC Hashrate Lookup ─────────────────────────────────────────────────────
// Known ASIC miners and their expected hashrate in TH/s.
// Returns the expected hashrate for a known ASIC model, or 0 if unknown.
function getAsicHashrateTHs(model) {
  if (!model) return 0;
  const m = model;

  // ── Bitmain Antminer ────────────────────────────────────────────────────────
  // S23 series
  if (/Antminer.*S23\s*Hyd\s*3U|Antminer.*U3S23H/i.test(m))  return 1160;
  if (/Antminer.*S23\s*E\s*U2H|Antminer.*S23e\s*U2H/i.test(m))  return 865;
  if (/Antminer.*S23\s*Hyd/i.test(m))                          return 580;
  if (/Antminer.*S23\s*Imm/i.test(m))                          return 442;
  if (/Antminer.*S23/i.test(m))                                return 318;
  // S21 series
  if (/Antminer.*S21\s*XP\s*Hyd/i.test(m))                    return 473;
  if (/Antminer.*S21\s*XP\s*Imm/i.test(m))                    return 300;
  if (/Antminer.*S21\s*XP/i.test(m))                           return 270;
  if (/Antminer.*S21\s*Pro/i.test(m))                          return 234;
  if (/Antminer.*S21\+\s*Hyd/i.test(m))                       return 319;
  if (/Antminer.*S21\+/i.test(m))                              return 216;
  if (/Antminer.*S21/i.test(m))                                return 200;
  // T21
  if (/Antminer.*T21/i.test(m))                                return 234;
  // S19 series
  if (/Antminer.*S19\s*XP\s*Hyd/i.test(m))                    return 444;
  if (/Antminer.*S19\s*XP/i.test(m))                           return 141;
  if (/Antminer.*S19\s*Pro\+\s*Hyd/i.test(m))                 return 440;
  if (/Antminer.*S19\s*Pro\+/i.test(m))                        return 120;
  if (/Antminer.*S19\s*Pro/i.test(m))                          return 110;
  if (/Antminer.*S19\s*K\s*Pro/i.test(m))                      return 120;
  if (/Antminer.*S19j\s*Pro\+/i.test(m))                       return 122;
  if (/Antminer.*S19j\s*Pro/i.test(m))                         return 100;
  if (/Antminer.*S19j/i.test(m))                               return 90;
  if (/Antminer.*S19/i.test(m))                                return 95;
  // Older models
  if (/Antminer.*T19/i.test(m))                                return 84;
  if (/Antminer.*S17\+/i.test(m))                              return 73;
  if (/Antminer.*S17\s*Pro/i.test(m))                          return 53;
  if (/Antminer.*T17\+/i.test(m))                              return 64;
  if (/Antminer.*T17/i.test(m))                                return 56;
  if (/Antminer.*S15/i.test(m))                                return 28;
  if (/Antminer.*T15/i.test(m))                                return 23;
  if (/Antminer.*D3/i.test(m))                                 return 0.0193;
  if (/Antminer.*S9[kji]|S9\s*\(/i.test(m))                   return 14;
  if (/Antminer.*S9/i.test(m))                                 return 13.5;

  // ── MicroBT Whatsminer ─────────────────────────────────────────────────────
  // M79 series (hydro, 2025-2026)
  if (/Whatsminer.*M79S/i.test(m))            return 1350;
  if (/Whatsminer.*M79/i.test(m))             return 920;
  // M78 series (immersion, 2025-2026)
  if (/Whatsminer.*M78S/i.test(m))            return 472;
  if (/Whatsminer.*M78/i.test(m))             return 440;
  // M76 series (immersion, 2025-2026)
  if (/Whatsminer.*M76S\+/i.test(m))          return 390;
  if (/Whatsminer.*M76S/i.test(m))            return 362;
  if (/Whatsminer.*M76/i.test(m))             return 336;
  // M73 series (hydro, 2025-2026)
  if (/Whatsminer.*M73S\+/i.test(m))          return 540;
  if (/Whatsminer.*M73S/i.test(m))            return 500;
  if (/Whatsminer.*M73/i.test(m))             return 470;
  // M72 series (air, 2025-2026)
  if (/Whatsminer.*M72S/i.test(m))            return 300;
  if (/Whatsminer.*M72/i.test(m))             return 278;
  // M70 series (air, 2025-2026)
  if (/Whatsminer.*M70S\+/i.test(m))          return 262;
  if (/Whatsminer.*M70S/i.test(m))            return 242;
  if (/Whatsminer.*M70/i.test(m))             return 225;
  // M66 series (air, 2023)
  if (/Whatsminer.*M66S/i.test(m))            return 298;
  if (/Whatsminer.*M66/i.test(m))             return 260;
  // M60 series (air, 2023)
  if (/Whatsminer.*M60S\+/i.test(m))          return 212;
  if (/Whatsminer.*M60S/i.test(m))            return 186;
  if (/Whatsminer.*M60/i.test(m))             return 160;
  // Older models
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
  if (/Avalon.*A16\s*XP/i.test(m))            return 300;
  if (/Avalon.*A16(?!.*XP)/i.test(m))         return 282;
  if (/Avalon.*A15\s*Pro/i.test(m))           return 218;
  if (/Avalon.*A15(?!6)/i.test(m))            return 194;
  if (/Avalon.*A1566/i.test(m))               return 185;
  if (/Avalon.*A1466I/i.test(m))              return 150;
  if (/Avalon.*A1366I/i.test(m))              return 130;
  if (/Avalon.*A1266/i.test(m))               return 90;
  if (/Avalon.*A1166\s*Pro/i.test(m))         return 81;
  if (/Avalon.*A1166/i.test(m))               return 70;
  if (/Avalon.*A1066/i.test(m))               return 50;

  // ── Bitdeer SealMiner ─────────────────────────────────────────────────────
  if (/Sealminer.*A3\s*Pro\s*Hyd/i.test(m))  return 660;
  if (/Sealminer.*A3\s*Hyd/i.test(m))        return 500;
  if (/Sealminer.*A3\s*Pro/i.test(m))         return 290;
  if (/Sealminer.*A3(?!.*Pro)/i.test(m))      return 260;
  if (/Sealminer.*A2\s*Pro\s*Hyd/i.test(m))  return 500;
  if (/Sealminer.*A2\s*Pro/i.test(m))         return 255;
  if (/Sealminer.*A2/i.test(m))               return 226;

  // ── Auradine Teraflux ────────────────────────────────────────────────────
  if (/Auradine.*AH3880/i.test(m))            return 600;
  if (/Auradine.*AI3680/i.test(m))            return 360;

  return 0; // unknown — caller should fall back to defaults
}

// ── GPU TDP Lookup ───────────────────────────────────────────────────────
// Returns the rated TDP (W) for a known GPU model string, or 0 if unknown.
// Used by electron-main.js to cap GPU energy claims — the adapter name comes
// from the native binary (gpu-miner.exe via DXGI) so the renderer cannot
// lie about which GPU is installed.
function getGpuTdpW(model) {
  if (!model) return 0;
  // Normalize: extract the most useful GPU name from OS/driver strings.
  // Common formats:
  //   "GA102 [GeForce RTX 3080]"        → prefer bracket content
  //   "NVIDIA GeForce RTX 3080 [GA102]" → strip brackets
  //   "NVIDIA GeForce RTX 4080 Laptop GPU Laptop GPU" → strip suffixes
  //   "10de:2206 (rev a1)"              → no match possible
  let m = model;
  // If brackets contain a known brand keyword, prefer that content
  const bracketMatch = m.match(/\[([^\]]+)\]/);
  if (bracketMatch && /\bGeForce|Radeon|Arc\b/i.test(bracketMatch[1])) {
    m = bracketMatch[1];
  } else {
    // Strip brackets and their content
    m = m.replace(/\[[^\]]*\]/g, ' ');
  }
  m = m
    .replace(/\b[0-9a-f]{4}:[0-9a-f]{4}\b/gi, ' ') // strip PCI device IDs
    .replace(/\brev\b\s+\S+/gi, ' ')       // strip "rev a1"
    .replace(/\s+/g, ' ')
    .trim();
  // ── NVIDIA RTX 50 series (Blackwell) ──────────────────────────────────────
  if (/GeForce.*RTX 5090/i.test(m))                   return 575;
  if (/GeForce.*RTX 5080/i.test(m))                   return 360;
  if (/GeForce.*RTX 5070 Ti/i.test(m))                return 300;
  if (/GeForce.*RTX 5070/i.test(m))                   return 250;
  if (/GeForce.*RTX 5060 Ti/i.test(m))                return 180;
  if (/GeForce.*RTX 5060/i.test(m))                   return 145;
  // ── NVIDIA RTX 40 series ─────────────────────────────────────────────────
  if (/GeForce.*RTX 4090/i.test(m))                   return 450;
  if (/GeForce.*RTX 4080 (SUPER|S)/i.test(m))         return 320;
  if (/GeForce.*RTX 4080/i.test(m))                   return 320;
  if (/GeForce.*RTX 4070 Ti SUPER/i.test(m))          return 285;
  if (/GeForce.*RTX 4070 Ti/i.test(m))                return 285;
  if (/GeForce.*RTX 4070 SUPER/i.test(m))             return 220;
  if (/GeForce.*RTX 4070/i.test(m))                   return 200;
  if (/GeForce.*RTX 4060 Ti/i.test(m))                return 160;
  if (/GeForce.*RTX 4060/i.test(m))                   return 115;
  if (/GeForce.*RTX 4050/i.test(m))                   return 115;
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
  if (/GeForce.*GTX 1650 SUPER/i.test(m))             return 100;
  if (/GeForce.*GTX 1650/i.test(m))                   return 75;
  if (/GeForce.*GTX 1630/i.test(m))                   return 75;
  if (/GeForce.*GTX 1080 Ti/i.test(m))                return 250;
  if (/GeForce.*GTX 1080/i.test(m))                   return 180;
  if (/GeForce.*GTX 1070 Ti/i.test(m))                return 180;
  if (/GeForce.*GTX 1070/i.test(m))                   return 150;
  if (/GeForce.*GTX 1060/i.test(m))                   return 120;
  if (/GeForce.*GTX 1050 Ti/i.test(m))                return 75;
  if (/GeForce.*GTX 1050/i.test(m))                   return 75;
  if (/GeForce.*GTX 1030/i.test(m))                   return 30;
  // ── NVIDIA RTX 20 series ─────────────────────────────────────────────────
  if (/GeForce.*RTX 2080 Ti/i.test(m))                return 250;
  if (/GeForce.*RTX 2080 SUPER/i.test(m))             return 250;
  if (/GeForce.*RTX 2080/i.test(m))                   return 215;
  if (/GeForce.*RTX 2070 SUPER/i.test(m))             return 215;
  if (/GeForce.*RTX 2070/i.test(m))                   return 175;
  if (/GeForce.*RTX 2060 SUPER/i.test(m))             return 175;
  if (/GeForce.*RTX 2060/i.test(m))                   return 160;
  // ── NVIDIA GTX 9 series ──────────────────────────────────────────────────
  if (/GeForce.*GTX 980 Ti/i.test(m))                 return 250;
  if (/GeForce.*GTX 980/i.test(m))                    return 165;
  if (/GeForce.*GTX 970/i.test(m))                    return 145;
  if (/GeForce.*GTX 960/i.test(m))                    return 120;
  if (/GeForce.*GTX 950/i.test(m))                    return 90;
  // ── NVIDIA GTX 7 series ──────────────────────────────────────────────────
  if (/GeForce.*GTX 780 Ti/i.test(m))                 return 250;
  if (/GeForce.*GTX 780/i.test(m))                    return 250;
  if (/GeForce.*GTX 770/i.test(m))                    return 230;
  if (/GeForce.*GTX 760/i.test(m))                    return 170;
  if (/GeForce.*GTX 750 Ti/i.test(m))                 return 60;
  if (/GeForce.*GTX 750/i.test(m))                    return 55;
  // ── NVIDIA GTX 6 series ──────────────────────────────────────────────────
  if (/GeForce.*GTX 690/i.test(m))                    return 300;
  if (/GeForce.*GTX 680/i.test(m))                    return 195;
  if (/GeForce.*GTX 670/i.test(m))                    return 170;
  if (/GeForce.*GTX 660 Ti/i.test(m))                 return 150;
  if (/GeForce.*GTX 660/i.test(m))                    return 140;
  if (/GeForce.*GTX 650 Ti/i.test(m))                 return 110;
  if (/GeForce.*GTX 650/i.test(m))                    return 64;
  // ── NVIDIA GTX 5 series ──────────────────────────────────────────────────
  if (/GeForce.*GTX 590/i.test(m))                    return 365;
  if (/GeForce.*GTX 580/i.test(m))                    return 244;
  if (/GeForce.*GTX 570/i.test(m))                    return 219;
  if (/GeForce.*GTX 560 Ti/i.test(m))                 return 170;
  if (/GeForce.*GTX 560/i.test(m))                    return 150;
  if (/GeForce.*GTX 550 Ti/i.test(m))                 return 116;
  // ── AMD RX 9000 series (RDNA 4) ──────────────────────────────────────────
  if (/Radeon.*RX 9070 XT/i.test(m))                  return 304;
  if (/Radeon.*RX 9070/i.test(m))                     return 220;
  // ── AMD RX 7000 series ───────────────────────────────────────────────────
  if (/Radeon.*RX 7900 XTX/i.test(m))                 return 355;
  if (/Radeon.*RX 7900 XT/i.test(m))                  return 315;
  if (/Radeon.*RX 7900 GRE/i.test(m))                 return 260;
  if (/Radeon.*RX 7800 XT/i.test(m))                  return 263;
  if (/Radeon.*RX 7700 XT/i.test(m))                  return 245;
  if (/Radeon.*RX 7600 XT/i.test(m))                  return 190;
  if (/Radeon.*RX 7600/i.test(m))                     return 165;
  if (/Radeon.*RX 7500 XT/i.test(m))                  return 100;
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
  if (/Radeon.*RX 6500 XT/i.test(m))                  return 113;
  if (/Radeon.*RX 6400/i.test(m))                     return 53;
  // ── AMD RX 5000 series ───────────────────────────────────────────────────
  if (/Radeon.*RX 5700 XT/i.test(m))                  return 225;
  if (/Radeon.*RX 5700/i.test(m))                     return 180;
  if (/Radeon.*RX 5600 XT/i.test(m))                  return 150;
  if (/Radeon.*RX 5500 XT/i.test(m))                  return 130;
  if (/Radeon.*RX 5500/i.test(m))                     return 130;
  // ── AMD RX 500 series (Polaris Refresh) ──────────────────────────────────
  if (/Radeon.*RX 590/i.test(m))                      return 225;
  if (/Radeon.*RX 580/i.test(m))                      return 185;
  if (/Radeon.*RX 570/i.test(m))                      return 150;
  if (/Radeon.*RX 560/i.test(m))                      return 80;
  if (/Radeon.*RX 550/i.test(m))                      return 50;
  // ── AMD RX 400 series (Polaris) ──────────────────────────────────────────
  if (/Radeon.*RX 480/i.test(m))                      return 150;
  if (/Radeon.*RX 470/i.test(m))                      return 120;
  if (/Radeon.*RX 460/i.test(m))                      return 75;
  // ── AMD Vega / Radeon VII ────────────────────────────────────────────────
  if (/Radeon.*Vega 64/i.test(m))                     return 295;
  if (/Radeon.*Vega 56/i.test(m))                     return 210;
  if (/Radeon VII/i.test(m))                          return 300;
  // ── AMD R9 / R7 / R5 (GCN 1-3) ──────────────────────────────────────────
  if (/Radeon.*R9 Fury X/i.test(m))                   return 275;
  if (/Radeon.*R9 Fury/i.test(m))                     return 275;
  if (/Radeon.*R9 Nano/i.test(m))                     return 175;
  if (/Radeon.*R9 390X/i.test(m))                     return 275;
  if (/Radeon.*R9 390/i.test(m))                      return 275;
  if (/Radeon.*R9 380X/i.test(m))                     return 190;
  if (/Radeon.*R9 380/i.test(m))                      return 190;
  if (/Radeon.*R9 290X/i.test(m))                     return 290;
  if (/Radeon.*R9 290/i.test(m))                      return 275;
  if (/Radeon.*R9 285/i.test(m))                      return 190;
  if (/Radeon.*R9 280X/i.test(m))                     return 250;
  if (/Radeon.*R9 280/i.test(m))                      return 200;
  if (/Radeon.*R9 270X/i.test(m))                     return 180;
  if (/Radeon.*R9 270/i.test(m))                      return 150;
  if (/Radeon.*R7 370/i.test(m))                      return 110;
  if (/Radeon.*R7 360/i.test(m))                      return 80;
  if (/Radeon.*R7 265/i.test(m))                      return 150;
  if (/Radeon.*R7 260X/i.test(m))                     return 95;
  if (/Radeon.*R5 230/i.test(m))                      return 19;
  // ── AMD HD 7000 series (GCN 1) ──────────────────────────────────────────
  if (/Radeon.*HD 7990/i.test(m))                     return 375;
  if (/Radeon.*HD 7970/i.test(m))                     return 250;
  if (/Radeon.*HD 7950/i.test(m))                     return 200;
  if (/Radeon.*HD 7870/i.test(m))                     return 175;
  if (/Radeon.*HD 7850/i.test(m))                     return 130;
  if (/Radeon.*HD 7790/i.test(m))                     return 100;
  if (/Radeon.*HD 7770/i.test(m))                     return 80;
  if (/Radeon.*HD 7750/i.test(m))                     return 55;
  // ── AMD Radeon PRO Workstation ──────────────────────────────────────────
  if (/Radeon.*PRO W7900/i.test(m))                   return 295;
  if (/Radeon.*PRO W7800/i.test(m))                   return 260;
  if (/Radeon.*PRO W6800/i.test(m))                   return 250;
  if (/Radeon.*PRO W6600/i.test(m))                   return 130;
  if (/Radeon.*PRO W6400/i.test(m))                   return 50;
  // ── Intel Arc ────────────────────────────────────────────────────────────
  if (/Intel.*Arc.*A770/i.test(m))                    return 225;
  if (/Intel.*Arc.*A750/i.test(m))                    return 225;
  if (/Intel.*Arc.*A580/i.test(m))                    return 185;
  if (/Intel.*Arc.*A380/i.test(m))                    return 75;
  if (/Intel.*Arc.*A310/i.test(m))                    return 75;
  if (/Intel.*Arc.*B580/i.test(m))                    return 190;
  if (/Intel.*Arc.*B570/i.test(m))                    return 150;
  // ── NVIDIA RTX Ada Workstation ──────────────────────────────────────────
  if (/RTX.*6000 Ada/i.test(m))                       return 300;
  if (/RTX.*5000 Ada/i.test(m))                       return 250;
  if (/RTX.*4500 Ada/i.test(m))                       return 210;
  if (/RTX.*4000 Ada/i.test(m))                       return 130;
  if (/RTX.*2000 Ada/i.test(m))                       return 70;
  // ── NVIDIA RTX A-series Workstation ─────────────────────────────────────
  if (/RTX.*A6000/i.test(m))                          return 300;
  if (/RTX.*A5000/i.test(m))                          return 230;
  if (/RTX.*A4000/i.test(m))                          return 140;
  if (/RTX.*A2000/i.test(m))                          return 70;
  // ── NVIDIA Quadro RTX ───────────────────────────────────────────────────
  if (/Quadro.*RTX 8000/i.test(m))                    return 295;
  if (/Quadro.*RTX 6000/i.test(m))                    return 295;
  if (/Quadro.*RTX 5000/i.test(m))                    return 230;
  if (/Quadro.*RTX 4000/i.test(m))                    return 160;
  // ── Intel integrated (fallback — low TDP) ───────────────────────────────
  if (/Intel.*UHD Graphics/i.test(m))                 return 15;
  if (/Intel.*Iris.*Xe/i.test(m))                     return 15;
  if (/Intel.*HD Graphics/i.test(m))                  return 10;
  // ── Microsoft Basic Render / WARP (no real GPU) ─────────────────────────
  if (/Microsoft Basic Render/i.test(m))              return 0;
  if (/Microsoft.*WARP/i.test(m))                     return 0;
  // Unknown — VRAM-based fallback
  return 0;
}

// ── CPU TDP Lookup ───────────────────────────────────────────────────────────
// Returns the rated TDP (W) for a known CPU model string, or 0 if unknown.
// Covers mobile CPUs (suffix-based) and falls back to tier-based desktop estimates.
function getCpuTdpW(cpuModel) {
  if (!cpuModel) return 0;
  // Normalize: strip parenthetical markers (like "(4 logical cores)")
  // and speed suffixes (like "CPU @ 2.70GHz" or "@ 3.20GHz")
  // Strip trailing parenthetical (e.g. "(4 logical cores)") but NOT (R) or (TM)
  let m = cpuModel.replace(/\s*\([^)]+\)$/, '').replace(/(?: CPU)? @ [\d.]+GHz?$/i, '').trim();

  // ── Unique / extreme TDP models ────────────────────────────────────────────
  if (/i7-49[34]0MX/i.test(m)) return 57;  // Haswell Extreme Edition
  if (/i7-39[24]0XM/i.test(m)) return 55;  // Ivy Bridge Extreme Edition
  if (/i7-4712MQ|i7-4702MQ|i7-4702HQ/i.test(m)) return 37;
  if (/i[357]-4[0-9]{3}M$/i.test(m)) return 37; // Haswell 37W M-series
  if (/Ryzen 7 3750H|Ryzen 5 3550H/i.test(m)) return 35; // AMD Picasso 35W H
  if (/i3-7100H|i3-6100H/i.test(m)) return 35; // low-end H-series 35W
  if (/i7-11390H|i7-11370H|i5-11300H/i.test(m)) return 35; // Tiger Lake H35
  if (/i7-3632QM|i7-3612QM/i.test(m)) return 35; // Ivy Bridge 35W quad
  if (/i3-1115G4$/i.test(m)) return 15;     // Tiger Lake 15W model (others G7/G4 are 28W)
  // AMD Ryzen 9 7945HX3D etc. — 55W, suffix HX3D not at end of model name
  if (/HX3D$/i.test(m)) return 55;
  // AMD Ryzen AI 300 (Strix Point) — 28W, suffix not at end
  if (/Ryzen AI 9 HX 370/i.test(m)) return 28;
  if (/Ryzen AI 9 365/i.test(m)) return 28;
  if (/Ryzen AI 7 PRO 360/i.test(m)) return 28;
  if (/Ryzen AI 7 350/i.test(m)) return 28;
  // Intel Core Ultra 200V (Lunar Lake) — 17W PBP
  if (/Ultra [579][\s-]2[0-9]{2}V$/i.test(m)) return 17;

  // ── Intel Y-series (very low TDP, 4.5-7W) ──────────────────────────────────
  if (/m[357]-7Y3[0-2]|m5-6Y57|m7-6Y75|i[57]-7Y75|i5-7Y54/i.test(m)) return 4.5;
  if (/i[57]-8500Y|i5-8200Y/i.test(m)) return 5;
  if (/i[57]-10510Y|i5-10310Y/i.test(m)) return 7;
  if (/Pentium.*4410Y/i.test(m)) return 6;

  // ── Intel N-series (Alder Lake-N / Jasper Lake, 6-15W) ────────────────────
  if (/N305$/i.test(m)) return 15;
  if (/N300$/i.test(m)) return 7;
  if (/N97$/i.test(m)) return 12;
  if (/N95$/i.test(m)) return 15;
  if (/N200$|N100$|N50$/i.test(m)) return 6;

  // ── Intel J-series (Braswell / Apollo Lake, 6-10W) ─────────────────────────
  if (/J4125|J4105|J4005|J3455|J3355/i.test(m)) return 10;
  if (/J3160|J3060/i.test(m)) return 6;

  // ── AMD A-series / E-series / C-series / Z-series ──────────────────────────
  if (/A10-8700P|E2-7110/i.test(m)) return 12;
  if (/Z-60/i.test(m)) return 5;
  if (/Z-01/i.test(m)) return 6;
  // Standard A-series (A4/A6/A8/A9/A10/A12) — 15W, caught here before /P$/ match
  if (/\bA[4689]|A10|A12\b.*\d.*P$/i.test(m)) return 15; // AMD mobile A-series ending in P
  if (/\bA[4689]|A10|A12\b/i.test(m) && !/K$/i.test(m)) return 15; // Non-K AMD A mobile
  if (/\bE-240\b/i.test(m)) return 18; // AMD E-240
  if (/\bE-350[D]?\b|\bE-450[D]?\b/i.test(m)) return 18; // AMD E-350/450
  if (/\bE-300\b/i.test(m)) return 15; // AMD E-300 (Zacate, 2C)
  if (/\bE2-\d{4}\b/i.test(m)) return 15; // AMD E2-series
  if (/C-[34567]0/i.test(m)) return 9;  // AMD C-series

  // ── Mobile / ULP suffix patterns (key for mobile CPU verification) ────────
  // AMD Ryzen 5000/6000 HX — 45W (not 55W like Intel HX)
  if (/Ryzen [0-9] [56][0-9]{3}HX$/i.test(m)) return 45;
  // HX suffix (Intel 12th+ Gen HX, AMD 7000+ HX) — 55W
  if (/HX$/i.test(m)) return 55;
  // HK suffix (Intel) — 45W (distinct from HX)
  if (/HK$/i.test(m)) return 45;
  // AMD Ryzen 7000/8000 HS — 45W
  if (/Ryzen [0-9] [78][0-9]{3}HS$/i.test(m)) return 45;
  // AMD Ryzen 4000-6000 HS — 35W
  if (/Ryzen [0-9] [456][0-9]{3}HS$/i.test(m)) return 35;
  // Generic HS fallback
  if (/HS$/i.test(m)) return 35;
  // 4th/5th Gen (Haswell/Broadwell) HQ — 47W (distinct from 6th+ Gen 45W)
  if (/i[357]-[45]\d{3}HQ$/i.test(m)) return 47;
  // 4th/5th Gen i5 H (e.g. i5-4200H, i5-5350H) — 47W
  if (/i5-[45]\d{3}H$/i.test(m)) return 47;
  // Standard mobile (H / HQ / QM) — 45W
  if (/H$|HQ$|QM$/i.test(m)) return 45;
  // MQ (Haswell 4th Gen) — 47W
  if (/MQ$/i.test(m)) return 47;
  // Intel P-series (12th+ Gen, e.g. i7-1280P) — 28W
  if (/i[357]-1[0-9]{2,4}P$/i.test(m)) return 28;
  // U-series — 15W
  if (/U$/i.test(m)) return 15;
  // Old M-series (dual-core mobile) — 35W
  if (/M$/i.test(m)) return 35;
  // Y-series fallback — 9W
  if (/Y$/i.test(m)) return 9;
  // Tiger Lake 11th Gen G7/G4 — 28W (i3-1115G4 handled as exception above)
  if (/i[357]-11[0-9]{2}G[74]$/i.test(m)) return 28;
  // Older G-series (Ice Lake 10th Gen and earlier) — 15W
  if (/G[147]$/i.test(m)) return 15;

  // GE-suffix (AMD low-power desktop APU) — 35W, e.g. Ryzen 5 5600GE
  if (/GE$/i.test(m)) return 35;
  // AMD desktop APU (G/GT) — 65W, e.g. Ryzen 5 5600G/5600GT
  if (/GT$/i.test(m)) return 65;
  if (/G$/i.test(m)) return 65;
  // T-suffix (Intel low-power desktop) — 35W, e.g. i5-12400T
  if (/T$/i.test(m)) return 35;
  // ── Intel N / J broad fallback ─────────────────────────────────────────────
  if (/\bN\d{3,4}$/i.test(m)) return 8;
  if (/\bJ\d{4}$/i.test(m)) return 10;

  // ── Apple Silicon ──────────────────────────────────────────────────────────
  if (/M[12] Ultra/i.test(m)) return 100;
  if (/M[34] Ultra/i.test(m)) return 100;
  if (/M4 Max/i.test(m)) return 50;
  if (/M3 Max/i.test(m)) return 92;
  if (/M[12] Max/i.test(m)) return 60;
  if (/M4 Pro/i.test(m)) return 31;
  if (/M3 Pro/i.test(m)) return 35;
  if (/M2 Pro/i.test(m)) return 35;
  if (/M1 Pro/i.test(m)) return 30;
  if (/\bM4\b/i.test(m)) return 20;
  if (/\bM3\b/i.test(m)) return 22;
  if (/\bM2\b/i.test(m)) return 22;
  if (/\bM1\b/i.test(m)) return 20;

  // ── Desktop generational tier-based fallback ──────────────────────────────
  if (/i9|Ryzen 9|Threadripper|Ultra 9[^A-Za-z]/.test(m)) return 125;
  if (/i7|Ryzen 7|Ultra 7[^A-Za-z]/.test(m)) return 95;
  if (/i5|Ryzen 5|Ultra 5[^A-Za-z]/.test(m)) return 75;
  if (/i3|Ryzen 3/.test(m)) return 55;
  if (/Celeron|Pentium|Atom|Athlon/.test(m)) return 35;
  if (/FX-\d{4}|Phenom/.test(m)) return 125; // AMD FX / Phenom desktop
  if (/Xeon|EPYC/.test(m)) return 180;

  return 0; // unknown
}

// ── Minimum ops/ms floor per CPU model ───────────────────────────────────────
// Conservative lower bound on actual Node.js SHA-256 throughput (iterations per
// millisecond) as measured by crypto.createHash('sha256').update(buffer).digest()
// with Buffer.alloc/copy overhead matching the worker's burnCpuOps pattern.
// These values are FALLBACKS used only until the runtime SHA-256 benchmark
// completes (~9 s on startup).  The runtime benchmark overrides these with
// per-machine measured values stored on hwAuthority.sha256OpsPerMs.
//
// Reference: Intel Ivy Bridge (i5-3470) measures ~83 ops/ms (12 μs/op).
// CPUs with SHA-NI (Intel 5th gen+, AMD Zen+) are ~1.5-3x faster for raw
// SHA-256, but the per-call overhead (Buffer.alloc + copy + createHash) dominates
// for the 68-byte input pattern, limiting real-world improvement to ~1.5-2x.
function getMinOpsPerMs(cpuModel) {
  if (!cpuModel) return 40;
  const m = cpuModel;

  // Intel Core Ultra 200S (Arrow Lake Desktop) — SHA-NI, ~2.5x Ivy Bridge
  if (/Core.*Ultra [579].*2[0-9]{2}K/i.test(m)) return 180;
  // Intel Core Ultra 100H/U (Meteor Lake Mobile) — SHA-NI
  if (/Core.*Ultra [579].*1[0-9]{2}[HU]/i.test(m)) return 150;
  // Intel 13th/14th Gen — SHA-NI, ~2x Ivy Bridge
  if (/Core.*i[3579]-1[34]/.test(m)) return 160;
  // Intel 12th Gen — SHA-NI
  if (/Core.*i[3579]-12/.test(m)) return 150;
  // Intel 10th/11th Gen — SHA-NI
  if (/Core.*i[3579]-1[01]/.test(m)) return 140;
  // Intel 8th/9th Gen — SHA-NI
  if (/Core.*i[3579]-[89]/.test(m)) return 130;
  // Intel 7th Gen (Kaby Lake) — SHA-NI
  if (/Core.*i[3579]-7[0-9]{3}/.test(m)) return 100;
  // Intel 6th Gen (Skylake) — SHA-NI
  if (/Core.*i[3579]-6[0-9]{3}/.test(m)) return 100;
  // Intel 5th Gen (Broadwell) — SHA-NI
  if (/Core.*i[57]-5[0-9]{3}/.test(m)) return 95;
  // Intel 4th Gen (Haswell) — no SHA-NI, ~same as Ivy Bridge
  if (/Core.*i[3579]-4[0-9]{3}/.test(m)) return 75;
  // Intel 3rd Gen (Ivy Bridge) — measured: 83 ops/ms, floor: 80
  if (/Core.*i[3579]-3[0-9]{3}/.test(m)) return 80;
  // Intel 2nd Gen (Sandy Bridge) — no SHA-NI, slightly slower than Ivy Bridge
  if (/Core.*i[3579]-2[0-9]{3}/.test(m)) return 60;
  // AMD Ryzen 9000 (Zen 5) — SHA-NI, ~2.5x Ivy Bridge
  if (/Ryzen.*[79].*9[0-9]{3}/i.test(m)) return 180;
  if (/Ryzen.*5.*9[0-9]{3}/i.test(m)) return 150;
  // AMD Ryzen 7000 (Zen 4) — SHA-NI
  if (/Ryzen.*[79].*7[0-9]{3}/i.test(m)) return 160;
  if (/Ryzen.*5.*7[0-9]{3}/i.test(m)) return 140;
  // AMD Ryzen 5000 (Zen 3) — SHA-NI
  if (/Ryzen.*[579].*5[0-9]{3}/i.test(m)) return 140;
  if (/Ryzen.*3.*5[0-9]{3}/i.test(m)) return 110;
  // AMD Ryzen 3000 (Zen 2) — SHA-NI
  if (/Ryzen.*[579].*3[0-9]{3}/i.test(m)) return 120;
  if (/Ryzen.*3.*3[0-9]{3}/i.test(m)) return 100;
  // AMD Ryzen 2000 (Zen+) — SHA-NI
  if (/Ryzen.*[3579].*2[0-9]{3}/i.test(m)) return 90;
  // AMD Threadripper
  if (/Threadripper/.test(m)) return 120;
  // Apple Silicon — ARM SHA2 acceleration, ~2x Ivy Bridge
  if (/M[1-4]/.test(m)) return 150;
  // Xeon / EPYC
  if (/Xeon|EPYC/.test(m)) return 120;
  // Pentium / Celeron / Atom — no SHA-NI, slower
  if (/Pentium|Celeron|Atom/.test(m)) return 50;
  // Unrecognized CPU model — cannot verify, no energy credits
  return 0;
}

// ── Minimum GPU ops/ms floor per GPU model ────────────────────────────────────
// Conservative lower bound on GPU SHA-256 burn throughput (iterations per millisecond).
// Used by the plausibility check to prevent a patched worker from reporting
// artificially low ops to make low-effort proofs pass validation.
// GPUs are massively parallel but SHA-256 burn is sequential per chain;
// throughput depends on how many independent chains the binary runs in parallel.
function getGpuMinOpsPerMs(gpuModel) {
  if (!gpuModel) return 500;
  const m = gpuModel;

  // NVIDIA RTX 40/50 series — high SHA-256 throughput via parallel chains
  if (/RTX.*50[89]0/i.test(m)) return 2000;
  if (/RTX.*5070/i.test(m)) return 1800;
  if (/RTX.*5060/i.test(m)) return 1500;
  if (/RTX.*4090/i.test(m)) return 2000;
  if (/RTX.*4080/i.test(m)) return 1800;
  if (/RTX.*4070/i.test(m)) return 1500;
  if (/RTX.*4060/i.test(m)) return 1200;
  if (/RTX.*4050/i.test(m)) return 1000;

  // NVIDIA RTX 30 series
  if (/RTX.*30[89]0/i.test(m)) return 1500;
  if (/RTX.*3070/i.test(m)) return 1300;
  if (/RTX.*3060/i.test(m)) return 1000;
  if (/RTX.*3050/i.test(m)) return 800;

  // NVIDIA RTX 20 series
  if (/RTX.*20[89]0/i.test(m)) return 1200;
  if (/RTX.*2070/i.test(m)) return 1000;
  if (/RTX.*2060/i.test(m)) return 800;

  // NVIDIA GTX 16 series
  if (/GTX.*16[67]0/i.test(m)) return 700;
  if (/GTX.*1650/i.test(m)) return 500;

  // NVIDIA GTX 10 series
  if (/GTX.*10[89]0/i.test(m)) return 900;
  if (/GTX.*1070/i.test(m)) return 700;
  if (/GTX.*1060/i.test(m)) return 600;
  if (/GTX.*1050/i.test(m)) return 400;

  // AMD RX 9000 series (RDNA 4)
  if (/RX.*9070/i.test(m)) return 1500;

  // AMD RX 7000 series (RDNA 3)
  if (/RX.*79[0-9]{2}/i.test(m)) return 1500;
  if (/RX.*7800/i.test(m)) return 1300;
  if (/RX.*7700/i.test(m)) return 1100;
  if (/RX.*7600/i.test(m)) return 900;

  // AMD RX 6000 series (RDNA 2)
  if (/RX.*69[0-9]{2}/i.test(m)) return 1300;
  if (/RX.*6800/i.test(m)) return 1100;
  if (/RX.*6700/i.test(m)) return 900;
  if (/RX.*6600/i.test(m)) return 700;
  if (/RX.*6500/i.test(m)) return 500;

  // AMD RX 5000 series (RDNA 1)
  if (/RX.*5700/i.test(m)) return 800;
  if (/RX.*5600/i.test(m)) return 700;
  if (/RX.*5500/i.test(m)) return 500;

  // Intel Arc
  if (/Arc.*A[7B]70/i.test(m)) return 1000;
  if (/Arc.*A[7B]50/i.test(m)) return 900;
  if (/Arc.*B580/i.test(m)) return 900;
  if (/Arc.*B570/i.test(m)) return 800;
  if (/Arc.*A580/i.test(m)) return 800;
  if (/Arc.*A[3B]80/i.test(m)) return 600;
  if (/Arc.*A310/i.test(m)) return 400;

  // Unrecognized GPU model — cannot verify, no energy credits
  return 0;
}

module.exports = { getExpectedCpuSpeedOps, getMinOpsPerMs, getGpuMinOpsPerMs, getAsicPowerW, getAsicHashrateTHs, getGpuTdpW, getCpuTdpW };

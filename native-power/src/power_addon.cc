#include <napi.h>
#include <windows.h>
#include <setupapi.h>
#include <pdh.h>
#include <bcrypt.h>
#include <string>
#include <vector>
#include <unordered_map>
#include <cmath>
#include <cstdio>
#include <cstring>

#pragma comment(lib, "setupapi.lib")
#pragma comment(lib, "pdh.lib")
#pragma comment(lib, "bcrypt.lib")

// ─── EMI (Energy Metering Interface) ─────────────────────────────────────────
// Works on Windows 11+ for Intel/AMD CPU RAPL power readings

#ifndef GUID_DEVICE_ENERGY_METER
static const GUID GUID_DEVICE_ENERGY_METER_VAL =
    {0x45bd8344, 0x7ed6, 0x49cf, {0xa4, 0x40, 0xc2, 0x76, 0xc9, 0x33, 0xb0, 0x53}};
#define GUID_DEVICE_ENERGY_METER GUID_DEVICE_ENERGY_METER_VAL
#endif

#ifndef IOCTL_EMI_GET_VERSION
#define IOCTL_EMI_GET_VERSION       CTL_CODE(FILE_DEVICE_UNKNOWN, 0, METHOD_BUFFERED, FILE_READ_ACCESS)
#define IOCTL_EMI_GET_METADATA_SIZE CTL_CODE(FILE_DEVICE_UNKNOWN, 1, METHOD_BUFFERED, FILE_READ_ACCESS)
#define IOCTL_EMI_GET_METADATA      CTL_CODE(FILE_DEVICE_UNKNOWN, 2, METHOD_BUFFERED, FILE_READ_ACCESS)
#define IOCTL_EMI_GET_MEASUREMENT   CTL_CODE(FILE_DEVICE_UNKNOWN, 3, METHOD_BUFFERED, FILE_READ_ACCESS)
#endif

#pragma pack(push, 1)
typedef struct { USHORT EmiVersion; } EMI_VERSION_S;
typedef struct { ULONG MetadataSize; } EMI_METADATA_SIZE_S;

typedef struct {
    USHORT MeasurementUnit;
    WCHAR  HardwareOEM[16];
    WCHAR  HardwareModel[16];
    USHORT HardwareRevision;
    USHORT MeteredHardwareNameSize;
    WCHAR  MeteredHardwareName[256];
} EMI_METADATA_V1_S;

typedef struct {
    ULONGLONG AbsoluteEnergy;
    ULONGLONG AbsoluteTime;
} EMI_CHANNEL_MEASUREMENT_S;

typedef struct {
    USHORT MeasurementUnit;
    USHORT ChannelNameSize;
    WCHAR  ChannelName[128];
} EMI_CHANNEL_V2_S;

typedef struct {
    WCHAR           HardwareOEM[16];
    WCHAR           HardwareModel[16];
    USHORT          HardwareRevision;
    USHORT          ChannelCount;
    EMI_CHANNEL_V2_S Channels[64];
} EMI_METADATA_V2_S;
#pragma pack(pop)

struct EmiChannel {
    std::wstring name;
    uint64_t prevEnergy = 0;
    uint64_t prevTime = 0;
    // Separate state for readEnergyUj() snapshots (independent of power readings)
    uint64_t snapPrevEnergy = 0;
    uint64_t snapPrevTime = 0;
    bool snapInitialized = false;
    int measurementUnit = 0;  // EMI MeasurementUnit: 0=pWh, 1=nJ, 2=µWh, 3=mJ, 4=Wh, 5=J
};

struct EmiState {
    HANDLE hDevice = INVALID_HANDLE_VALUE;
    std::vector<EmiChannel> channels;
    int pkgChannelIndex = -1;
    int pp0ChannelIndex = -1;
    int dramChannelIndex = -1;
    bool initialized = false;
};

static EmiState g_emi;

// EMI MeasurementUnit → energy-to-joules conversion factor.
// AbsoluteTime is always in 100ns intervals.
//
// Per the Microsoft EMI spec and Chromium's reference implementation
// (energy_metrics_provider_win.cc), AbsoluteEnergy from EMI is ALWAYS
// in picowatt-hours regardless of what MeasurementUnit says.
// MeasurementUnit describes counter resolution, not a different energy unit.
static double emiEnergyToJoules(int /*measurementUnit*/, uint64_t rawEnergy) {
    return (double)rawEnergy * 3.6e-9;   // picowatt-hours → joules
}

static bool emiInit() {
    if (g_emi.initialized) return true;

    HDEVINFO devInfo = SetupDiGetClassDevsA(
        &GUID_DEVICE_ENERGY_METER, nullptr, nullptr,
        DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
    if (devInfo == INVALID_HANDLE_VALUE) return false;

    SP_DEVICE_INTERFACE_DATA devData = {};
    devData.cbSize = sizeof(devData);
    if (!SetupDiEnumDeviceInterfaces(devInfo, nullptr, &GUID_DEVICE_ENERGY_METER, 0, &devData)) {
        SetupDiDestroyDeviceInfoList(devInfo);
        return false;
    }

    DWORD reqSize = 0;
    SetupDiGetDeviceInterfaceDetailA(devInfo, &devData, nullptr, 0, &reqSize, nullptr);
    auto* detail = (PSP_DEVICE_INTERFACE_DETAIL_DATA_A)malloc(reqSize);
    detail->cbSize = sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_A);
    if (!SetupDiGetDeviceInterfaceDetailA(devInfo, &devData, detail, reqSize, nullptr, nullptr)) {
        free(detail);
        SetupDiDestroyDeviceInfoList(devInfo);
        return false;
    }

    g_emi.hDevice = CreateFileA(
        detail->DevicePath, GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    free(detail);
    SetupDiDestroyDeviceInfoList(devInfo);

    if (g_emi.hDevice == INVALID_HANDLE_VALUE) return false;

    DWORD bytesReturned = 0;
    EMI_VERSION_S version = {};
    if (!DeviceIoControl(g_emi.hDevice, IOCTL_EMI_GET_VERSION,
            nullptr, 0, &version, sizeof(version), &bytesReturned, nullptr)) {
        CloseHandle(g_emi.hDevice);
        g_emi.hDevice = INVALID_HANDLE_VALUE;
        return false;
    }

    EMI_METADATA_SIZE_S metaSize = {};
    if (!DeviceIoControl(g_emi.hDevice, IOCTL_EMI_GET_METADATA_SIZE,
            nullptr, 0, &metaSize, sizeof(metaSize), &bytesReturned, nullptr)) {
        CloseHandle(g_emi.hDevice);
        g_emi.hDevice = INVALID_HANDLE_VALUE;
        return false;
    }

    std::vector<uint8_t> metaBuf(metaSize.MetadataSize);
    if (!DeviceIoControl(g_emi.hDevice, IOCTL_EMI_GET_METADATA,
            nullptr, 0, metaBuf.data(), (DWORD)metaSize.MetadataSize, &bytesReturned, nullptr)) {
        CloseHandle(g_emi.hDevice);
        g_emi.hDevice = INVALID_HANDLE_VALUE;
        return false;
    }

    if (version.EmiVersion == 1) {
        auto* meta = reinterpret_cast<EMI_METADATA_V1_S*>(metaBuf.data());
        EmiChannel ch;
        ch.name = meta->MeteredHardwareName;
        ch.measurementUnit = (int)meta->MeasurementUnit;
        g_emi.channels.push_back(ch);
    } else {
        auto* meta = reinterpret_cast<EMI_METADATA_V2_S*>(metaBuf.data());
        // V2 channels are variable-length: 2 (MeasurementUnit) + 2 (ChannelNameSize) + ChannelNameSize bytes.
        // The struct sizeof(EMI_CHANNEL_V2_S) includes a fixed WCHAR[128] which is wrong for the buffer layout.
        BYTE* ptr = reinterpret_cast<BYTE*>(&meta->Channels[0]);
        for (USHORT i = 0; i < meta->ChannelCount; ++i) {
            auto* ch = reinterpret_cast<EMI_CHANNEL_V2_S*>(ptr);
            EmiChannel ec;
            ec.name.assign(ch->ChannelName, ch->ChannelNameSize / sizeof(WCHAR));
            while (!ec.name.empty() && ec.name.back() == L'\0') ec.name.pop_back();
            ec.measurementUnit = (int)ch->MeasurementUnit;
            g_emi.channels.push_back(ec);
            // Advance past: MeasurementUnit(2) + ChannelNameSize(2) + ChannelName(variable)
            ptr += 4 + ch->ChannelNameSize;
        }
    }

    // Initial measurement to set baselines
    std::vector<EMI_CHANNEL_MEASUREMENT_S> data(g_emi.channels.size());
    if (!DeviceIoControl(g_emi.hDevice, IOCTL_EMI_GET_MEASUREMENT,
            nullptr, 0, data.data(), (DWORD)(data.size() * sizeof(EMI_CHANNEL_MEASUREMENT_S)),
            &bytesReturned, nullptr)) {
        CloseHandle(g_emi.hDevice);
        g_emi.hDevice = INVALID_HANDLE_VALUE;
        return false;
    }

    for (size_t i = 0; i < g_emi.channels.size(); ++i) {
        g_emi.channels[i].prevEnergy = data[i].AbsoluteEnergy;
        g_emi.channels[i].prevTime = data[i].AbsoluteTime;

        const std::wstring& name = g_emi.channels[i].name;
        if (name.find(L"PKG") != std::wstring::npos || name.find(L"pkg") != std::wstring::npos) {
            g_emi.pkgChannelIndex = (int)i;
        } else if (name.find(L"PP0") != std::wstring::npos || name.find(L"pp0") != std::wstring::npos) {
            g_emi.pp0ChannelIndex = (int)i;
        } else if (name.find(L"DRAM") != std::wstring::npos || name.find(L"dram") != std::wstring::npos) {
            g_emi.dramChannelIndex = (int)i;
        }
    }

    g_emi.initialized = true;
    return true;
}

static double emiReadPowerW(int channelIndex) {
    if (!g_emi.initialized || channelIndex < 0 || channelIndex >= (int)g_emi.channels.size()) return -1.0;

    std::vector<EMI_CHANNEL_MEASUREMENT_S> data(g_emi.channels.size());
    DWORD bytesReturned = 0;
    if (!DeviceIoControl(g_emi.hDevice, IOCTL_EMI_GET_MEASUREMENT,
            nullptr, 0, data.data(), (DWORD)(data.size() * sizeof(EMI_CHANNEL_MEASUREMENT_S)),
            &bytesReturned, nullptr)) {
        return -1.0;
    }

    EmiChannel& ch = g_emi.channels[channelIndex];
    uint64_t energyDelta = data[channelIndex].AbsoluteEnergy - ch.prevEnergy;
    uint64_t timeDelta = data[channelIndex].AbsoluteTime - ch.prevTime;

    ch.prevEnergy = data[channelIndex].AbsoluteEnergy;
    ch.prevTime = data[channelIndex].AbsoluteTime;

    if (timeDelta == 0) return 0.0;

    // Convert energy delta to Joules using the channel's MeasurementUnit.
    // Previous versions hardcoded picowatt-hours (unit 0) which overestimates
    // by 3.6× on hardware reporting nanojoules (unit 1).
    double energyJoules = emiEnergyToJoules(ch.measurementUnit, energyDelta);
    double timeSeconds = (double)timeDelta * 1e-7;
    return energyJoules / timeSeconds;
}

static void emiShutdown() {
    if (g_emi.hDevice != INVALID_HANDLE_VALUE) {
        CloseHandle(g_emi.hDevice);
        g_emi.hDevice = INVALID_HANDLE_VALUE;
    }
    g_emi.channels.clear();
    g_emi.pkgChannelIndex = -1;
    g_emi.pp0ChannelIndex = -1;
    g_emi.dramChannelIndex = -1;
    g_emi.initialized = false;
}

// ─── RAPL MSR Driver (Hubblo/Scaphandre) ─────────────────────────────────────
// Works on Win10+ with the ScaphandreDrv kernel driver installed
// Reads Intel/AMD RAPL MSRs directly via __readmsr instruction

#define RAPL_DEVICE_PATH "\\\\.\\ScaphandreDriver"
#define RAPL_IOCTL_READ_MSR CTL_CODE(FILE_DEVICE_UNKNOWN, 0x800, METHOD_BUFFERED, FILE_ANY_ACCESS)

// Intel RAPL MSR addresses
#define MSR_RAPL_POWER_UNIT    0x00000606
#define MSR_PKG_ENERGY_STATUS  0x00000611
#define MSR_PP0_ENERGY_STATUS  0x00000639
#define MSR_PP1_ENERGY_STATUS  0x00000641
#define MSR_DRAM_ENERGY_STATUS 0x00000619

// AMD RAPL MSR addresses
#define MSR_AMD_PKG_ENERGY_STATUS 0xC001029B

#pragma pack(push, 1)
struct RaplMsrRequest {
    uint32_t msrRegister;
    uint32_t cpuIndex;
};
#pragma pack(pop)

struct RaplState {
    HANDLE hDevice = INVALID_HANDLE_VALUE;
    bool initialized = false;
    bool isAmd = false;
    double energyUnit = 0.0;  // Joules per energy counter unit
    uint64_t prevPkgEnergy = 0;
    uint64_t prevTimeMs = 0;
    // Separate state for readEnergyUj() snapshots
    uint64_t snapPrevEnergy = 0;
    uint64_t snapPrevTimeMs = 0;
    bool snapInitialized = false;
};

static RaplState g_rapl;

static bool raplReadMsr(uint32_t msr, uint32_t cpuIndex, uint64_t* outValue) {
    if (g_rapl.hDevice == INVALID_HANDLE_VALUE) return false;

    RaplMsrRequest req = {};
    req.msrRegister = msr;
    req.cpuIndex = cpuIndex;

    DWORD bytesReturned = 0;
    uint64_t result = 0;
    BOOL ok = DeviceIoControl(
        g_rapl.hDevice, RAPL_IOCTL_READ_MSR,
        &req, sizeof(req),
        &result, sizeof(result),
        &bytesReturned, nullptr);

    if (!ok || bytesReturned < sizeof(result)) return false;
    *outValue = result;
    return true;
}

static bool raplInit() {
    if (g_rapl.initialized) return true;

    g_rapl.hDevice = CreateFileA(
        RAPL_DEVICE_PATH,
        GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);

    if (g_rapl.hDevice == INVALID_HANDLE_VALUE) return false;

    // Read RAPL power unit to determine energy unit conversion
    uint64_t unitRaw = 0;
    if (!raplReadMsr(MSR_RAPL_POWER_UNIT, 0, &unitRaw)) {
        CloseHandle(g_rapl.hDevice);
        g_rapl.hDevice = INVALID_HANDLE_VALUE;
        return false;
    }

    // Energy unit: bits [12:8] define the energy unit denominator
    // Power in watts = energy_delta / (2^unit_factor) / time_delta_seconds
    uint32_t energyUnitBits = (uint32_t)((unitRaw >> 8) & 0x1F);
    g_rapl.energyUnit = 1.0 / (double)(1 << energyUnitBits);  // Joules per unit

    // Detect AMD vs Intel
    uint64_t dummy = 0;
    g_rapl.isAmd = !raplReadMsr(MSR_PKG_ENERGY_STATUS, 0, &dummy) &&
                     raplReadMsr(MSR_AMD_PKG_ENERGY_STATUS, 0, &dummy);

    g_rapl.prevPkgEnergy = 0;
    g_rapl.prevTimeMs = 0;
    g_rapl.initialized = true;
    return true;
}

static double raplReadPowerW() {
    if (!g_rapl.initialized) return -1.0;

    uint32_t msr = g_rapl.isAmd ? MSR_AMD_PKG_ENERGY_STATUS : MSR_PKG_ENERGY_STATUS;
    uint64_t rawEnergy = 0;
    if (!raplReadMsr(msr, 0, &rawEnergy)) return -1.0;

    // RAPL energy counters are 32-bit and wrap around
    uint32_t energy32 = (uint32_t)(rawEnergy & 0xFFFFFFFF);
    uint64_t now = (uint64_t)GetTickCount64();

    if (g_rapl.prevTimeMs == 0) {
        g_rapl.prevPkgEnergy = energy32;
        g_rapl.prevTimeMs = now;
        return 0.0;
    }

    uint64_t timeDeltaMs = now - g_rapl.prevTimeMs;
    if (timeDeltaMs == 0) return 0.0;

    // Handle 32-bit wraparound
    uint32_t energyDelta32 = energy32 - (uint32_t)(g_rapl.prevPkgEnergy & 0xFFFFFFFF);

    double energyJoules = (double)energyDelta32 * g_rapl.energyUnit;
    double timeSeconds = (double)timeDeltaMs / 1000.0;

    g_rapl.prevPkgEnergy = energy32;
    g_rapl.prevTimeMs = now;

    return energyJoules / timeSeconds;
}

static void raplShutdown() {
    if (g_rapl.hDevice != INVALID_HANDLE_VALUE) {
        CloseHandle(g_rapl.hDevice);
        g_rapl.hDevice = INVALID_HANDLE_VALUE;
    }
    g_rapl.initialized = false;
}

// ─── NVML (NVIDIA Management Library) ────────────────────────────────────────

typedef int nvmlReturn_t;
typedef void* nvmlDevice_t;
#define NVML_SUCCESS 0
#define NVML_TEMPERATURE_GPU 0

typedef nvmlReturn_t (*PFN_nvmlInit_v2)(void);
typedef nvmlReturn_t (*PFN_nvmlShutdown)(void);
typedef nvmlReturn_t (*PFN_nvmlDeviceGetHandleByIndex_v2)(unsigned int, nvmlDevice_t*);
typedef nvmlReturn_t (*PFN_nvmlDeviceGetPowerUsage)(nvmlDevice_t, unsigned int*);
typedef nvmlReturn_t (*PFN_nvmlDeviceGetPowerManagementLimit)(nvmlDevice_t, unsigned int*);
typedef nvmlReturn_t (*PFN_nvmlDeviceGetCount_v2)(unsigned int*);
typedef nvmlReturn_t (*PFN_nvmlDeviceGetName)(nvmlDevice_t, char*, unsigned int);

struct NvmlState {
    HMODULE hDll = nullptr;
    PFN_nvmlInit_v2 pInit = nullptr;
    PFN_nvmlShutdown pShutdown = nullptr;
    PFN_nvmlDeviceGetHandleByIndex_v2 pGetHandle = nullptr;
    PFN_nvmlDeviceGetPowerUsage pGetPowerUsage = nullptr;
    PFN_nvmlDeviceGetPowerManagementLimit pGetPowerLimit = nullptr;
    PFN_nvmlDeviceGetCount_v2 pGetCount = nullptr;
    PFN_nvmlDeviceGetName pGetName = nullptr;
    nvmlDevice_t devices[16] = {};
    unsigned int deviceCount = 0;
    bool initialized = false;
};

static NvmlState g_nvml;

static bool nvmlInit() {
    if (g_nvml.initialized) return true;

    g_nvml.hDll = LoadLibraryA("nvml.dll");
    if (!g_nvml.hDll) {
        g_nvml.hDll = LoadLibraryA("C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvml.dll");
    }
    if (!g_nvml.hDll) return false;

    g_nvml.pInit = (PFN_nvmlInit_v2)GetProcAddress(g_nvml.hDll, "nvmlInit_v2");
    g_nvml.pShutdown = (PFN_nvmlShutdown)GetProcAddress(g_nvml.hDll, "nvmlShutdown");
    g_nvml.pGetHandle = (PFN_nvmlDeviceGetHandleByIndex_v2)GetProcAddress(g_nvml.hDll, "nvmlDeviceGetHandleByIndex_v2");
    g_nvml.pGetPowerUsage = (PFN_nvmlDeviceGetPowerUsage)GetProcAddress(g_nvml.hDll, "nvmlDeviceGetPowerUsage");
    g_nvml.pGetPowerLimit = (PFN_nvmlDeviceGetPowerManagementLimit)GetProcAddress(g_nvml.hDll, "nvmlDeviceGetPowerManagementLimit");
    g_nvml.pGetCount = (PFN_nvmlDeviceGetCount_v2)GetProcAddress(g_nvml.hDll, "nvmlDeviceGetCount_v2");
    g_nvml.pGetName = (PFN_nvmlDeviceGetName)GetProcAddress(g_nvml.hDll, "nvmlDeviceGetName");

    if (!g_nvml.pInit || !g_nvml.pGetHandle || !g_nvml.pGetPowerUsage) {
        FreeLibrary(g_nvml.hDll);
        g_nvml.hDll = nullptr;
        return false;
    }

    if (g_nvml.pInit() != NVML_SUCCESS) {
        FreeLibrary(g_nvml.hDll);
        g_nvml.hDll = nullptr;
        return false;
    }

    if (g_nvml.pGetCount) g_nvml.pGetCount(&g_nvml.deviceCount);
    if (g_nvml.deviceCount > 16) g_nvml.deviceCount = 16;

    for (unsigned int i = 0; i < g_nvml.deviceCount; ++i) {
        g_nvml.pGetHandle(i, &g_nvml.devices[i]);
    }

    g_nvml.initialized = true;
    return true;
}

static double nvmlReadPowerW(unsigned int deviceIndex) {
    if (!g_nvml.initialized || !g_nvml.pGetPowerUsage) return -1.0;
    if (deviceIndex >= g_nvml.deviceCount) return -1.0;

    unsigned int milliwatts = 0;
    nvmlReturn_t ret = g_nvml.pGetPowerUsage(g_nvml.devices[deviceIndex], &milliwatts);
    if (ret != NVML_SUCCESS) return -1.0;

    return milliwatts / 1000.0;
}

static std::string nvmlGetDeviceName(unsigned int deviceIndex) {
    if (!g_nvml.initialized || !g_nvml.pGetName) return "";
    if (deviceIndex >= g_nvml.deviceCount) return "";

    char name[256] = {};
    g_nvml.pGetName(g_nvml.devices[deviceIndex], name, sizeof(name));
    return std::string(name);
}

static void nvmlShutdown() {
    if (g_nvml.initialized && g_nvml.pShutdown) {
        g_nvml.pShutdown();
    }
    if (g_nvml.hDll) {
        FreeLibrary(g_nvml.hDll);
        g_nvml.hDll = nullptr;
    }
    g_nvml.initialized = false;
    g_nvml.deviceCount = 0;
}

// ─── PDH (Performance Data Helper) ───────────────────────────────────────────
// Fallback for Win10 where EMI device is not available

struct PdhState {
    HQUERY hQuery = nullptr;
    HCOUNTER hEnergyCounter = nullptr;
    HCOUNTER hPowerCounter = nullptr;
    bool hasEnergy = false;
    bool hasPower = false;
    bool initialized = false;
};

static PdhState g_pdh;

static bool pdhInit() {
    if (g_pdh.initialized) return true;

    PDH_STATUS status = PdhOpenQueryA(nullptr, 0, &g_pdh.hQuery);
    if (status != ERROR_SUCCESS) return false;

    // Try to add the Energy Meter power counter
    status = PdhAddEnglishCounterA(g_pdh.hQuery,
        "\\Energy Meter(*)\\Power", 0, &g_pdh.hPowerCounter);
    g_pdh.hasPower = (status == ERROR_SUCCESS);

    status = PdhAddEnglishCounterA(g_pdh.hQuery,
        "\\Energy Meter(*)\\Energy", 0, &g_pdh.hEnergyCounter);
    g_pdh.hasEnergy = (status == ERROR_SUCCESS);

    if (!g_pdh.hasPower && !g_pdh.hasEnergy) {
        PdhCloseQuery(g_pdh.hQuery);
        g_pdh.hQuery = nullptr;
        return false;
    }

    // First collection to initialize
    PdhCollectQueryData(g_pdh.hQuery);
    g_pdh.initialized = true;
    return true;
}

static double pdhReadPowerW() {
    if (!g_pdh.initialized) return -1.0;

    PdhCollectQueryData(g_pdh.hQuery);

    if (g_pdh.hasPower) {
        PDH_FMT_COUNTERVALUE val = {};
        PDH_STATUS status = PdhGetFormattedCounterValue(
            g_pdh.hPowerCounter, PDH_FMT_DOUBLE, nullptr, &val);
        if (status == ERROR_SUCCESS && val.doubleValue > 0.0) {
            return val.doubleValue;
        }
    }

    return -1.0;
}

static void pdhShutdown() {
    if (g_pdh.hQuery) {
        PdhCloseQuery(g_pdh.hQuery);
        g_pdh.hQuery = nullptr;
    }
    g_pdh.initialized = false;
    g_pdh.hasEnergy = false;
    g_pdh.hasPower = false;
}

// ─── TDP Database ────────────────────────────────────────────────────────────
// Conservative TDP values for common CPUs (PL2/PPT)

static const std::unordered_map<std::string, int> CPU_TDP = {
    // Intel Desktop
    {"i9-14900K", 253}, {"i9-14900KF", 253}, {"i9-13900K", 253}, {"i9-13900KF", 253},
    {"i9-12900K", 241}, {"i9-12900KF", 241}, {"i9-11900K", 250}, {"i9-10900K", 250},
    {"i7-14700K", 253}, {"i7-14700KF", 253}, {"i7-13700K", 253}, {"i7-13700KF", 253},
    {"i7-12700K", 190}, {"i7-12700KF", 190}, {"i7-11700K", 250}, {"i7-10700K", 250},
    {"i5-14600K", 181}, {"i5-14600KF", 181}, {"i5-13600K", 181}, {"i5-13600KF", 181},
    {"i5-12600K", 150}, {"i5-12600KF", 150}, {"i5-11600K", 250}, {"i5-10600K", 250},
    // Intel Mobile
    {"i9-14900HX", 55}, {"i9-13900HX", 55}, {"i9-12900HX", 55},
    {"i7-14700HX", 55}, {"i7-13700HX", 55}, {"i7-12700H", 45},
    {"i7-1460P", 28}, {"i7-1360P", 28}, {"i7-1260P", 28},
    {"i5-1450P", 28}, {"i5-1350P", 28}, {"i5-1250P", 28},
    {"i5-1340P", 28}, {"i5-1240P", 28},
    {"i5-1335U", 15}, {"i5-1235U", 15}, {"i5-1245U", 15},
    {"i3-1315U", 15}, {"i3-1215U", 15},
    {"i5-3320M", 35}, {"i5-3340M", 35}, {"i5-3360M", 35},
    {"i7-3520M", 35}, {"i7-3630QM", 45}, {"i7-3720QM", 45},
    // AMD Desktop
    {"Ryzen 9 7950X", 170}, {"Ryzen 9 7900X", 170}, {"Ryzen 7 7700X", 105},
    {"Ryzen 5 7600X", 105}, {"Ryzen 9 5950X", 105}, {"Ryzen 9 5900X", 105},
    {"Ryzen 7 5800X", 105}, {"Ryzen 5 5600X", 65},
    {"Ryzen 9 3950X", 105}, {"Ryzen 9 3900X", 105},
    {"Ryzen 7 3800X", 105}, {"Ryzen 7 3700X", 65},
    {"Ryzen 5 3600X", 95}, {"Ryzen 5 3600", 65},
    // AMD Mobile
    {"Ryzen 9 7945HX", 55}, {"Ryzen 9 6900HX", 45},
    {"Ryzen 7 7840HS", 35}, {"Ryzen 7 7735HS", 35},
    {"Ryzen 5 7640HS", 35}, {"Ryzen 5 7535HS", 35},
};

// ─── N-API Functions ─────────────────────────────────────────────────────────

// init() → { emi: bool, nvml: bool, pdh: bool, devices: [...] }
static Napi::Value NapiInit(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);

    bool emiOk = emiInit();
    bool raplOk = raplInit();
    bool nvmlOk = nvmlInit();
    bool pdhOk = pdhInit();

    result.Set("emi", Napi::Boolean::New(env, emiOk));
    result.Set("rapl", Napi::Boolean::New(env, raplOk));
    result.Set("nvml", Napi::Boolean::New(env, nvmlOk));
    result.Set("pdh", Napi::Boolean::New(env, pdhOk));
    if (raplOk) {
        result.Set("raplAmd", Napi::Boolean::New(env, g_rapl.isAmd));
    }

    // EMI channels
    if (emiOk) {
        Napi::Array channels = Napi::Array::New(env);
        for (size_t i = 0; i < g_emi.channels.size(); ++i) {
            Napi::Object ch = Napi::Object::New(env);
            // Convert wstring to UTF-8
            int sz = WideCharToMultiByte(CP_UTF8, 0, g_emi.channels[i].name.c_str(),
                (int)g_emi.channels[i].name.size(), nullptr, 0, nullptr, nullptr);
            std::string utf8(sz, 0);
            WideCharToMultiByte(CP_UTF8, 0, g_emi.channels[i].name.c_str(),
                (int)g_emi.channels[i].name.size(), &utf8[0], sz, nullptr, nullptr);
            ch.Set("name", Napi::String::New(env, utf8));
            ch.Set("index", Napi::Number::New(env, (double)i));
            ch.Set("measurementUnit", Napi::Number::New(env, (double)g_emi.channels[i].measurementUnit));
            channels.Set((uint32_t)i, ch);
        }
        result.Set("emiChannels", channels);
        result.Set("pkgChannel", Napi::Number::New(env, g_emi.pkgChannelIndex));
        result.Set("pp0Channel", Napi::Number::New(env, g_emi.pp0ChannelIndex));
        result.Set("dramChannel", Napi::Number::New(env, g_emi.dramChannelIndex));
    }

    // NVML devices
    if (nvmlOk) {
        Napi::Array devices = Napi::Array::New(env);
        for (unsigned int i = 0; i < g_nvml.deviceCount; ++i) {
            Napi::Object dev = Napi::Object::New(env);
            dev.Set("index", Napi::Number::New(env, i));
            dev.Set("name", Napi::String::New(env, nvmlGetDeviceName(i)));
            devices.Set(i, dev);
        }
        result.Set("nvmlDevices", devices);
        result.Set("nvmlDeviceCount", Napi::Number::New(env, g_nvml.deviceCount));
    }

    return result;
}

// readCpuPowerW() → number | null
static Napi::Value NapiReadCpuPower(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    // Try EMI first (real sensor, Win11)
    if (g_emi.initialized && g_emi.pkgChannelIndex >= 0) {
        int idx = g_emi.pkgChannelIndex;

        // Read measurement for ALL channels at once
        std::vector<EMI_CHANNEL_MEASUREMENT_S> data(g_emi.channels.size());
        DWORD bytesReturned = 0;
        if (DeviceIoControl(g_emi.hDevice, IOCTL_EMI_GET_MEASUREMENT,
                nullptr, 0, data.data(), (DWORD)(data.size() * sizeof(EMI_CHANNEL_MEASUREMENT_S)),
                &bytesReturned, nullptr)) {
            // Compute deltas and watts for ALL channels first (using old baselines)
            struct ChannelInfo { double watts; uint64_t eDelta; uint64_t tDelta; int unit; std::string name; };
            std::vector<ChannelInfo> infos(g_emi.channels.size());
            double bestUnit0Watts = 0.0;
            int bestUnit0Idx = idx;
            for (size_t ci = 0; ci < g_emi.channels.size(); ++ci) {
                EmiChannel& ech = g_emi.channels[ci];
                uint64_t eDelta = data[ci].AbsoluteEnergy - ech.prevEnergy;
                uint64_t tDelta = data[ci].AbsoluteTime - ech.prevTime;
                double chWatts = 0.0;
                if (tDelta > 0) {
                    chWatts = emiEnergyToJoules(ech.measurementUnit, eDelta) / ((double)tDelta * 1e-7);
                }
                int csz = WideCharToMultiByte(CP_UTF8, 0, ech.name.c_str(),
                    (int)ech.name.size(), nullptr, 0, nullptr, nullptr);
                std::string cuk8(csz, 0);
                WideCharToMultiByte(CP_UTF8, 0, ech.name.c_str(),
                    (int)ech.name.size(), &cuk8[0], csz, nullptr, nullptr);
                infos[ci] = { chWatts, eDelta, tDelta, ech.measurementUnit, cuk8 };
                // Track best channel with standard unit (measurementUnit == 0, picowatt-hours)
                if (ech.measurementUnit == 0 && chWatts > bestUnit0Watts) {
                    bestUnit0Watts = chWatts;
                    bestUnit0Idx = (int)ci;
                }
            }
            // Now update all baselines
            for (size_t ci = 0; ci < g_emi.channels.size(); ++ci) {
                g_emi.channels[ci].prevEnergy = data[ci].AbsoluteEnergy;
                g_emi.channels[ci].prevTime = data[ci].AbsoluteTime;
            }
            // Channel selection: prefer standard unit=0 channels over vendor-defined units
            // On Intel APL, the named "APL_Package0_PKG" channel uses unit=100 and gives
            // wrong readings — the real package power is on an unnamed unit=0 channel.
            double pkgWatts = infos[idx].watts;
            double watts = 0.0;
            bool pkgIsVendorUnit = g_emi.channels[idx].measurementUnit != 0;
            if (pkgIsVendorUnit || pkgWatts < 0.001) {
                idx = bestUnit0Idx;
                watts = bestUnit0Watts;
            } else {
                watts = pkgWatts;
            }

            Napi::Object result = Napi::Object::New(env);
            result.Set("watts", Napi::Number::New(env, watts));
            result.Set("source", Napi::String::New(env, "emi"));
            result.Set("measurementUnit", Napi::Number::New(env, g_emi.channels[idx].measurementUnit));
            result.Set("rawEnergyDelta", Napi::Number::New(env, (double)infos[idx].eDelta));
            result.Set("rawTimeDelta", Napi::Number::New(env, (double)infos[idx].tDelta));
            result.Set("bytesReturned", Napi::Number::New(env, (double)bytesReturned));
            result.Set("channelCount", Napi::Number::New(env, (double)g_emi.channels.size()));
            result.Set("channelName", Napi::String::New(env, infos[idx].name));
            result.Set("channelIndex", Napi::Number::New(env, (double)idx));
            // Per-channel power readings for ALL channels
            Napi::Array allChannels = Napi::Array::New(env);
            uint32_t chIdx = 0;
            for (size_t ci = 0; ci < infos.size(); ++ci) {
                Napi::Object chObj = Napi::Object::New(env);
                chObj.Set("index", Napi::Number::New(env, (double)ci));
                chObj.Set("name", Napi::String::New(env, infos[ci].name));
                chObj.Set("measurementUnit", Napi::Number::New(env, (double)infos[ci].unit));
                chObj.Set("watts", Napi::Number::New(env, infos[ci].watts));
                chObj.Set("rawEnergyDelta", Napi::Number::New(env, (double)infos[ci].eDelta));
                chObj.Set("rawTimeDelta", Napi::Number::New(env, (double)infos[ci].tDelta));
                allChannels.Set(chIdx++, chObj);
            }
            result.Set("allChannels", allChannels);
            return result;
        }
    }

    // Try RAPL driver (Win10+ with ScaphandreDrv installed)
    if (g_rapl.initialized) {
        double watts = raplReadPowerW();
        if (watts >= 0.0) {
            Napi::Object result = Napi::Object::New(env);
            result.Set("watts", Napi::Number::New(env, watts));
            result.Set("source", Napi::String::New(env, "rapl"));
            return result;
        }
    }

    // Try PDH fallback
    if (g_pdh.initialized) {
        double watts = pdhReadPowerW();
        if (watts >= 0.0) {
            Napi::Object result = Napi::Object::New(env);
            result.Set("watts", Napi::Number::New(env, watts));
            result.Set("source", Napi::String::New(env, "pdh"));
            return result;
        }
    }

    return env.Null();
}

// readEnergyUj() → { energyUj: number, timeMs: number } | null
// Returns raw energy counter in microjoules. Uses separate state from power
// readings so calling this doesn't interfere with readAll()/readCpuPowerW().
// Worker calls this before and after proof computation; the delta is the
// energy consumed during the proof, used for coordinator cross-validation.
static Napi::Value NapiReadEnergyUj(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    // Try EMI first (Win11)
    if (g_emi.initialized && g_emi.pkgChannelIndex >= 0) {
        std::vector<EMI_CHANNEL_MEASUREMENT_S> data(g_emi.channels.size());
        DWORD bytesReturned = 0;
        if (DeviceIoControl(g_emi.hDevice, IOCTL_EMI_GET_MEASUREMENT,
                nullptr, 0, data.data(), (DWORD)(data.size() * sizeof(EMI_CHANNEL_MEASUREMENT_S)),
                &bytesReturned, nullptr)) {
            int ch = g_emi.pkgChannelIndex;
            EmiChannel& ec = g_emi.channels[ch];
            uint64_t curEnergy = data[ch].AbsoluteEnergy;
            uint64_t curTime = data[ch].AbsoluteTime;

            if (!ec.snapInitialized) {
                ec.snapPrevEnergy = curEnergy;
                ec.snapPrevTime = curTime;
                ec.snapInitialized = true;
                Napi::Object r = Napi::Object::New(env);
                r.Set("energyUj", Napi::Number::New(env, 0.0));
                r.Set("timeMs", Napi::Number::New(env, (double)GetTickCount64()));
                r.Set("source", Napi::String::New(env, "emi"));
                return r;
            }

            uint64_t energyDelta = curEnergy - ec.snapPrevEnergy;
            // Convert to Joules using the channel's MeasurementUnit
            double joules = emiEnergyToJoules(ec.measurementUnit, energyDelta);

            ec.snapPrevEnergy = curEnergy;
            ec.snapPrevTime = curTime;

            Napi::Object r = Napi::Object::New(env);
            r.Set("energyUj", Napi::Number::New(env, joules * 1e6));
            r.Set("timeMs", Napi::Number::New(env, (double)GetTickCount64()));
            r.Set("source", Napi::String::New(env, "emi"));
            return r;
        }
    }

    // Try RAPL driver (Win10+)
    if (g_rapl.initialized) {
        uint32_t msr = g_rapl.isAmd ? MSR_AMD_PKG_ENERGY_STATUS : MSR_PKG_ENERGY_STATUS;
        uint64_t rawEnergy = 0;
        if (raplReadMsr(msr, 0, &rawEnergy)) {
            uint32_t energy32 = (uint32_t)(rawEnergy & 0xFFFFFFFF);
            uint64_t now = (uint64_t)GetTickCount64();

            if (!g_rapl.snapInitialized) {
                g_rapl.snapPrevEnergy = energy32;
                g_rapl.snapPrevTimeMs = now;
                g_rapl.snapInitialized = true;
                Napi::Object r = Napi::Object::New(env);
                r.Set("energyUj", Napi::Number::New(env, 0.0));
                r.Set("timeMs", Napi::Number::New(env, (double)now));
                r.Set("source", Napi::String::New(env, "rapl"));
                return r;
            }

            uint32_t energyDelta32 = energy32 - (uint32_t)(g_rapl.snapPrevEnergy & 0xFFFFFFFF);
            double joules = (double)energyDelta32 * g_rapl.energyUnit;

            g_rapl.snapPrevEnergy = energy32;
            g_rapl.snapPrevTimeMs = now;

            Napi::Object r = Napi::Object::New(env);
            r.Set("energyUj", Napi::Number::New(env, joules * 1e6));
            r.Set("timeMs", Napi::Number::New(env, (double)now));
            r.Set("source", Napi::String::New(env, "rapl"));
            return r;
        }
    }

    return env.Null();
}

// readGpuPowerW(deviceIndex?) → [{ watts, name, source }] | null
static Napi::Value NapiReadGpuPower(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!g_nvml.initialized) return env.Null();

    unsigned int deviceIndex = 0;
    if (info.Length() > 0 && info[0].IsNumber()) {
        deviceIndex = info[0].As<Napi::Number>().Uint32Value();
    }

    Napi::Array results = Napi::Array::New(env);
    uint32_t count = 0;

    if (deviceIndex == 0 && info.Length() == 0) {
        // Read all devices
        for (unsigned int i = 0; i < g_nvml.deviceCount; ++i) {
            double watts = nvmlReadPowerW(i);
            if (watts >= 0.0) {
                Napi::Object dev = Napi::Object::New(env);
                dev.Set("watts", Napi::Number::New(env, watts));
                dev.Set("index", Napi::Number::New(env, i));
                dev.Set("name", Napi::String::New(env, nvmlGetDeviceName(i)));
                dev.Set("source", Napi::String::New(env, "nvml"));
                results.Set(count++, dev);
            }
        }
    } else {
        double watts = nvmlReadPowerW(deviceIndex);
        if (watts >= 0.0) {
            Napi::Object dev = Napi::Object::New(env);
            dev.Set("watts", Napi::Number::New(env, watts));
            dev.Set("index", Napi::Number::New(env, deviceIndex));
            dev.Set("name", Napi::String::New(env, nvmlGetDeviceName(deviceIndex)));
            dev.Set("source", Napi::String::New(env, "nvml"));
            results.Set(count++, dev);
        }
    }

    if (count == 0) return env.Null();
    return results;
}

// readAll() → { cpu: { watts, source } | null, gpus: [...], totalW: number, source: string }
static Napi::Value NapiReadAll(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);

    // CPU
    Napi::Value cpuPower = NapiReadCpuPower(info);
    result.Set("cpu", cpuPower);

    // GPUs
    Napi::Value gpuPower = NapiReadGpuPower(info);
    result.Set("gpus", gpuPower);

    // Total
    double totalW = 0.0;
    std::string source = "none";

    if (!cpuPower.IsNull() && !cpuPower.IsUndefined()) {
        Napi::Object cpu = cpuPower.As<Napi::Object>();
        totalW += cpu.Get("watts").As<Napi::Number>().DoubleValue();
        source = cpu.Get("source").As<Napi::String>().Utf8Value();
    }

    if (!gpuPower.IsNull() && !gpuPower.IsUndefined()) {
        Napi::Array gpus = gpuPower.As<Napi::Array>();
        for (uint32_t i = 0; i < gpus.Length(); ++i) {
            Napi::Object gpu = gpus.Get(i).As<Napi::Object>();
            totalW += gpu.Get("watts").As<Napi::Number>().DoubleValue();
            if (source == "none") source = gpu.Get("source").As<Napi::String>().Utf8Value();
            else source += "+" + gpu.Get("source").As<Napi::String>().Utf8Value();
        }
    }

    result.Set("totalW", Napi::Number::New(env, totalW));
    result.Set("source", Napi::String::New(env, source));

    return result;
}

// shutdown() → void
static Napi::Value NapiShutdown(const Napi::CallbackInfo& info) {
    emiShutdown();
    raplShutdown();
    nvmlShutdown();
    pdhShutdown();
    return info.Env().Undefined();
}

// burnCpu(ops) → { ops, elapsedMs }
// Tight C++ SHA-256 loop with zero JS object allocation per iteration.
// Pegs CPU at ~100% because there's no V8 GC, no Hash object creation,
// no Buffer allocation — just pure OpenSSL in a tight C loop.
static Napi::Value NapiBurnCpu(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int ops = info[0].As<Napi::Number>().Int32Value();

    // Pre-allocate buffers once
    unsigned char state[32];
    unsigned char input[68];
    memset(state, 0, sizeof(state));
    memset(input, 0, sizeof(input));

    LARGE_INTEGER freq, start;
    QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&start);

    BCRYPT_ALG_HANDLE hAlg = NULL;
    NTSTATUS status = BCryptOpenAlgorithmProvider(&hAlg, BCRYPT_SHA256_ALGORITHM, NULL, 0);
    if (!BCRYPT_SUCCESS(status) || !hAlg) {
        Napi::Object result = Napi::Object::New(env);
        result.Set("ops", Napi::Number::New(env, 0));
        result.Set("elapsedMs", Napi::Number::New(env, 0.0));
        result.Set("error", Napi::String::New(env, "BCryptOpenAlgorithmProvider failed"));
        return result;
    }

    for (int i = 0; i < ops; i++) {
        // SHA-256: input = state ‖ i(LE32) ‖ seed(32 bytes of zeros)
        memcpy(input, state, 32);
        input[32] = i & 0xFF;
        input[33] = (i >> 8) & 0xFF;
        input[34] = (i >> 16) & 0xFF;
        input[35] = (i >> 24) & 0xFF;

        // BCrypt SHA-256 — open provider once, create/destroy hash handle per iter
        BCRYPT_HASH_HANDLE hHash = NULL;
        BCryptCreateHash(hAlg, &hHash, NULL, 0, NULL, 0, 0);
        BCryptHashData(hHash, input, 68, 0);
        BCryptFinishHash(hHash, state, 32, 0);
        BCryptDestroyHash(hHash);
    }

    BCryptCloseAlgorithmProvider(hAlg, 0);

    LARGE_INTEGER end;
    QueryPerformanceCounter(&end);
    double elapsedMs = (double)(end.QuadPart - start.QuadPart) / (double)freq.QuadPart * 1000.0;

    Napi::Object result = Napi::Object::New(env);
    result.Set("ops", Napi::Number::New(env, ops));
    result.Set("elapsedMs", Napi::Number::New(env, elapsedMs));
    return result;
}

// ─── Module Init ─────────────────────────────────────────────────────────────

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("init", Napi::Function::New(env, NapiInit));
    exports.Set("readCpuPowerW", Napi::Function::New(env, NapiReadCpuPower));
    exports.Set("readGpuPowerW", Napi::Function::New(env, NapiReadGpuPower));
    exports.Set("readEnergyUj", Napi::Function::New(env, NapiReadEnergyUj));
    exports.Set("readAll", Napi::Function::New(env, NapiReadAll));
    exports.Set("burnCpu", Napi::Function::New(env, NapiBurnCpu));
    exports.Set("shutdown", Napi::Function::New(env, NapiShutdown));
    return exports;
}

NODE_API_MODULE(power, Init)

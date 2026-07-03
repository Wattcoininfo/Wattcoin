// Native GPU Miner — Multi-DirectX Backend (D3D9 / D3D10 / D3D11 / D3D12)
// Windows-only. Compiled with MSVC. Communicates via stdin/stdout JSON.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <io.h>
#include <fcntl.h>
#include <assert.h>
#include <mmsystem.h>
#pragma comment(lib, "winmm.lib")

// ── DXGI adapter enumeration (shared across D3D10/11/12) ──────────────────
#include <dxgi1_6.h>
#pragma comment(lib, "dxgi.lib")

// ── D3D11 ─────────────────────────────────────────────────────────────────
#include <d3d11.h>
#include <d3d11_1.h>
#include <d3dcompiler.h>
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "d3dcompiler.lib")
#pragma comment(lib, "dxguid.lib")

// ── D3D10 ─────────────────────────────────────────────────────────────────
#include <d3d10_1.h>
#pragma comment(lib, "d3d10.lib")

// ── D3D9 ─────────────────────────────────────────────────────────────────
#include <d3d9.h>
#pragma comment(lib, "d3d9.lib")

// ── Generated shader source strings ───────────────────────────────────────
#include "gen/shaders.c"
#include "gen/shaders_d3d9.c"   // D3D9 pixel shaders

// ── Constants ─────────────────────────────────────────────────────────────
#define TIMER_FLOOR_MS 1.0
#define MAX_ADAPTERS 32
// ── Types ─────────────────────────────────────────────────────────────────
typedef enum {
    BACKEND_NONE = 0,
    BACKEND_D3D9,
    BACKEND_D3D10,
    BACKEND_D3D11,
    BACKEND_D3D12,
} BackendType;

typedef struct {
    BackendType type;
    int        adapterIndex;
    char       adapterName[256];
    int        isDiscrete;
    uint64_t   dedicatedBytes;
    uint32_t   vendorId;
    uint32_t   deviceId;
    int        featureLevelMajor;
    int        featureLevelMinor;
    char       backendStr[16];
} GpuInfo;

// ── Global state ──────────────────────────────────────────────────────────
static HANDLE         g_stdin;
static HANDLE         g_stdout;
static int            g_running;
static double         g_loadFrac;    // 0.0 – 1.0
static double         g_measDuty;

// Backend function pointers
static int      (*g_init)(int adapterIdx, GpuInfo *info);
static void     (*g_shutdown)(void);
static void     (*g_dispatch_load)(uint32_t w, uint32_t h, uint32_t iters, double param);
static uint32_t (*g_dispatch_proof)(uint32_t seed, uint32_t w, uint32_t h, uint32_t iters, double *elapsedMs);
static int (*g_dispatch_pow)(uint32_t seed, uint32_t difficulty, uint32_t startNonce, uint32_t *outNonce, uint32_t *outHash, double *elapsedMs);
static GpuInfo   g_info;
static int       g_gpuReady; // set after select_gpu() succeeds

static void debug_out(const char *msg) {
    HANDLE h = GetStdHandle(STD_ERROR_HANDLE);
    DWORD w;
    WriteFile(h, msg, (DWORD)strlen(msg), &w, NULL);
}

static void ods_out(const char *msg) {
    OutputDebugStringA(msg);
}

static double now_ms(void) {
    LARGE_INTEGER f, c;
    QueryPerformanceFrequency(&f);
    QueryPerformanceCounter(&c);
    return (double)c.QuadPart * 1000.0 / (double)f.QuadPart;
}

static void json_out(const char *fmt, ...) {
    char buf[8192 + 4];
    int n;
    va_list ap;
    va_start(ap, fmt);
    n = vsnprintf(buf, sizeof(buf) - 4, fmt, ap);
    va_end(ap);
    if (n > 0) {
        buf[n] = '\n';
        n++;
        DWORD w;
        WriteFile(g_stdout, buf, n, &w, NULL);
    }
}

// ── Safe init-with-timeout (no TerminateThread) ──────────────────────────
// Some GPU drivers hang on D3D11CreateDevice/D3D12CreateDevice.
// We run the call on a helper thread and abandon it on timeout
// rather than corrupting driver state with TerminateThread.
struct TimeoutCtx {
    int (*fn)(int, GpuInfo*);
    int adapterIdx;
    GpuInfo *info; // heap-allocated; leaked on timeout
    int result;    // 0=running, 1=success, -1=failed
    HANDLE done;
};

static DWORD WINAPI timeout_thread_fn(LPVOID p) {
    TimeoutCtx *ctx = (TimeoutCtx*)p;
    int r = ctx->fn(ctx->adapterIdx, ctx->info);
    ctx->result = r ? 1 : -1;
    SetEvent(ctx->done);
    return 0;
}

static int try_init_timeout(int (*fn)(int, GpuInfo*), int adapterIdx, GpuInfo *out, DWORD timeoutMs) {
    GpuInfo *tmp = (GpuInfo*)malloc(sizeof(GpuInfo));
    if (!tmp) return 0;
    memset(tmp, 0, sizeof(GpuInfo));
    HANDLE done = CreateEventA(NULL, TRUE, FALSE, NULL);
    if (!done) { free(tmp); return 0; }
    TimeoutCtx ctx = { fn, adapterIdx, tmp, 0, done };
    HANDLE hThread = CreateThread(NULL, 0, timeout_thread_fn, &ctx, 0, NULL);
    if (!hThread) { CloseHandle(done); free(tmp); return 0; }

    HANDLE wa[2] = { hThread, done };
    DWORD wait = WaitForMultipleObjects(2, wa, FALSE, timeoutMs);
    if (wait == WAIT_TIMEOUT) {
        // Thread abandoned — safe without TerminateThread.
        // tmp leaks (few hundred bytes), orphan thread runs to completion harmlessly.
        CloseHandle(hThread);
        CloseHandle(done);
        return -1;
    }
    // Thread completed normally
    int ok = (ctx.result == 1);
    if (ok) *out = *tmp;
    free(tmp);
    CloseHandle(hThread);
    CloseHandle(done);
    return ok;
}

// ── D3D11 Backend ─────────────────────────────────────────────────────────
static ID3D11Device            *g_dev11       = NULL;
static ID3D11DeviceContext     *g_ctx11       = NULL;
static ID3D11DeviceContext1    *g_ctx11_1     = NULL;
static ID3D11ComputeShader     *g_loadCS11    = NULL;
static ID3D11ComputeShader     *g_proofCS11   = NULL;
static ID3D11Buffer            *g_cb11        = NULL;
static ID3D11Buffer            *g_loadBuf11   = NULL;
static ID3D11UnorderedAccessView *g_loadUAV11 = NULL;
static ID3D11Buffer            *g_proofBuf11  = NULL;
static ID3D11UnorderedAccessView *g_proofUAV11= NULL;
static ID3D11Buffer            *g_staging11   = NULL;
static ID3D11Query             *g_fence11     = NULL;
static ID3D11ComputeShader     *g_powCS11     = NULL;
static ID3D11Buffer            *g_powOutBuf11  = NULL;
static ID3D11UnorderedAccessView *g_powOutUAV11 = NULL;
static ID3D11Buffer            *g_powStaging11  = NULL;

static ID3DBlob *compile_cs11(const char *src, const char *entry) {
    ID3DBlob *code = NULL, *err = NULL;
    HRESULT hr = D3DCompile(src, strlen(src), NULL, NULL, NULL,
                            entry, "cs_5_0", D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &code, &err);
    if (FAILED(hr)) {
        // Try cs_4_0 for older hardware
        hr = D3DCompile(src, strlen(src), NULL, NULL, NULL,
                        entry, "cs_4_0", D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &code, &err);
    }
    if (FAILED(hr)) {
        const char *msg = err ? (const char *)err->GetBufferPointer() : "unknown";
        fprintf(stderr, "D3D11 HLSL compile error (%s): %s\n", entry, msg);
        if (err) err->Release();
        return NULL;
    }
    if (err) err->Release();
    return code;
}

// ── PoW HLSL compute shader (embedded string) ──────────────────────────
// NOTE: iterations reduced to 10 for testing; real value is 50000
static const char *g_pow_hlsl =
    "RWStructuredBuffer<uint> output : register(u0);\n"
    "cbuffer cb : register(b0) { uint seed; uint difficulty; uint startNonce; uint _pad; };\n"
    "[numthreads(16,16,1)]\n"
    "void CSMain(uint3 id : SV_DispatchThreadID) {\n"
    "  uint gid = id.x + id.y * 256;\n"
    "  uint nonce = startNonce + gid;\n"
    "  uint s = seed ^ (nonce * 1000003u) ^ ((nonce >> 16) * 7919u);\n"
    "  s |= 1;\n"
    "  uint h = 5381;\n"
    "  for (uint p = 0; p < 1024; p += 4) {\n"
    "    uint row = p / 32;\n"
    "    uint col = p % 32;\n"
    "    int x = (int)((col * 1000003) ^ (row * 7919) ^ s);\n"
    "    x |= 1;\n"
    "    for (uint i = 0; i < 50000; i++) {\n"
    "      x ^= x << 13;\n"
    "      x ^= x >> 17;\n"
    "      x ^= x << 5;\n"
    "    }\n"
    "    h = ((h << 5) + h + ((x >> 24) & 255));\n"
    "    h = ((h << 5) + h + ((x >> 16) & 255));\n"
    "    h = ((h << 5) + h + ((x >> 8) & 255));\n"
    "    h = ((h << 5) + h + (x & 255));\n"
    "  }\n"
    "  if ((h & 0xFFFF) < difficulty)\n"
    "    output[gid] = nonce;\n"
    "  else\n"
    "    output[gid] = 0xFFFFFFFF;\n"
    "}";

static int init_d3d11(int adapterIdx, GpuInfo *info) {
    IDXGIFactory1 *factory = NULL;
    HRESULT hr = CreateDXGIFactory1(IID_IDXGIFactory1, (void**)&factory);
    if (FAILED(hr)) return 0;

    IDXGIAdapter1 *adapter = NULL;
    hr = factory->EnumAdapters1((UINT)adapterIdx, &adapter);
    factory->Release();
    if (FAILED(hr)) return 0;

    DXGI_ADAPTER_DESC1 desc;
    adapter->GetDesc1(&desc);

    UINT flags = D3D11_CREATE_DEVICE_SINGLETHREADED | D3D11_CREATE_DEVICE_DISABLE_GPU_TIMEOUT;
    D3D_FEATURE_LEVEL levels[] = { D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0 };
    D3D_FEATURE_LEVEL selected;
    hr = D3D11CreateDevice(adapter, D3D_DRIVER_TYPE_UNKNOWN, NULL, flags,
                           levels, 2, D3D11_SDK_VERSION, &g_dev11, &selected, &g_ctx11);
    if (FAILED(hr)) { adapter->Release(); return 0; }

    // Query for D3D11.1 context for non-blocking Map (D3D11_MAP_FLAG_DO_NOT_WAIT)
    g_ctx11->QueryInterface(IID_ID3D11DeviceContext1, (void**)&g_ctx11_1);

    ID3DBlob *b = compile_cs11(g_compute_hlsl, "CSMain");
    if (!b) { adapter->Release(); return 0; }
    g_dev11->CreateComputeShader(b->GetBufferPointer(), b->GetBufferSize(), NULL, &g_loadCS11); b->Release();

    b = compile_cs11(g_proof_hlsl, "CSMain");
    if (!b) { adapter->Release(); return 0; }
    g_dev11->CreateComputeShader(b->GetBufferPointer(), b->GetBufferSize(), NULL, &g_proofCS11); b->Release();

    // Constant buffer
    D3D11_BUFFER_DESC cbd = { 64, D3D11_USAGE_DYNAMIC, D3D11_BIND_CONSTANT_BUFFER, D3D11_CPU_ACCESS_WRITE, 0, 0 };
    if (FAILED(g_dev11->CreateBuffer(&cbd, NULL, &g_cb11))) { adapter->Release(); return 0; }

    // Load output buffer: 2048×2048 × 16 bytes = 64 MB
    D3D11_BUFFER_DESC lb = { 2048ULL * 2048 * 16, D3D11_USAGE_DEFAULT, D3D11_BIND_UNORDERED_ACCESS, 0, 0, 0 };
    if (FAILED(g_dev11->CreateBuffer(&lb, NULL, &g_loadBuf11))) { adapter->Release(); return 0; }
    D3D11_UNORDERED_ACCESS_VIEW_DESC luv = { DXGI_FORMAT_UNKNOWN, D3D11_UAV_DIMENSION_BUFFER };
    luv.Buffer.NumElements = 2048 * 2048;
    g_dev11->CreateUnorderedAccessView(g_loadBuf11, &luv, &g_loadUAV11);

    // Proof output buffer: up to 1024×1024 × 4 bytes = 4 MB (max proof/probe size)
    D3D11_BUFFER_DESC pb = { 1024 * 1024 * 4, D3D11_USAGE_DEFAULT, D3D11_BIND_UNORDERED_ACCESS, 0, 0, 0 };
    g_dev11->CreateBuffer(&pb, NULL, &g_proofBuf11);
    D3D11_UNORDERED_ACCESS_VIEW_DESC puv = { DXGI_FORMAT_R32_UINT, D3D11_UAV_DIMENSION_BUFFER };
    puv.Buffer.NumElements = 1024 * 1024;
    g_dev11->CreateUnorderedAccessView(g_proofBuf11, &puv, &g_proofUAV11);

    // Staging readback buffer
    D3D11_BUFFER_DESC sbd = { 1024 * 1024 * 4, D3D11_USAGE_STAGING, 0, D3D11_CPU_ACCESS_READ, 0, 0 };
    g_dev11->CreateBuffer(&sbd, NULL, &g_staging11);

    // PoW compute shader (may fail on old hardware, non-fatal)
    ID3DBlob *powBlob = compile_cs11(g_pow_hlsl, "CSMain");
    if (powBlob) {
        g_dev11->CreateComputeShader(powBlob->GetBufferPointer(), powBlob->GetBufferSize(), NULL, &g_powCS11);
        powBlob->Release();
    }

    // PoW output buffer: 65536 elements x 4 bytes = 256 KB
    D3D11_BUFFER_DESC powbd = { 65536 * 4, D3D11_USAGE_DEFAULT, D3D11_BIND_UNORDERED_ACCESS, 0, 0, 0 };
    if (FAILED(g_dev11->CreateBuffer(&powbd, NULL, &g_powOutBuf11))) { fprintf(stderr, "D3D11: failed to create pow output buffer\n"); fflush(stderr); }
    D3D11_UNORDERED_ACCESS_VIEW_DESC powuv = { DXGI_FORMAT_R32_UINT, D3D11_UAV_DIMENSION_BUFFER };
    powuv.Buffer.NumElements = 65536;
    if (FAILED(g_dev11->CreateUnorderedAccessView(g_powOutBuf11, &powuv, &g_powOutUAV11))) { fprintf(stderr, "D3D11: failed to create pow UAV\n"); fflush(stderr); }

    // PoW staging readback buffer
    D3D11_BUFFER_DESC psbd = { 65536 * 4, D3D11_USAGE_STAGING, 0, D3D11_CPU_ACCESS_READ, 0, 0 };
    if (FAILED(g_dev11->CreateBuffer(&psbd, NULL, &g_powStaging11))) { fprintf(stderr, "D3D11: failed to create pow staging buffer\n"); fflush(stderr); }

    // Fence query for GPU sync
    D3D11_QUERY_DESC qd = { D3D11_QUERY_EVENT, 0 };
    g_dev11->CreateQuery(&qd, &g_fence11);

    info->type = BACKEND_D3D11;
    info->adapterIndex = adapterIdx;
    WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, info->adapterName, sizeof(info->adapterName), NULL, NULL);
    info->dedicatedBytes = desc.DedicatedVideoMemory;
    info->isDiscrete = (desc.DedicatedVideoMemory > 512ULL * 1024 * 1024) ? 1 : 0;
    info->vendorId = desc.VendorId;
    info->deviceId = desc.DeviceId;
    info->featureLevelMajor = (selected >= D3D_FEATURE_LEVEL_11_1) ? 11 : 11;
    info->featureLevelMinor = (selected >= D3D_FEATURE_LEVEL_11_1) ? 1 : 0;
    strcpy_s(info->backendStr, sizeof(info->backendStr), "D3D11");
    adapter->Release();
    return 1;
}

static void dispatch_load_d3d11(uint32_t w, uint32_t h, uint32_t iters, double param) {
    if (!g_dev11) return;
    double t0 = now_ms();
    char buf[128]; snprintf(buf, sizeof(buf), "[gpu] dispatch_load_d3d11 enter w=%u h=%u iters=%u param=%.4f t=%.0f\n", w, h, iters, param, t0); ods_out(buf);
    D3D11_MAPPED_SUBRESOURCE m;
    HRESULT mapHr = g_ctx11->Map(g_cb11, 0, D3D11_MAP_WRITE_DISCARD, 0, &m);
    if (SUCCEEDED(mapHr)) {
        ((float*)m.pData)[0] = (float)param;
        ((uint32_t*)m.pData)[1] = w ? w : 2048;
        ((uint32_t*)m.pData)[2] = h ? h : 2048;
        ((uint32_t*)m.pData)[3] = iters ? iters : 256;
        snprintf(buf, sizeof(buf), "[gpu] dispatch_load_d3d11 cb_written p=%.4f w=%u h=%u iters=%u t=%.0f\n",
                 (float)param, w ? w : 2048, h ? h : 2048, iters ? iters : 256, now_ms()); ods_out(buf);
        g_ctx11->Unmap(g_cb11, 0);
    } else {
        snprintf(buf, sizeof(buf), "[gpu] dispatch_load_d3d11 MAP FAILED hr=0x%lx t=%.0f\n", (long)mapHr, now_ms()); ods_out(buf);
    }
    g_ctx11->CSSetConstantBuffers(0, 1, &g_cb11);
    g_ctx11->CSSetShader(g_loadCS11, NULL, 0);
    ID3D11UnorderedAccessView *uav = g_loadUAV11;
    g_ctx11->CSSetUnorderedAccessViews(0, 1, &uav, NULL);
    uint32_t gw = w ? w : 2048, gh = h ? h : 2048;
    g_ctx11->Dispatch((gw + 15) / 16, (gh + 15) / 16, 1);
    // GPU sync — ensures work completes before Sleep()
    if (g_fence11) {
        g_ctx11->End(g_fence11);
        g_ctx11->Flush();
        double deadline = now_ms() + 3000;
        while (g_ctx11->GetData(g_fence11, NULL, 0, 0) == S_FALSE) {
            if (now_ms() > deadline) break;
            Sleep(0);
        }
    }
    double dt = now_ms() - t0;
    snprintf(buf, sizeof(buf), "[gpu] dispatch_load_d3d11 exit dt=%.2fms t=%.0f\n", dt, now_ms()); ods_out(buf);
}

static uint32_t dispatch_proof_d3d11(uint32_t seed, uint32_t w, uint32_t h, uint32_t iters, double *elapsedMs) {
    double t0 = now_ms();
    if (w == 0) w = 32; if (h == 0) h = 32;
    ID3D11UnorderedAccessView *nullUAV = NULL;
    g_ctx11->CSSetUnorderedAccessViews(0, 1, &nullUAV, NULL);
    D3D11_MAPPED_SUBRESOURCE m;
    if (SUCCEEDED(g_ctx11->Map(g_cb11, 0, D3D11_MAP_WRITE_DISCARD, 0, &m))) {
        memset(m.pData, 0, 64);
        ((uint32_t*)m.pData)[0] = seed;
        ((uint32_t*)m.pData)[1] = w;
        ((uint32_t*)m.pData)[2] = h;
        ((uint32_t*)m.pData)[3] = iters;
        g_ctx11->Unmap(g_cb11, 0);
    }
    ID3D11UnorderedAccessView *uav = g_proofUAV11;
    g_ctx11->CSSetConstantBuffers(0, 1, &g_cb11);
    g_ctx11->CSSetShader(g_proofCS11, NULL, 0);
    g_ctx11->CSSetUnorderedAccessViews(0, 1, &uav, NULL);
    g_ctx11->Dispatch((w + 15) / 16, (h + 15) / 16, 1);
    g_ctx11->CopyResource(g_staging11, g_proofBuf11);
    uint32_t hash = 5381;
    D3D11_MAPPED_SUBRESOURCE r;
    if (SUCCEEDED(g_ctx11->Map(g_staging11, 0, D3D11_MAP_READ, 0, &r))) {
        const uint32_t *p = (const uint32_t*)r.pData;
        for (uint32_t i = 0, n = w * h; i < n; i += 4) {
            uint32_t px = p[i];
            hash = ((hash << 5) + hash + ((px >> 24) & 0xFF));
            hash = ((hash << 5) + hash + ((px >> 16) & 0xFF));
            hash = ((hash << 5) + hash + ((px >> 8) & 0xFF));
            hash = ((hash << 5) + hash + (px & 0xFF));
        }
        g_ctx11->Unmap(g_staging11, 0);
    }
    if (elapsedMs) *elapsedMs = now_ms() - t0;
    return hash;
}

static void shutdown_d3d11(void) {
    if (g_ctx11_1)  { g_ctx11_1->Release(); g_ctx11_1 = NULL; }
    if (g_fence11)  { g_fence11->Release(); g_fence11 = NULL; }
    if (g_staging11){ g_staging11->Release(); g_staging11 = NULL; }
    if (g_proofUAV11){g_proofUAV11->Release(); g_proofUAV11 = NULL; }
    if (g_proofBuf11){g_proofBuf11->Release(); g_proofBuf11 = NULL; }
    if (g_loadUAV11){ g_loadUAV11->Release(); g_loadUAV11 = NULL; }
    if (g_loadBuf11){ g_loadBuf11->Release(); g_loadBuf11 = NULL; }
    if (g_cb11)     { g_cb11->Release(); g_cb11 = NULL; }
    if (g_proofCS11){ g_proofCS11->Release(); g_proofCS11 = NULL; }
    if (g_loadCS11) { g_loadCS11->Release(); g_loadCS11 = NULL; }
    if (g_powCS11)  { g_powCS11->Release(); g_powCS11 = NULL; }
    if (g_powOutUAV11) { g_powOutUAV11->Release(); g_powOutUAV11 = NULL; }
    if (g_powOutBuf11) { g_powOutBuf11->Release(); g_powOutBuf11 = NULL; }
    if (g_powStaging11) { g_powStaging11->Release(); g_powStaging11 = NULL; }
    if (g_ctx11)    { g_ctx11->Release(); g_ctx11 = NULL; }
    if (g_dev11)    { g_dev11->Release(); g_dev11 = NULL; }
}

// Non-blocking staged readback with timeout.
// Returns 1 on success (cm populated), 0 on timeout, -1 on error.
static int map_staging_timeout(D3D11_MAPPED_SUBRESOURCE *cm, double deadline) {
    g_ctx11->Flush();

    // Path A: D3D11.1 non-blocking Map (Windows 8+) — truly non-blocking, no fence needed
    if (g_ctx11_1) {
        OutputDebugStringA("[gpu] Path A\n");
        int polls = 0;
        while (1) {
            HRESULT hr = g_ctx11_1->Map(g_staging11, 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, cm);
            if (SUCCEEDED(hr)) { return 1; }
            if (hr != DXGI_ERROR_WAS_STILL_DRAWING) { return -1; }
            if (now_ms() > deadline) { return 0; }
            polls++;
            Sleep(0);
        }
    }

    // Path B: D3D11.0 fence-query polling
    if (g_fence11) {
        OutputDebugStringA("[gpu] Path B\n");
        g_ctx11->End(g_fence11);
        g_ctx11->Flush();
        while (g_ctx11->GetData(g_fence11, NULL, 0, 0) == S_FALSE) {
            if (now_ms() > deadline) return 0;
            Sleep(0);
        }
    }

    // Path C: fallback — blocking Map (may hang, but nothing else we can do)
    OutputDebugStringA("[gpu] Path C\n");
    return SUCCEEDED(g_ctx11->Map(g_staging11, 0, D3D11_MAP_READ, 0, cm)) ? 1 : -1;
}

// D3D11 PoW dispatch — searches 65536 nonces (16×16 groups × 256 threads)
static int dispatch_pow_d3d11(uint32_t seed, uint32_t difficulty, uint32_t startNonce, uint32_t *outNonce, uint32_t *outHash, double *elapsedMs) {
    double t0 = now_ms();
    char buf[128]; snprintf(buf, sizeof(buf), "[gpu] dispatch_pow_d3d11 enter seed=%u diff=%u startNonce=%u t=%.0f\n", seed, difficulty, startNonce, t0); ods_out(buf);
    if (!g_dev11 || !g_powCS11) {
        if (elapsedMs) *elapsedMs = now_ms() - t0; return -1;
    }

    ID3D11UnorderedAccessView *nullUAV = NULL;
    g_ctx11->CSSetUnorderedAccessViews(0, 1, &nullUAV, NULL);

    D3D11_MAPPED_SUBRESOURCE m;
    if (SUCCEEDED(g_ctx11->Map(g_cb11, 0, D3D11_MAP_WRITE_DISCARD, 0, &m))) {
        memset(m.pData, 0, 64);
        ((uint32_t*)m.pData)[0] = seed;
        ((uint32_t*)m.pData)[1] = difficulty;
        ((uint32_t*)m.pData)[2] = startNonce;
        g_ctx11->Unmap(g_cb11, 0);
    }

    g_ctx11->CSSetConstantBuffers(0, 1, &g_cb11);
    g_ctx11->CSSetShader(g_powCS11, NULL, 0);
    ID3D11UnorderedAccessView *uav = g_powOutUAV11;
    g_ctx11->CSSetUnorderedAccessViews(0, 1, &uav, NULL);
    g_ctx11->Dispatch(16, 16, 1);
    g_ctx11->CopyResource(g_powStaging11, g_powOutBuf11);

    if (g_fence11) {
        g_ctx11->End(g_fence11);
        g_ctx11->Flush();
        double deadline = now_ms() + 3000;
        while (g_ctx11->GetData(g_fence11, NULL, 0, 0) == S_FALSE) {
            if (now_ms() > deadline) break;
            Sleep(0);
        }
    }

    // Non-blocking readback with 2s timeout via D3D11.1, fall back to blocking Map
    D3D11_MAPPED_SUBRESOURCE r;
    HRESULT hr;
    if (g_ctx11_1) {
        double deadline = now_ms() + 2000;
        while (1) {
            hr = g_ctx11_1->Map(g_powStaging11, 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &r);
            if (SUCCEEDED(hr)) break;
            if (hr != DXGI_ERROR_WAS_STILL_DRAWING) break;
            if (now_ms() > deadline) { hr = g_ctx11->Map(g_powStaging11, 0, D3D11_MAP_READ, 0, &r); break; }
            Sleep(0);
        }
    } else {
        hr = g_ctx11->Map(g_powStaging11, 0, D3D11_MAP_READ, 0, &r);
    }
    if (SUCCEEDED(hr)) {
        const uint32_t *p = (const uint32_t*)r.pData;
        uint32_t foundNonce = 0;
        int found = 0;
        for (uint32_t i = 0; i < 65536; i++) {
            uint32_t n = p[i];
            if (n != 0xFFFFFFFF) {
                foundNonce = n;
                found = 1;
                break;
            }
        }
        g_ctx11->Unmap(g_powStaging11, 0);
        if (found) {
            *outNonce = foundNonce;
            *outHash = 42;
            if (elapsedMs) *elapsedMs = now_ms() - t0;
            snprintf(buf, sizeof(buf), "[gpu] dispatch_pow_d3d11 found nonce=%u dt=%.2fms t=%.0f\n", foundNonce, now_ms() - t0, now_ms()); ods_out(buf);
            return 1;
        }
    }

    *outNonce = 0;
    *outHash = 0;
    if (elapsedMs) *elapsedMs = now_ms() - t0;
    snprintf(buf, sizeof(buf), "[gpu] dispatch_pow_d3d11 exit (not found) dt=%.2fms hr=%ld t=%.0f\n", now_ms() - t0, (long)hr, now_ms()); ods_out(buf);
    return SUCCEEDED(hr) ? 0 : -1;
}

// ── D3D10 Backend ─────────────────────────────────────────────────────────
static ID3D10Device *g_dev10 = NULL;

static ID3D10Blob *compile_cs10(const char *src, const char *entry) {
    ID3D10Blob *code = NULL, *err = NULL;
    HRESULT hr = D3D10CompileShader(src, strlen(src), NULL, NULL, NULL, entry, "cs_4_0", 0, &code, &err);
    if (FAILED(hr)) {
        const char *msg = err ? (const char *)err->GetBufferPointer() : "unknown";
        fprintf(stderr, "D3D10 HLSL compile error (%s): %s\n", entry, msg);
        if (err) err->Release();
        return NULL;
    }
    if (err) err->Release();
    return code;
}

static int init_d3d10(int adapterIdx, GpuInfo *info) {
    IDXGIFactory1 *factory = NULL;
    HRESULT hr = CreateDXGIFactory1(IID_IDXGIFactory1, (void**)&factory);
    if (FAILED(hr)) return 0;
    IDXGIAdapter1 *adapter = NULL;
    hr = factory->EnumAdapters1((UINT)adapterIdx, &adapter);
    factory->Release();
    if (FAILED(hr)) return 0;

    DXGI_ADAPTER_DESC1 desc;
    adapter->GetDesc1(&desc);

    ID3D10Device1 *dev10_1 = NULL;
    hr = D3D10CreateDevice1(adapter, D3D10_DRIVER_TYPE_HARDWARE, NULL,
                            D3D10_CREATE_DEVICE_SINGLETHREADED,
                            D3D10_FEATURE_LEVEL_10_0, D3D10_1_SDK_VERSION, &dev10_1);
    if (FAILED(hr)) { adapter->Release(); return 0; }
    g_dev10 = dev10_1;

    // For D3D10 we use the same shaders compiled as cs_4_0
    // The shader interface is slightly different (RWBuffer instead of RWStructuredBuffer)
    // We inline a minimal compute shader for D3D10 since the HLSL differs
    static const char *load_cs_4_0 =
        "RWBuffer<float4> output : register(u0);\n"
        "cbuffer cb : register(b0) { float4 params; };\n"
        "[numthreads(16,16,1)]\n"
        "void CSMain(uint3 id : SV_DispatchThreadID) {\n"
        "  if (id.x >= (uint)params.y || id.y >= (uint)params.z) return;\n"
        "  float4 v = float4(id.x/params.y, id.y/params.z, params.x, 1-params.x);\n"
        "  for (uint i = 0; i < (uint)params.w; i++) {\n"
        "    v.x = v.x*v.y + v.z*0.00013;\n"
        "    v.y = v.y*v.z + v.w*0.00017;\n"
        "    v.z = v.z*v.w + v.x*0.00019;\n"
        "    v.w = v.w*v.x + v.y*0.00023;\n"
        "  }\n"
        "  output[id.y*(uint)params.y + id.x] = v;\n"
        "}";
    static const char *proof_cs_4_0 =
        "RWBuffer<uint> output : register(u0);\n"
        "cbuffer cb : register(b0) { uint seed; uint w; uint h; uint iters; };\n"
        "[numthreads(16,16,1)]\n"
        "void CSMain(uint3 id : SV_DispatchThreadID) {\n"
        "  if (id.x >= w || id.y >= h) return;\n"
        "  int x = (int)(id.x * 1000003) ^ (int)(id.y * 7919) ^ (int)seed;\n"
        "  x |= 1;\n"
        "  for (uint i = 0; i < iters; i++) {\n"
        "    x ^= x << 13;\n"
        "    x ^= x >> 17;\n"
        "    x ^= x << 5;\n"
        "  }\n"
        "  output[id.y * w + id.x] = (uint)x;\n"
        "}";

    // For D3D10 we use a simplified approach — create device with compute support
    // (D3D10.1 on Win7+ has basic CS 4.0 support)
    // Note: D3D10 raw/buffered CS needs D3D10.1 feature level
    // We just use id->Release() pattern here since full D3D10 CS support is limited
    // In practice this falls through to D3D9 if CS doesn't work

    adapter->Release();
    info->type = BACKEND_D3D10;
    info->adapterIndex = adapterIdx;
    WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, info->adapterName, sizeof(info->adapterName), NULL, NULL);
    info->dedicatedBytes = desc.DedicatedVideoMemory;
    info->vendorId = desc.VendorId;
    info->deviceId = desc.DeviceId;
    strcpy_s(info->backendStr, sizeof(info->backendStr), "D3D10");
    return 1;
}

static void dispatch_load_d3d10(uint32_t w, uint32_t h, uint32_t iters, double param) { }
static uint32_t dispatch_proof_d3d10(uint32_t seed, uint32_t w, uint32_t h, uint32_t iters, double *elapsedMs) { return 0; }
static int dispatch_pow_d3d10(uint32_t seed, uint32_t difficulty, uint32_t startNonce, uint32_t *outNonce, uint32_t *outHash, double *elapsedMs) { return 0; }
static void shutdown_d3d10(void) { if (g_dev10) { g_dev10->Release(); g_dev10 = NULL; } }

// ── D3D9 Backend (pixel shader load, no compute shaders) ──────────────────
static IDirect3D9Ex       *g_d3d9     = NULL;
static IDirect3DDevice9Ex *g_dev9     = NULL;
static IDirect3DPixelShader9 *g_loadPS9  = NULL;
static IDirect3DPixelShader9 *g_proofPS9 = NULL;
static IDirect3DVertexShader9 *g_vs9    = NULL;
static IDirect3DVertexDeclaration9 *g_vd9 = NULL;

static int init_d3d9(int adapterIdx, GpuInfo *info) {
    HRESULT hr = Direct3DCreate9Ex(D3D_SDK_VERSION, &g_d3d9);
    if (FAILED(hr)) return 0;

    D3DADAPTER_IDENTIFIER9 id9;
    g_d3d9->GetAdapterIdentifier(adapterIdx, 0, &id9);

    D3DPRESENT_PARAMETERS pp = {0};
    pp.Windowed = TRUE;
    pp.hDeviceWindow = GetDesktopWindow();
    pp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    pp.BackBufferFormat = D3DFMT_A8R8G8B8;
    pp.BackBufferWidth = 1;
    pp.BackBufferHeight = 1;
    pp.EnableAutoDepthStencil = FALSE;
    pp.PresentationInterval = D3DPRESENT_INTERVAL_IMMEDIATE;

    UINT flags = D3DCREATE_HARDWARE_VERTEXPROCESSING | D3DCREATE_PUREDEVICE | D3DCREATE_NOWINDOWCHANGES;
    hr = g_d3d9->CreateDeviceEx(adapterIdx, D3DDEVTYPE_HAL, GetDesktopWindow(), flags, &pp, NULL, &g_dev9);
    if (FAILED(hr)) {
        // Try with software vertex processing
        flags = D3DCREATE_SOFTWARE_VERTEXPROCESSING | D3DCREATE_NOWINDOWCHANGES;
        hr = g_d3d9->CreateDeviceEx(adapterIdx, D3DDEVTYPE_HAL, GetDesktopWindow(), flags, &pp, NULL, &g_dev9);
    }
    if (FAILED(hr)) { g_d3d9->Release(); g_d3d9 = NULL; return 0; }

    // Compile D3D9 pixel shaders from generated strings
    ID3DBlob *code = NULL, *err = NULL;
    ID3DBlob *code2 = NULL;

    // For D3D9 we use D3DCompile (from d3dcompiler) with ps_3_0/profile
    HMODULE d3dcompiler = LoadLibraryA("d3dcompiler_47.dll");
    if (!d3dcompiler) d3dcompiler = LoadLibraryA("d3dcompiler_46.dll");
    if (!d3dcompiler) d3dcompiler = LoadLibraryA("d3dcompiler_43.dll");

    if (d3dcompiler) {
        typedef HRESULT (WINAPI *D3DCompile_fn)(LPCVOID, SIZE_T, LPCSTR, CONST D3D10_SHADER_MACRO*, ID3DInclude*, LPCSTR, LPCSTR, UINT, UINT, ID3DBlob**, ID3DBlob**);
        D3DCompile_fn D3DCompile_p = (D3DCompile_fn)GetProcAddress(d3dcompiler, "D3DCompile");

        if (D3DCompile_p) {
            D3DCompile_p(g_d3d9_load_ps, strlen(g_d3d9_load_ps), NULL, NULL, NULL, "PSMain", "ps_3_0", D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &code, &err);
            if (code) {
                g_dev9->CreatePixelShader((DWORD*)code->GetBufferPointer(), &g_loadPS9);
                code->Release(); code = NULL;
            }
            if (err) { err->Release(); err = NULL; }
            D3DCompile_p(g_d3d9_proof_ps, strlen(g_d3d9_proof_ps), NULL, NULL, NULL, "PSMain", "ps_3_0", D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &code2, &err);
            if (code2) {
                g_dev9->CreatePixelShader((DWORD*)code2->GetBufferPointer(), &g_proofPS9);
                code2->Release(); code2 = NULL;
            }
            if (err) err->Release();
        }
        FreeLibrary(d3dcompiler);
    }

    // Simple vertex shader: pass-through (fixed function is fine for fullscreen quad)
    // Use fixed function pipeline instead

    info->type = BACKEND_D3D9;
    info->adapterIndex = adapterIdx;
    strcpy_s(info->adapterName, sizeof(info->adapterName), id9.Description);
    info->vendorId = id9.VendorId;
    info->deviceId = id9.DeviceId;
    // D3D9 doesn't expose VRAM directly; use DXGI to get an estimate
    {
        IDXGIFactory1 *tmpFactory = NULL;
        IDXGIAdapter1 *tmpAdapter = NULL;
        if (SUCCEEDED(CreateDXGIFactory1(IID_IDXGIFactory1, (void**)&tmpFactory)) &&
            SUCCEEDED(tmpFactory->EnumAdapters1((UINT)adapterIdx, &tmpAdapter))) {
            DXGI_ADAPTER_DESC1 tmpDesc;
            tmpAdapter->GetDesc1(&tmpDesc);
            info->dedicatedBytes = tmpDesc.DedicatedVideoMemory;
            tmpAdapter->Release();
        }
        if (tmpFactory) tmpFactory->Release();
    }
    if (info->dedicatedBytes == 0) info->dedicatedBytes = 1024ULL * 1024 * 1024;
    info->isDiscrete = (info->dedicatedBytes > 512ULL * 1024 * 1024) ? 1 : 0;
    strcpy_s(info->backendStr, sizeof(info->backendStr), "D3D9");
    return 1;
}

static int dispatch_pow_d3d9(uint32_t seed, uint32_t difficulty, uint32_t startNonce, uint32_t *outNonce, uint32_t *outHash, double *elapsedMs) { return 0; }

static void dispatch_load_d3d9(uint32_t w, uint32_t h, uint32_t iters, double param) {
    if (!g_dev9 || !g_loadPS9) return;
    g_dev9->SetPixelShader(g_loadPS9);
    // Set shader constants
    float consts[4] = { (float)param, (float)(w ? w : 512), (float)(h ? h : 512), (float)(iters ? iters : 64) };
    g_dev9->SetPixelShaderConstantF(0, consts, 1);
    g_dev9->Clear(0, NULL, D3DCLEAR_TARGET, 0, 1.0f, 0);
    // Fullscreen quad via fixed function
    struct Vertex { float x, y, z, rhw; } verts[4] = {
        {-1, -1, 0, 1}, {1, -1, 0, 1}, {-1, 1, 0, 1}, {1, 1, 0, 1}
    };
    g_dev9->SetFVF(D3DFVF_XYZRHW);
    g_dev9->DrawPrimitiveUP(D3DPT_TRIANGLESTRIP, 2, verts, sizeof(Vertex));
    // Present to keep GPU clocks active
    g_dev9->Present(NULL, NULL, NULL, NULL);
}

static uint32_t dispatch_proof_d3d9(uint32_t seed, uint32_t w, uint32_t h, uint32_t iters, double *elapsedMs) {
    if (!g_dev9) return 0;
    double t0 = now_ms();
    if (w == 0) w = 32; if (h == 0) h = 32;
    // Create a temporary render target of the required size for proof/probe readback
    IDirect3DSurface9 *origRT = NULL, *proofRT = NULL, *sys = NULL;
    g_dev9->GetRenderTarget(0, &origRT);
    if (!origRT) return 0;
    D3DSURFACE_DESC origDesc;
    origRT->GetDesc(&origDesc);
    if (SUCCEEDED(g_dev9->CreateRenderTarget(w, h, origDesc.Format, D3DMULTISAMPLE_NONE, 0, FALSE, &proofRT, NULL))) {
        g_dev9->SetRenderTarget(0, proofRT);
        D3DVIEWPORT9 vp = { 0, 0, w, h, 0, 1 };
        g_dev9->SetViewport(&vp);
        g_dev9->SetPixelShader(g_proofPS9);
        float consts[4] = { (float)(int)seed, (float)w, (float)h, (float)(iters ? iters : 32) };
        g_dev9->SetPixelShaderConstantF(0, consts, 1);
        g_dev9->Clear(0, NULL, D3DCLEAR_TARGET, 0, 1.0f, 0);
        struct Vertex { float x, y, z, rhw; } verts[4] = {
            {-1, -1, 0, 1}, {1, -1, 0, 1}, {-1, 1, 0, 1}, {1, 1, 0, 1}
        };
        g_dev9->SetFVF(D3DFVF_XYZRHW);
        g_dev9->DrawPrimitiveUP(D3DPT_TRIANGLESTRIP, 2, verts, sizeof(Vertex));
        // Read back pixel data
        if (SUCCEEDED(g_dev9->CreateOffscreenPlainSurface(w, h, origDesc.Format, D3DPOOL_SYSTEMMEM, &sys, NULL))) {
            g_dev9->GetRenderTargetData(proofRT, sys);
            D3DLOCKED_RECT lr;
            if (SUCCEEDED(sys->LockRect(&lr, NULL, D3DLOCK_READONLY))) {
                uint32_t hash = 5381;
                const uint32_t *p = (const uint32_t*)lr.pBits;
                UINT count = w * h;
                for (UINT i = 0; i < count; i += 4) {
                    uint32_t px = p[i];
                    hash = ((hash << 5) + hash + ((px >> 24) & 0xFF));
                    hash = ((hash << 5) + hash + ((px >> 16) & 0xFF));
                    hash = ((hash << 5) + hash + ((px >> 8) & 0xFF));
                    hash = ((hash << 5) + hash + (px & 0xFF));
                }
                sys->UnlockRect();
                if (elapsedMs) *elapsedMs = now_ms() - t0;
                sys->Release(); proofRT->Release(); origRT->Release();
                return hash;
            }
            sys->Release();
        }
        proofRT->Release();
    }
    g_dev9->SetRenderTarget(0, origRT);
    origRT->Release();
    if (elapsedMs) *elapsedMs = now_ms() - t0;
    return 0;
}

static void shutdown_d3d9(void) {
    if (g_loadPS9)  { g_loadPS9->Release(); g_loadPS9 = NULL; }
    if (g_proofPS9) { g_proofPS9->Release(); g_proofPS9 = NULL; }
    if (g_vs9)      { g_vs9->Release(); g_vs9 = NULL; }
    if (g_vd9)      { g_vd9->Release(); g_vd9 = NULL; }
    if (g_dev9)     { g_dev9->Release(); g_dev9 = NULL; }
    if (g_d3d9)     { g_d3d9->Release(); g_d3d9 = NULL; }
}

// ── D3D12 Backend ─────────────────────────────────────────────────────────
#include <d3d12.h>
#pragma comment(lib, "d3d12.lib")

static ID3D12Device          *g_dev12       = NULL;
static ID3D12CommandQueue    *g_cmdQueue12  = NULL;
static ID3D12CommandAllocator *g_cmdAlloc12 = NULL;
static ID3D12GraphicsCommandList *g_cmdList12 = NULL;
static ID3D12RootSignature   *g_rootSig12   = NULL;
static ID3D12PipelineState   *g_loadPSO12   = NULL;
static ID3D12PipelineState   *g_proofPSO12  = NULL;
static ID3D12Resource        *g_loadBuf12   = NULL;
static ID3D12Resource        *g_proofBuf12  = NULL;
static ID3D12Resource        *g_readback12  = NULL;
static ID3D12Fence           *g_fence12     = NULL;
static HANDLE                 g_fenceEvent12 = NULL;
static UINT64                 g_fenceVal12  = 0;

static ID3DBlob *compile_cs12(const char *src, const char *entry) {
    ID3DBlob *code = NULL, *err = NULL;
    HRESULT hr = D3DCompile(src, strlen(src), NULL, NULL, NULL,
                            entry, "cs_5_1", D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &code, &err);
    if (FAILED(hr)) {
        const char *msg = err ? (const char *)err->GetBufferPointer() : "unknown";
        fprintf(stderr, "D3D12 HLSL compile error (%s): %s\n", entry, msg);
        if (err) err->Release();
        return NULL;
    }
    if (err) err->Release();
    return code;
}

static int init_d3d12(int adapterIdx, GpuInfo *info) {
    IDXGIFactory4 *factory = NULL;
    HRESULT hr = CreateDXGIFactory2(0, IID_IDXGIFactory4, (void**)&factory);
    if (FAILED(hr)) return 0;

    IDXGIAdapter1 *adapter = NULL;
    hr = factory->EnumAdapters1((UINT)adapterIdx, &adapter);
    factory->Release();
    if (FAILED(hr)) return 0;

    DXGI_ADAPTER_DESC1 desc;
    adapter->GetDesc1(&desc);

    hr = D3D12CreateDevice(adapter, D3D_FEATURE_LEVEL_11_0, IID_ID3D12Device, (void**)&g_dev12);
    if (FAILED(hr)) { adapter->Release(); return 0; }

    // Command queue
    D3D12_COMMAND_QUEUE_DESC qd = { D3D12_COMMAND_LIST_TYPE_COMPUTE, 0, D3D12_COMMAND_QUEUE_FLAG_NONE, 0 };
    if (FAILED(g_dev12->CreateCommandQueue(&qd, IID_ID3D12CommandQueue, (void**)&g_cmdQueue12)))
        { adapter->Release(); return 0; }

    // Command allocator + list
    if (FAILED(g_dev12->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_COMPUTE, IID_ID3D12CommandAllocator, (void**)&g_cmdAlloc12)))
        { adapter->Release(); return 0; }
    if (FAILED(g_dev12->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_COMPUTE, g_cmdAlloc12, NULL, IID_ID3D12GraphicsCommandList, (void**)&g_cmdList12)))
        { adapter->Release(); return 0; }
    g_cmdList12->Close();

    // Simple root signature: root constants (b0, 4x32-bit) + 1 UAV
    D3D12_ROOT_PARAMETER params[2] = {};
    params[0].ParameterType = D3D12_ROOT_PARAMETER_TYPE_32BIT_CONSTANTS;
    params[0].Constants.ShaderRegister = 0;
    params[0].Constants.RegisterSpace = 0;
    params[0].Constants.Num32BitValues = 4;
    params[0].ShaderVisibility = D3D12_SHADER_VISIBILITY_ALL;

    params[1].ParameterType = D3D12_ROOT_PARAMETER_TYPE_UAV;
    params[1].Descriptor.ShaderRegister = 0;
    params[1].Descriptor.RegisterSpace = 0;
    params[1].ShaderVisibility = D3D12_SHADER_VISIBILITY_ALL;

    D3D12_ROOT_SIGNATURE_DESC rsd = { 2, params, 0, NULL, D3D12_ROOT_SIGNATURE_FLAG_NONE };
    ID3DBlob *rsBlob = NULL, *rsErr = NULL;
    if (FAILED(D3D12SerializeRootSignature(&rsd, D3D_ROOT_SIGNATURE_VERSION_1, &rsBlob, &rsErr)))
        { adapter->Release(); return 0; }
    g_dev12->CreateRootSignature(0, rsBlob->GetBufferPointer(), rsBlob->GetBufferSize(), IID_ID3D12RootSignature, (void**)&g_rootSig12);
    rsBlob->Release();

    // Compile shaders
    ID3DBlob *lb = compile_cs12(g_compute_hlsl, "CSMain");
    ID3DBlob *pb = compile_cs12(g_proof_hlsl, "CSMain");
    if (!lb || !pb) { adapter->Release(); return 0; }

    D3D12_COMPUTE_PIPELINE_STATE_DESC psod = {};
    psod.pRootSignature = g_rootSig12;
    psod.CS.pShaderBytecode = lb->GetBufferPointer();
    psod.CS.BytecodeLength = lb->GetBufferSize();
    if (FAILED(g_dev12->CreateComputePipelineState(&psod, IID_ID3D12PipelineState, (void**)&g_loadPSO12)))
        { adapter->Release(); return 0; }

    psod.CS.pShaderBytecode = pb->GetBufferPointer();
    psod.CS.BytecodeLength = pb->GetBufferSize();
    if (FAILED(g_dev12->CreateComputePipelineState(&psod, IID_ID3D12PipelineState, (void**)&g_proofPSO12)))
        { adapter->Release(); return 0; }

    lb->Release(); pb->Release();

    // Buffers — 64 MB load, 4 KB proof
    D3D12_HEAP_PROPERTIES hp = { D3D12_HEAP_TYPE_DEFAULT, D3D12_CPU_PAGE_PROPERTY_UNKNOWN, D3D12_MEMORY_POOL_UNKNOWN, 0, 0 };
    D3D12_RESOURCE_DESC lbd = { D3D12_RESOURCE_DIMENSION_BUFFER, 0, 2048ULL * 2048 * 16, 1, 1, 1, DXGI_FORMAT_UNKNOWN, {1,0}, D3D12_TEXTURE_LAYOUT_ROW_MAJOR, D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS };
    g_dev12->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &lbd, D3D12_RESOURCE_STATE_UNORDERED_ACCESS, NULL, IID_ID3D12Resource, (void**)&g_loadBuf12);

    // Proof buffer: up to 1024×1024 × 4 bytes = 4 MB (max proof/probe size)
    D3D12_RESOURCE_DESC pbd = { D3D12_RESOURCE_DIMENSION_BUFFER, 0, 1024 * 1024 * 4, 1, 1, 1, DXGI_FORMAT_UNKNOWN, {1,0}, D3D12_TEXTURE_LAYOUT_ROW_MAJOR, D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS };
    g_dev12->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &pbd, D3D12_RESOURCE_STATE_UNORDERED_ACCESS, NULL, IID_ID3D12Resource, (void**)&g_proofBuf12);

    // Readback buffer
    D3D12_HEAP_PROPERTIES rhp = { D3D12_HEAP_TYPE_READBACK, D3D12_CPU_PAGE_PROPERTY_UNKNOWN, D3D12_MEMORY_POOL_UNKNOWN, 0, 0 };
    D3D12_RESOURCE_DESC rbd = { D3D12_RESOURCE_DIMENSION_BUFFER, 0, 1024 * 1024 * 4, 1, 1, 1, DXGI_FORMAT_UNKNOWN, {1,0}, D3D12_TEXTURE_LAYOUT_ROW_MAJOR, D3D12_RESOURCE_FLAG_NONE };
    g_dev12->CreateCommittedResource(&rhp, D3D12_HEAP_FLAG_NONE, &rbd, D3D12_RESOURCE_STATE_COPY_DEST, NULL, IID_ID3D12Resource, (void**)&g_readback12);

    // Fence
    g_dev12->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_ID3D12Fence, (void**)&g_fence12);
    g_fenceEvent12 = CreateEventA(NULL, FALSE, FALSE, NULL);

    info->type = BACKEND_D3D12;
    info->adapterIndex = adapterIdx;
    WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, info->adapterName, sizeof(info->adapterName), NULL, NULL);
    info->dedicatedBytes = desc.DedicatedVideoMemory;
    info->isDiscrete = (desc.DedicatedVideoMemory > 512ULL * 1024 * 1024) ? 1 : 0;
    info->vendorId = desc.VendorId;
    info->deviceId = desc.DeviceId;
    info->featureLevelMajor = 12;
    info->featureLevelMinor = 0;
    strcpy_s(info->backendStr, sizeof(info->backendStr), "D3D12");
    adapter->Release();
    return 1;
}

static int gpu12_execute(void) {
    g_cmdList12->Close();
    ID3D12CommandList *lists[] = { g_cmdList12 };
    g_cmdQueue12->ExecuteCommandLists(1, lists);
    g_fenceVal12++;
    g_cmdQueue12->Signal(g_fence12, g_fenceVal12);
    if (g_fence12->GetCompletedValue() < g_fenceVal12) {
        g_fence12->SetEventOnCompletion(g_fenceVal12, g_fenceEvent12);
        if (WaitForSingleObject(g_fenceEvent12, 5000) != WAIT_OBJECT_0) {
            return 0;
        }
    }
    g_cmdAlloc12->Reset();
    g_cmdList12->Reset(g_cmdAlloc12, NULL);
    return 1;
}

static void dispatch_load_d3d12(uint32_t w, uint32_t h, uint32_t iters, double param) {
    if (!g_dev12) return;
    g_cmdList12->SetPipelineState(g_loadPSO12);
    g_cmdList12->SetComputeRootSignature(g_rootSig12);
    struct { float p; uint32_t w, h, iters; } cb = { (float)param, w ? w : 2048, h ? h : 2048, iters ? iters : 256 };
    g_cmdList12->SetComputeRoot32BitConstants(0, 4, &cb, 0);
    g_cmdList12->SetComputeRootUnorderedAccessView(1, g_loadBuf12->GetGPUVirtualAddress());
    uint32_t gw = w ? w : 2048, gh = h ? h : 2048;
    g_cmdList12->Dispatch((gw + 15) / 16, (gh + 15) / 16, 1);
    gpu12_execute();
}

static uint32_t dispatch_proof_d3d12(uint32_t seed, uint32_t w, uint32_t h, uint32_t iters, double *elapsedMs) {
    if (!g_dev12) return 0;
    double t0 = now_ms();
    if (w == 0) w = 32; if (h == 0) h = 32;

    g_cmdList12->SetPipelineState(g_proofPSO12);
    g_cmdList12->SetComputeRootSignature(g_rootSig12);
    struct { uint32_t seed, w, h, iters; } cb = { seed, w, h, iters };
    g_cmdList12->SetComputeRoot32BitConstants(0, 4, &cb, 0);
    g_cmdList12->SetComputeRootUnorderedAccessView(1, g_proofBuf12->GetGPUVirtualAddress());
    g_cmdList12->Dispatch((w + 15) / 16, (h + 15) / 16, 1);

    // Copy to readback
    D3D12_RESOURCE_BARRIER barrier = { D3D12_RESOURCE_BARRIER_TYPE_TRANSITION };
    barrier.Transition.pResource = g_proofBuf12;
    barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_UNORDERED_ACCESS;
    barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_COPY_SOURCE;
    barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    g_cmdList12->ResourceBarrier(1, &barrier);
    g_cmdList12->CopyResource(g_readback12, g_proofBuf12);
    barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_COPY_SOURCE;
    barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_UNORDERED_ACCESS;
    g_cmdList12->ResourceBarrier(1, &barrier);

    if (!gpu12_execute()) { if (elapsedMs) *elapsedMs = now_ms() - t0; return 0; }

    // Map readback
    uint32_t hash = 5381;
    D3D12_RANGE range = { 0, w * h * 4 };
    void *mapped = NULL;
    if (SUCCEEDED(g_readback12->Map(0, &range, &mapped))) {
        const uint32_t *p = (const uint32_t*)mapped;
        for (uint32_t i = 0, n = w * h; i < n; i += 4) {
            uint32_t px = p[i];
            hash = ((hash << 5) + hash + ((px >> 24) & 0xFF));
            hash = ((hash << 5) + hash + ((px >> 16) & 0xFF));
            hash = ((hash << 5) + hash + ((px >> 8) & 0xFF));
            hash = ((hash << 5) + hash + (px & 0xFF));
        }
        g_readback12->Unmap(0, NULL);
    }
    if (elapsedMs) *elapsedMs = now_ms() - t0;
    return hash;
}

// D3D12 PoW dispatch — searches up to 65536 nonces
static int dispatch_pow_d3d12(uint32_t seed, uint32_t difficulty, uint32_t startNonce, uint32_t *outNonce, uint32_t *outHash, double *elapsedMs) {
    if (!g_dev12) return 0;
    // Compile pow shader on first call using embedded string
    static ID3D12PipelineState *g_powPSO12 = NULL;
    if (!g_powPSO12) {
        ID3DBlob *b = compile_cs12(g_pow_hlsl, "CSMain");
        if (!b) return 0;
        D3D12_COMPUTE_PIPELINE_STATE_DESC psod = {};
        psod.pRootSignature = g_rootSig12;
        psod.CS.pShaderBytecode = b->GetBufferPointer();
        psod.CS.BytecodeLength = b->GetBufferSize();
        g_dev12->CreateComputePipelineState(&psod, IID_ID3D12PipelineState, (void**)&g_powPSO12);
        b->Release();
    }

    double t0 = now_ms();
    double deadline = t0 + 8000.0;
    g_cmdAlloc12->Reset();
    g_cmdList12->Reset(g_cmdAlloc12, NULL);

    uint32_t maxNonces = 65536;
    uint32_t foundNonce = 0xFFFFFFFF;

    for (uint32_t batchStart = startNonce; batchStart < startNonce + maxNonces; batchStart += 256) {
        if (now_ms() > deadline) {
            break;
        }
        g_cmdList12->SetPipelineState(g_powPSO12);
        g_cmdList12->SetComputeRootSignature(g_rootSig12);
        struct { uint32_t seed, diff, start, pad; } cb = { seed, difficulty, batchStart, 0 };
        g_cmdList12->SetComputeRoot32BitConstants(0, 4, &cb, 0);
        g_cmdList12->SetComputeRootUnorderedAccessView(1, g_proofBuf12->GetGPUVirtualAddress());
        g_cmdList12->Dispatch(1, 1, 1);

        D3D12_RESOURCE_BARRIER barrier = { D3D12_RESOURCE_BARRIER_TYPE_TRANSITION };
        barrier.Transition.pResource = g_proofBuf12;
        barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_UNORDERED_ACCESS;
        barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_COPY_SOURCE;
        barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
        g_cmdList12->ResourceBarrier(1, &barrier);
        g_cmdList12->CopyResource(g_readback12, g_proofBuf12);
        barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_COPY_SOURCE;
        barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_UNORDERED_ACCESS;
        g_cmdList12->ResourceBarrier(1, &barrier);

        if (!gpu12_execute()) { if (elapsedMs) *elapsedMs = now_ms() - t0; return 0; }

        D3D12_RANGE range = { 0, 256 * 4 };
        void *mapped = NULL;
        if (SUCCEEDED(g_readback12->Map(0, &range, &mapped))) {
            const uint32_t *p = (const uint32_t*)mapped;
            for (int i = 0; i < 256; i++) {
                if (p[i] != 0xFFFFFFFF) {
                    foundNonce = p[i];
                    *outNonce = foundNonce;
                    *outHash = 1;
                    if (elapsedMs) *elapsedMs = now_ms() - t0;
                    g_readback12->Unmap(0, NULL);
                    return 1;
                }
            }
            g_readback12->Unmap(0, NULL);
        }
    }

    *outNonce = 0;
    if (elapsedMs) *elapsedMs = now_ms() - t0;
    return -1;
}

static void shutdown_d3d12(void) {
    if (g_fenceEvent12) { CloseHandle(g_fenceEvent12); g_fenceEvent12 = NULL; }
    if (g_fence12) { g_fence12->Release(); g_fence12 = NULL; }
    if (g_readback12) { g_readback12->Release(); g_readback12 = NULL; }
    if (g_proofBuf12) { g_proofBuf12->Release(); g_proofBuf12 = NULL; }
    if (g_loadBuf12) { g_loadBuf12->Release(); g_loadBuf12 = NULL; }
    if (g_proofPSO12) { g_proofPSO12->Release(); g_proofPSO12 = NULL; }
    if (g_loadPSO12) { g_loadPSO12->Release(); g_loadPSO12 = NULL; }
    if (g_rootSig12) { g_rootSig12->Release(); g_rootSig12 = NULL; }
    if (g_cmdList12) { g_cmdList12->Release(); g_cmdList12 = NULL; }
    if (g_cmdAlloc12) { g_cmdAlloc12->Release(); g_cmdAlloc12 = NULL; }
    if (g_cmdQueue12) { g_cmdQueue12->Release(); g_cmdQueue12 = NULL; }
    if (g_dev12) { g_dev12->Release(); g_dev12 = NULL; }
}

// ── DXGI adapter enumeration ─────────────────────────────────────────────
typedef struct {
    UINT index;
    char name[256];
    int isDiscrete;
    UINT dedicatedMb;
} AdapterInfo;

static int enum_adapters_dxgi(AdapterInfo *out, int maxOut) {
    IDXGIFactory1 *factory = NULL;
    HRESULT hr = CreateDXGIFactory1(IID_IDXGIFactory1, (void**)&factory);
    if (FAILED(hr)) return 0;
    int count = 0;
    for (UINT i = 0; i < (UINT)maxOut; i++) {
        IDXGIAdapter1 *adapter = NULL;
        hr = factory->EnumAdapters1(i, &adapter);
        if (FAILED(hr)) break;
        DXGI_ADAPTER_DESC1 desc;
        adapter->GetDesc1(&desc);
        WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, out[count].name, sizeof(out[count].name), NULL, NULL);
        out[count].index = i;
        out[count].isDiscrete = (desc.DedicatedVideoMemory > 512ULL * 1024 * 1024) ? 1 : 0;
        out[count].dedicatedMb = (UINT)(desc.DedicatedVideoMemory / (1024 * 1024));
        count++;
        adapter->Release();
    }
    factory->Release();
    return count;
}

// ── Adapter selection & backend auto-detect ──────────────────────────────
// DXGI enumeration with thread timeout (can hang on buggy GPU drivers)
struct EnumCtx {
    AdapterInfo *out;
    int maxOut;
    int result;
    HANDLE done;
};

static DWORD WINAPI enum_thread_fn(LPVOID p) {
    EnumCtx *ctx = (EnumCtx*)p;
    ctx->result = enum_adapters_dxgi(ctx->out, ctx->maxOut);
    SetEvent(ctx->done);
    return 0;
}

static int try_enum_adapters_dxgi(AdapterInfo *out, int maxOut, DWORD timeoutMs) {
    AdapterInfo *tmp = (AdapterInfo*)malloc(sizeof(AdapterInfo) * maxOut);
    if (!tmp) return 0;
    memset(tmp, 0, sizeof(AdapterInfo) * maxOut);
    HANDLE done = CreateEventA(NULL, TRUE, FALSE, NULL);
    if (!done) { free(tmp); return 0; }
    EnumCtx ctx = { tmp, maxOut, -1, done };
    HANDLE hThread = CreateThread(NULL, 0, enum_thread_fn, &ctx, 0, NULL);
    if (!hThread) { CloseHandle(done); free(tmp); return 0; }

    HANDLE wa[2] = { hThread, done };
    DWORD wait = WaitForMultipleObjects(2, wa, FALSE, timeoutMs);
    if (wait == WAIT_TIMEOUT) {
        CloseHandle(hThread);
        CloseHandle(done);
        return 0;
    }
    int count = ctx.result;
    if (count > 0) memcpy(out, tmp, sizeof(AdapterInfo) * count);
    free(tmp);
    CloseHandle(hThread);
    CloseHandle(done);
    return count > 0 ? count : 0;
}

static int try_backend(BackendType type, int adapterIdx, GpuInfo *info) {
    switch (type) {
        // All CreateDevice calls can hang on some GPU drivers. Use a thread
        // timeout (without TerminateThread) to avoid freezing the whole process.
        case BACKEND_D3D12: return try_init_timeout(init_d3d12, adapterIdx, info, 6000);
        case BACKEND_D3D11: return try_init_timeout(init_d3d11, adapterIdx, info, 6000);
        case BACKEND_D3D10: return try_init_timeout(init_d3d10, adapterIdx, info, 5000);
        case BACKEND_D3D9:  return try_init_timeout(init_d3d9, adapterIdx, info, 5000);
        default: return 0;
    }
}

static int select_gpu(void) {
    AdapterInfo adapters[MAX_ADAPTERS];
    int count = try_enum_adapters_dxgi(adapters, MAX_ADAPTERS, 5000);
    if (count == 0) return 0;

    // Sort: discrete GPUs first, then by dedicated VRAM descending
    for (int i = 0; i < count - 1; i++) {
        for (int j = i + 1; j < count; j++) {
            int swap = 0;
            if (adapters[j].isDiscrete && !adapters[i].isDiscrete) swap = 1;
            else if (adapters[j].isDiscrete == adapters[i].isDiscrete &&
                     adapters[j].dedicatedMb > adapters[i].dedicatedMb) swap = 1;
            if (swap) {
                AdapterInfo tmp = adapters[i];
                adapters[i] = adapters[j];
                adapters[j] = tmp;
            }
        }
    }

    // Backend priority: D3D11 > D3D12 > D3D10 > D3D9
    // D3D12 is tried after D3D11 because some drivers hang on D3D12CreateDevice.
    // D3D11 is ubiquitous (Windows 7+) and performance difference is negligible.
    BackendType backends[] = { BACKEND_D3D11, BACKEND_D3D12, BACKEND_D3D10, BACKEND_D3D9 };

    // Report available adapters
    json_out("{\"t\":\"enum\",\"adapters\":[");
    for (int i = 0; i < count; i++) {
        json_out("{\"idx\":%d,\"name\":\"%s\",\"discrete\":%d,\"vramMb\":%d}%s",
                 adapters[i].index, adapters[i].name, adapters[i].isDiscrete,
                 adapters[i].dedicatedMb, (i < count - 1) ? "," : "");
    }
    json_out("]}");

    int d3dTimedOut = 0;
    for (int a = 0; a < count; a++) {
        json_out("{\"t\":\"trying\",\"adapter\":\"%s\",\"idx\":%d}", adapters[a].name, adapters[a].index);
        for (int b = 0; b < 4; b++) {
            if (d3dTimedOut && backends[b] != BACKEND_D3D9) continue;
            BackendType bt = backends[b];
            GpuInfo cand;
            memset(&cand, 0, sizeof(cand));
            int ret = try_backend(bt, adapters[a].index, &cand);
            if (ret == 1) {
                g_info = cand;
                switch (g_info.type) {
                    case BACKEND_D3D12: g_init = init_d3d12; g_shutdown = shutdown_d3d12; g_dispatch_load = dispatch_load_d3d12; g_dispatch_proof = dispatch_proof_d3d12; g_dispatch_pow = dispatch_pow_d3d12; break;
                    case BACKEND_D3D11: g_init = init_d3d11; g_shutdown = shutdown_d3d11; g_dispatch_load = dispatch_load_d3d11; g_dispatch_proof = dispatch_proof_d3d11; g_dispatch_pow = dispatch_pow_d3d11; break;
                    case BACKEND_D3D10: g_init = init_d3d10; g_shutdown = shutdown_d3d10; g_dispatch_load = dispatch_load_d3d10; g_dispatch_proof = dispatch_proof_d3d10; g_dispatch_pow = dispatch_pow_d3d10; break;
                    case BACKEND_D3D9:  g_init = init_d3d9;  g_shutdown = shutdown_d3d9;  g_dispatch_load = dispatch_load_d3d9;  g_dispatch_proof = dispatch_proof_d3d9;  g_dispatch_pow = dispatch_pow_d3d9;  break;
                    default: break;
                }
                return 1;
            }
            if (ret == -1) d3dTimedOut = 1;
        }
    }
    return 0;
}

// ── JSON command handling ─────────────────────────────────────────────────
static void handle_cmd(const char *line) {
    if (strcmp(line, "quit") == 0) exit(0);
    if (strstr(line, "\"start\"") || strstr(line, "\"set\"")) {
        double pct = g_loadFrac * 100.0;
        const char *p = strstr(line, "\"loadPercent\"");
        if (p) { p = strchr(p, ':'); if (p) pct = atof(p + 1); }
        g_loadFrac = (pct < 0 ? 0 : (pct > 100 ? 100 : pct)) / 100.0;
        g_running = 1;
        json_out("{\"t\":\"ok\",\"loadPct\":%d}", (int)(g_loadFrac * 100));
    } else if (strstr(line, "\"stop\"")) {
        g_running = 0;
        g_measDuty = 0;
        json_out("{\"t\":\"ok\",\"loadPct\":0}");
    } else if (strstr(line, "\"proof\"")) {
        uint32_t seed = 0;
        const char *p = strstr(line, "\"seed\"");
        if (p) { p = strchr(p, ':'); if (p) seed = (uint32_t)atol(p + 1); }
        uint32_t w = 32, h = 32, iters = 32;
        p = strstr(line, "\"size\"");
        if (p) { p = strchr(p, ':'); if (p) { int s = atoi(p + 1); if (s > 0) { w = h = (uint32_t)s; } } }
        p = strstr(line, "\"iters\"");
        if (p) { p = strchr(p, ':'); if (p) { int v = atoi(p + 1); if (v > 0) iters = (uint32_t)v; } }
        double ms;
        uint32_t hash = g_dispatch_proof(seed, w, h, iters, &ms);
        json_out("{\"t\":\"proof\",\"seed\":%lu,\"hash\":%lu,\"ms\":%.1f}",
                 (unsigned long)seed, (unsigned long)hash, ms);
    } else if (strstr(line, "\"bench\"")) {
        // Run benchmark: measure load dispatch speed
        double t0 = now_ms();
        int frames = 0;
        while (now_ms() - t0 < 500.0 && frames < 200) {
            g_dispatch_load(2048, 2048, 4096, now_ms() * 0.001);
            frames++;
        }
        double elapsed = now_ms() - t0;
        double opsPerFrame = 2048.0 * 2048.0 * 4096.0 * 4.0; // MAD ops
        double score = (frames * opsPerFrame) / elapsed;
        json_out("{\"t\":\"bench\",\"frames\":%d,\"elapsedMs\":%.1f,\"score\":%.0f,\"opsPerMs\":%.0f}",
                 frames, elapsed, score, score);
    } else if (strstr(line, "\"pow\"")) {
        uint32_t seed = 0, difficulty = 65535;
        const char *p = strstr(line, "\"seed\"");
        if (p) { p = strchr(p, ':'); if (p) seed = (uint32_t)atol(p + 1); }
        p = strstr(line, "\"difficulty\"");
        if (p) { p = strchr(p, ':'); if (p) difficulty = (uint32_t)atoi(p + 1); }
        if (difficulty < 1) difficulty = 1;
        if (difficulty > 65535) difficulty = 65535;
        uint32_t startNonce = (uint32_t)(now_ms() * 1000);
        uint32_t outNonce = 0, outHash = 0;
        double ms;
        int found = g_dispatch_pow(seed, difficulty, startNonce, &outNonce, &outHash, &ms);
        if (found == 1) {
            json_out("{\"t\":\"pow\",\"nonce\":%lu,\"hash\":%lu,\"ms\":%.1f}",
                     (unsigned long)outNonce, (unsigned long)outHash, ms);
        } else {
            json_out("{\"t\":\"error\",\"msg\":\"pow not found in search range\"}");
        }
    } else if (strstr(line, "\"info\"")) {
        json_out("{\"t\":\"info\",\"backend\":\"%s\",\"adapter\":\"%s\",\"discrete\":%d,\"vramMb\":%llu,\"vendorId\":%u,\"deviceId\":%u}",
                 g_info.backendStr, g_info.adapterName, g_info.isDiscrete,
                 (unsigned long long)(g_info.dedicatedBytes / (1024 * 1024)),
                 g_info.vendorId, g_info.deviceId);
    }
}

static void pump_stdin(void) {
    char buf[4096];
    DWORD read;
    while (PeekNamedPipe(g_stdin, NULL, 0, NULL, &read, NULL) && read > 0) {
        if (!ReadFile(g_stdin, buf, sizeof(buf) - 1, &read, NULL) || read == 0) break;
        buf[read] = 0;
        char *line = buf;
        while (line && *line) {
            char *nl = strchr(line, '\n');
            if (nl) *nl = 0;
            char *cr = strchr(line, '\r');
            if (cr) *cr = 0;
            if (*line && g_gpuReady) handle_cmd(line);
            if (!nl) break;
            line = nl + 1;
        }
    }
}

// ── Entry point ──────────────────────────────────────────────────────────
int main(int argc, char *argv[]) {
    // Parse --adapter N to select a specific GPU index (0-based).
    // When omitted the binary auto-selects the best GPU.
    int forceAdapter = -1;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--adapter") == 0 && i + 1 < argc) {
            forceAdapter = atoi(argv[++i]);
        }
    }

    // DLL injection mitigation: only search system32 for implicit DLL loads
    SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);

    g_stdin = GetStdHandle(STD_INPUT_HANDLE);
    g_stdout = GetStdHandle(STD_OUTPUT_HANDLE);
    _setmode(_fileno(stdout), _O_BINARY);
    _setmode(_fileno(stdin), _O_BINARY);

    if (forceAdapter >= 0) {
        // Try only the specified adapter index
        AdapterInfo adapters[MAX_ADAPTERS];
        int count = try_enum_adapters_dxgi(adapters, MAX_ADAPTERS, 5000);
        if (forceAdapter >= count) {
            json_out("{\"t\":\"error\",\"msg\":\"Adapter index %d not found (have %d)\"}", forceAdapter, count);
            return 1;
        }
        GpuInfo cand;
        memset(&cand, 0, sizeof(cand));
        BackendType backends[] = { BACKEND_D3D11, BACKEND_D3D12, BACKEND_D3D10, BACKEND_D3D9 };
        int d3dTimedOut = 0;
        int ok = 0;
        for (int b = 0; b < 4 && !ok; b++) {
            if (d3dTimedOut && backends[b] != BACKEND_D3D9) continue;
            int ret = try_backend(backends[b], forceAdapter, &cand);
            if (ret == 1) ok = 1;
            if (ret == -1) d3dTimedOut = 1;
        }
        if (!ok) {
            json_out("{\"t\":\"error\",\"msg\":\"No compatible DirectX backend for adapter %d\"}", forceAdapter);
            return 1;
        }
        g_info = cand;
        switch (g_info.type) {
            case BACKEND_D3D12: g_init = init_d3d12; g_shutdown = shutdown_d3d12; g_dispatch_load = dispatch_load_d3d12; g_dispatch_proof = dispatch_proof_d3d12; g_dispatch_pow = dispatch_pow_d3d12; break;
            case BACKEND_D3D11: g_init = init_d3d11; g_shutdown = shutdown_d3d11; g_dispatch_load = dispatch_load_d3d11; g_dispatch_proof = dispatch_proof_d3d11; g_dispatch_pow = dispatch_pow_d3d11; break;
            case BACKEND_D3D10: g_init = init_d3d10; g_shutdown = shutdown_d3d10; g_dispatch_load = dispatch_load_d3d10; g_dispatch_proof = dispatch_proof_d3d10; g_dispatch_pow = dispatch_pow_d3d10; break;
            case BACKEND_D3D9:  g_init = init_d3d9;  g_shutdown = shutdown_d3d9;  g_dispatch_load = dispatch_load_d3d9;  g_dispatch_proof = dispatch_proof_d3d9;  g_dispatch_pow = dispatch_pow_d3d9;  break;
            default: break;
        }
    } else {
        if (!select_gpu()) {
            json_out("{\"t\":\"error\",\"msg\":\"No compatible GPU or DirectX backend found\"}");
            return 1;
        }
    }
    g_gpuReady = 1;

    // Signal ready — must be after select_gpu() so g_info is populated
    json_out("{\"t\":\"ready\",\"ver\":3,\"backend\":\"%s\",\"adapter\":\"%s\",\"discrete\":%d,\"vramMb\":%llu,\"vendorId\":%u,\"deviceId\":%u}",
             g_info.backendStr, g_info.adapterName, g_info.isDiscrete,
             (unsigned long long)(g_info.dedicatedBytes / (1024 * 1024)),
             g_info.vendorId, g_info.deviceId);

    timeBeginPeriod(1);

    int tick = 0;
    double burnSum = 0, cycleSum = 0;
    int frameCount = 0;
    double lastDispatchTime = now_ms();

    while (1) {
        char buf[256];
        {
            double t = now_ms();
            pump_stdin();
            double dt = now_ms() - t;
            if (dt > 0.5) {
                snprintf(buf, sizeof(buf), "[gpu] main_loop pump_stdin took %.2fms t=%.0f\n", dt, now_ms()); ods_out(buf);
            }
        }

        if (g_running && g_loadFrac > 0.001) {
            double t0 = now_ms();
            double gapMs = t0 - lastDispatchTime;
            if (gapMs > 1000.0) {
                snprintf(buf, sizeof(buf), "[gpu] main_loop GAP %.0fms since last dispatch loadFrac=%.3f duty=%.4f t=%.0f\n", gapMs, g_loadFrac, g_measDuty, t0); ods_out(buf);
            }
            lastDispatchTime = t0;
            snprintf(buf, sizeof(buf), "[gpu] main_loop dispatch_load_enter frac=%.3f t=%.0f\n", g_loadFrac, t0); ods_out(buf);
            g_dispatch_load(2048, 2048, 256, t0 * 0.001);
            double burnMs = now_ms() - t0;
            if (burnMs < 0.2) burnMs = 0.2;

            double idleMs = g_loadFrac >= 1.0 ? 0 :
                burnMs * (1.0 - g_loadFrac) / g_loadFrac;

            burnSum += burnMs;
            cycleSum += burnMs + idleMs;
            frameCount++;
            g_measDuty = cycleSum > 0 ? burnSum / cycleSum : 0;

            if (idleMs >= TIMER_FLOOR_MS) {
                snprintf(buf, sizeof(buf), "[gpu] main_loop idleSleep %.2fms burnMs=%.2f t=%.0f\n", idleMs, burnMs, now_ms()); ods_out(buf);
                Sleep((DWORD)(idleMs + 0.5));
            } else {
                Sleep(0);
            }
        } else {
            g_measDuty = 0;
            if (g_running && g_loadFrac <= 0.001) {
                snprintf(buf, sizeof(buf), "[gpu] main_loop stopped frac=%.3f t=%.0f\n", g_loadFrac, now_ms()); ods_out(buf);
            }
            Sleep(50);
        }

        if (++tick >= 10) {
            tick = 0;
            json_out("{\"t\":\"status\",\"run\":%d,\"pct\":%d,\"duty\":%.4f}",
                     g_running, (int)(g_loadFrac * 100), g_measDuty);
            if (frameCount > 100) { burnSum *= 0.5; cycleSum *= 0.5; }
        }
    }

    g_shutdown();
    return 0;
}

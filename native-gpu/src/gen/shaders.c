/* Generated shader source strings - do not edit */
// Generated from compute.hlsl - do not edit
static const char g_compute_hlsl[] =
    "RWStructuredBuffer<float4> output : register(u0);\n\ncbuffer constants : register(b0) {\n    float u_param;\n    uint width;\n    uint height;\n    uint iterations;\n};\n\n[numthreads(16, 16, 1)]\nvoid CSMain(uint3 id : SV_DispatchThreadID) {\n    if (id.x >= width || id.y >= height) return;\n\n    float4 v = float4(id.x * 1.0 / width, id.y * 1.0 / height, u_param, 1.0 - u_param);\n    for (uint i = 0; i < iterations; i++) {\n        v.x = v.x * v.y + v.z * 0.00013;\n        v.y = v.y * v.z + v.w * 0.00017;\n        v.z = v.z * v.w + v.x * 0.00019;\n        v.w = v.w * v.x + v.y * 0.00023;\n    }\n    output[id.y * width + id.x] = v;\n}\n";

// Generated from proof.hlsl - do not edit
static const char g_proof_hlsl[] =
    "RWStructuredBuffer<uint> output : register(u0);\n\ncbuffer constants : register(b0) {\n    int seed;\n    uint width;\n    uint height;\n    uint _pad;\n};\n\n[numthreads(16, 16, 1)]\nvoid CSMain(uint3 id : SV_DispatchThreadID) {\n    if (id.x >= width || id.y >= height) return;\n\n    int x = (int)(id.x * 1000003) ^ (int)(id.y * 7919) ^ seed;\n    x |= 1;\n    for (uint i = 0; i < 32; i++) {\n        x ^= x << 13;\n        x ^= x >> 17;\n        x ^= x << 5;\n    }\n    output[id.y * width + id.x] = (uint)x;\n}\n";
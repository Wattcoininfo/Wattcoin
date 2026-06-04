// D3D9 pixel shader 3.0 — GPU load via float MAD operations
// Compiled with: fxc /T ps_3_0 /E PSMain /O3 d3d9_load.hlsl

float4 c0 : register(c0); // c0.x = time param, c0.y = width, c0.z = height, c0.w = iterations

float4 PSMain(float4 pos : POSITION, float2 uv : TEXCOORD0) : COLOR0 {
    float2 fragCoord = uv * float2(c0.y, c0.z);
    float4 v = float4(fragCoord.x / c0.y, fragCoord.y / c0.z, c0.x, 1.0 - c0.x);
    // Loop unrolling would exceed instruction limit, use a moderate iteration count
    // PS 3.0: max 512 arithmetic instructions, ~64 MAD iterations per pixel
    float iters = min(c0.w, 64.0);
    for (float i = 0; i < iters; i += 1.0) {
        v.x = v.x * v.y + v.z * 0.00013;
        v.y = v.y * v.z + v.w * 0.00017;
        v.z = v.z * v.w + v.x * 0.00019;
        v.w = v.w * v.x + v.y * 0.00023;
    }
    return v;
}

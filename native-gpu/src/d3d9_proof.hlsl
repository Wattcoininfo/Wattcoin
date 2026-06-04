// D3D9 pixel shader 3.0 — proof computation (float-emulated XOR-shift)
// D3D9 PS 3.0 has no integer bitwise ops, so we use a deterministic float polynomial.
// This is NOT bit-identical to the integer shader — timing-only verification.
// Compiled with: fxc /T ps_3_0 /E PSMain /O3 d3d9_proof.hlsl

float4 c0 : register(c0); // c0.x = seed (float), c0.y = width, c0.z = height, c0.w = iters

// Emulate XOR-shift using float arithmetic:
// Instead of x ^= x << 13, we do x = x * (1 + 2^13) mod 2^32 approximated in floats
// This is lossy but deterministic for the same seed
float pseudo_xorshift(float x, float iters) {
    for (float i = 0; i < iters; i += 1.0) {
        // Approximate XOR with left-shift: x ^ (x << 13)
        float t1 = x * 8192.0; // 2^13
        // Simple float mix (not true XOR but deterministic)
        x = fmod(x * 1.0001 + t1 * 0.9999, 16777216.0);
        // Right shift approx: x ^ (x >> 17)
        float t2 = floor(x / 131072.0); // 2^17
        x = fmod(x * 0.9999 + t2 * 1.0001, 16777216.0);
        // Left shift approx: x ^ (x << 5)
        float t3 = x * 32.0; // 2^5
        x = fmod(x * 1.0001 + t3 * 0.9999, 16777216.0);
    }
    return x;
}

float4 PSMain(float4 pos : POSITION, float2 uv : TEXCOORD0) : COLOR0 {
    float2 fragCoord = uv * float2(c0.y, c0.z);
    float px = floor(fragCoord.x) + 0.5;
    float py = floor(fragCoord.y) + 0.5;
    // Deterministic pseudo-random based on position and seed
    float x = fmod(px * 1000003.0 + py * 7919.0 + c0.x, 16777216.0);
    x = pseudo_xorshift(x, min(c0.w, 32.0));
    // Pack into RGBA (24-bit mantissa precision)
    float r = floor(fmod(x, 256.0));
    float g = floor(fmod(x / 256.0, 256.0));
    float b = floor(fmod(x / 65536.0, 256.0));
    float a = floor(fmod(x / 16777216.0, 256.0));
    return float4(r / 255.0, g / 255.0, b / 255.0, a / 255.0);
}

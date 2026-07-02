RWStructuredBuffer<uint> output : register(u0);

cbuffer constants : register(b0) {
    uint seed;
    uint difficulty;
    uint startNonce;
    uint _pad;
};

[numthreads(16, 16, 1)]
void CSMain(uint3 id : SV_DispatchThreadID) {
    uint globalId = id.x + id.y * 16;
    uint nonce = startNonce + globalId;

    // Derive a unique seed from the base seed and nonce
    uint s = seed ^ (nonce * 1000003) ^ ((nonce >> 16) * 7919);
    s |= 1;

    // Compute the xor-shift proof hash (matches computeGpuProbeExpectedHash in JS)
    uint h = 5381;
    for (uint p = 0; p < 1024; p += 4) {
        uint row = p / 32;
        uint col = p % 32;
        int x = (int)((col * 1000003) ^ (row * 7919) ^ s);
        x |= 1;
        for (uint i = 0; i < 50000; i++) {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
        }
        h = ((h << 5) + h + ((x >> 24) & 255));
        h = ((h << 5) + h + ((x >> 16) & 255));
        h = ((h << 5) + h + ((x >> 8) & 255));
        h = ((h << 5) + h + (x & 255));
    }

    if ((h & 0xFFFF) < difficulty) {
        output[globalId] = nonce;
    } else {
        output[globalId] = 0xFFFFFFFF;
    }
}

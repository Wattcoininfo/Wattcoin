RWStructuredBuffer<uint> output : register(u0);

cbuffer constants : register(b0) {
    int seed;
    uint width;
    uint height;
    uint _pad;
};

[numthreads(16, 16, 1)]
void CSMain(uint3 id : SV_DispatchThreadID) {
    if (id.x >= width || id.y >= height) return;

    int x = (int)(id.x * 1000003) ^ (int)(id.y * 7919) ^ seed;
    x |= 1;
    for (uint i = 0; i < 32; i++) {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
    }
    output[id.y * width + id.x] = (uint)x;
}

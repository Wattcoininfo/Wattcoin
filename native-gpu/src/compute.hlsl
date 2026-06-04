RWStructuredBuffer<float4> output : register(u0);

cbuffer constants : register(b0) {
    float u_param;
    uint width;
    uint height;
    uint iterations;
};

[numthreads(16, 16, 1)]
void CSMain(uint3 id : SV_DispatchThreadID) {
    if (id.x >= width || id.y >= height) return;

    float4 v = float4(id.x * 1.0 / width, id.y * 1.0 / height, u_param, 1.0 - u_param);
    for (uint i = 0; i < iterations; i++) {
        v.x = v.x * v.y + v.z * 0.00013;
        v.y = v.y * v.z + v.w * 0.00017;
        v.z = v.z * v.w + v.x * 0.00019;
        v.w = v.w * v.x + v.y * 0.00023;
    }
    output[id.y * width + id.x] = v;
}

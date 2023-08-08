layout(std140) uniform Camera {
    CameraUniforms camera;
};

layout(std140) uniform Clipping {
    ClippingUniforms clipping;
};

layout(std140) uniform Outline {
    OutlineUniforms outline;
};

layout(std140) uniform Node {
    NodeUniforms node;
};

in struct {
    vec3 positionVS;
    float opacity;
} varyings;

flat in struct {
    uint objectId;
} varyingsFlat;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out uvec4 fragPick;

void main() {
    float s = clipping.mode == clippingModeIntersection ? -1.f : 1.f;
    bool inside = clipping.mode == clippingModeIntersection ? (clipping.numPlanes + (outline.planeIndex >= 0 ? 1u : 0u) ) > 0U : true;
    for(uint i = 0u; i < clipping.numPlanes; i++) {
        if (int(i) == outline.planeIndex) {
            inside = inside && clipping.mode != clippingModeIntersection;
        } else {
            inside = inside && dot(vec4(varyings.positionVS, 1), clipping.planes[i]) * s < 0.f;
        }
    }
    if(clipping.mode == clippingModeIntersection ? inside : !inside) {
        discard;
    }

    fragColor = vec4(outline.color, varyings.opacity);
    float linearDepth = -varyings.positionVS.z;
    #if defined (ADRENO600)
    fragPick = uvec4(varyingsFlat.objectId, 0, 0, floatBitsToUint(linearDepth));
#else
    fragPick = uvec4(varyingsFlat.objectId, packNormalAndDeviation(vec3(0), uintBitsToFloat(0x7f800000U)), floatBitsToUint(linearDepth));
#endif
}

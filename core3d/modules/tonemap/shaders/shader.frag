layout(std140) uniform Tonemapping {
    TonemappingUniforms tonemapping;
};

uniform TonemappingTextures textures;

in TonemappingVaryings varyings;

layout(location = 0) out lowp vec4 fragColor;

uint hash(uint x) {
    x += (x << 10u);
    x ^= (x >> 6u);
    x += (x << 3u);
    x ^= (x >> 11u);
    x += (x << 15u);
    return x;
}

// ACES tone map (faster approximation)
// see: https://knarkowicz.wordpress.com/2016/01/06/aces-filmic-tone-mapping-curve/
mediump vec3 toneMapACES_Narkowicz(mediump vec3 color) {
    const mediump float A = 2.51f;
    const mediump float B = 0.03f;
    const mediump float C = 2.43f;
    const mediump float D = 0.59f;
    const mediump float E = 0.14f;
    return clamp((color * (A * color + B)) / (color * (C * color + D) + E), 0.0f, 1.0f);
}

// ACES filmic tone map approximation
// see https://github.com/TheRealMJP/BakingLab/blob/master/BakingLab/ACES.hlsl
mediump vec3 RRTAndODTFit(mediump vec3 color) {
    mediump vec3 a = color * (color + 0.0245786f) - 0.000090537f;
    mediump vec3 b = color * (0.983729f * color + 0.4329510f) + 0.238081f;
    return a / b;
}

void main() {
    mediump vec4 color = vec4(1, 0, 0, 1);
    switch(tonemapping.mode) {
        case tonemapModeColor: {
            color = texture(textures.color, varyings.uv);
            color.rgb = RRTAndODTFit(color.rgb * tonemapping.exposure);
            color.rgb = linearTosRGB(color.rgb);
            break;
        }
        case tonemapModeNormal: {
            vec3 xyz = unpackNormalAndDeviation(texture(textures.pick, varyings.uv).yz).xyz;
            if(any(isnan(xyz))) {
                color.rgb = vec3(0);
            } else {
                color.rgb = xyz * .5f + .5f;
            }
            break;
        }
        case tonemapModeDepth: {
            float linearDepth = uintBitsToFloat(texture(textures.pick, varyings.uv).w);
            if(isinf(linearDepth)) {
                color.rgb = vec3(0, 0, 0.25f);
            } else {
                float i = (linearDepth / tonemapping.maxLinearDepth);
                color.rgb = vec3(pow(i, 0.5f));
            }
            break;
        }
        case tonemapModeObjectId: {
            uint objectId = texture(textures.pick, varyings.uv).x;
            if(objectId == 0xffffffffU) {
                color.rgb = vec3(0);
            } else {
                // color.rgb = vec3(0,1,1);
                uint rgba = hash(~objectId);
                float r = float((rgba >> 16U) & 0xffU) / 255.f;
                float g = float((rgba >> 8U) & 0xffU) / 255.f;
                float b = float((rgba >> 0U) & 0xffU) / 255.f;
                color.rgb = vec3(r, g, b);
            }
            break;
        }
        case tonemapModeDeviation: {
            float deviation = unpackNormalAndDeviation(texture(textures.pick, varyings.uv).yz).w;
            color.rgb = deviation > 0.f ? vec3(0, deviation / tonemapMaxDeviation, 0) : vec3(-deviation / tonemapMaxDeviation, 0, 0);
            break;
        }
        case tonemapModeZbuffer: {
            float z = texture(textures.zbuffer, varyings.uv).x;
            color.rgb = vec3(z);
            break;
        }
    }
    fragColor = color;
}

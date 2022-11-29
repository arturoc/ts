layout(std140) uniform Camera {
    mat4 clipViewMatrix;
    mat4 viewClipMatrix;
    mat3 worldViewMatrixNormal;
    mat3 viewWorldMatrixNormal;
} camera;

layout(std140) uniform Materials {
    uvec4 rgba[64];
} materials;

layout(std140) uniform Node {
    mat4 objectClipMatrix;
    vec4 debugColor;
} node;

struct Varyings {
    vec3 normal;
    vec4 color;
};
in Varyings varyings;

layout(location = 0) out vec4 fragColor;

void main() {
    // fragColor = vec4(normal * .5 + .5, 0.1);
    fragColor = varyings.color;
}

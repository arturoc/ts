import type { DerivedRenderState, RenderContext } from "core3d";
import { RenderModuleContext, RenderModule } from "..";
import { createUniformsProxy, glBuffer, glProgram, glDraw, glState, glDelete, glVertexArray, glTransformFeedback, UniformTypes } from "webgl2";
import { mat4, ReadonlyVec3, vec3 } from "gl-matrix";
import vertexShader from "./shader.vert";
import fragmentShader from "./shader.frag";
import line_vs from "./line.vert";
import line_fs from "./line.frag";
import intersect_vs from "./intersect.vert";

export class CubeModule implements RenderModule {
    readonly uniforms = {
        modelLocalMatrix: "mat4",
        nearOutlineColor: "vec3",
    } as const satisfies Record<string, UniformTypes>;

    withContext(context: RenderContext) {
        return new CubeModuleContext(context, this);
    }
}

class CubeModuleContext implements RenderModuleContext {
    readonly uniforms;
    readonly resources;

    constructor(readonly context: RenderContext, readonly data: CubeModule) {
        this.uniforms = createUniformsProxy(data.uniforms);
        const { gl, commonChunk } = context;
        const vertices = createVertices((pos, norm, col) => ([...pos, ...norm, ...col]));
        const pos = createVertices((pos) => (pos));
        const indices = createIndices();
        const triplets = new Float32Array(indices.length * 3);
        for (let i = 0; i < indices.length; i += 3) {
            const [a, b, c] = indices.slice(i, i + 3);
            const pa = pos.slice(a * 3, (a + 1) * 3);
            const pb = pos.slice(b * 3, (b + 1) * 3);
            const pc = pos.slice(c * 3, (c + 1) * 3);
            triplets.set(pa, i * 3 + 0);
            triplets.set(pb, i * 3 + 3);
            triplets.set(pc, i * 3 + 6);
        }

        // create static GPU resources here
        const program = glProgram(gl, { vertexShader, fragmentShader, commonChunk, uniformBufferBlocks: ["Camera", "Clipping", "Cube"] });
        const program_line = glProgram(gl, { vertexShader: line_vs, fragmentShader: line_fs, commonChunk, uniformBufferBlocks: ["Camera", "Clipping", "Cube"] });
        const program_transform = glProgram(gl, { vertexShader: intersect_vs, commonChunk, uniformBufferBlocks: ["Camera", "Cube"], transformFeedback: { varyings: ["line_vertices"], bufferMode: "INTERLEAVED_ATTRIBS" } });
        const uniforms = glBuffer(gl, { kind: "UNIFORM_BUFFER", srcData: this.uniforms.buffer });

        const vb = glBuffer(gl, { kind: "ARRAY_BUFFER", srcData: vertices });
        const ib = glBuffer(gl, { kind: "ELEMENT_ARRAY_BUFFER", srcData: indices });
        const vao = glVertexArray(gl, {
            attributes: [
                { kind: "FLOAT_VEC3", buffer: vb, stride: 36, offset: 0 }, // position
                { kind: "FLOAT_VEC3", buffer: vb, stride: 36, offset: 12 }, // normal
                { kind: "FLOAT_VEC3", buffer: vb, stride: 36, offset: 24 }, // color
            ],
            indices: ib
        });
        gl.deleteBuffer(vb);
        gl.deleteBuffer(ib);

        const vb_tri = glBuffer(gl, { kind: "ARRAY_BUFFER", srcData: triplets });
        const vao_tri = glVertexArray(gl, {
            attributes: [
                { kind: "FLOAT_VEC3", buffer: vb_tri, stride: 36, offset: 0 }, // position 0
                { kind: "FLOAT_VEC3", buffer: vb_tri, stride: 36, offset: 12 }, // position 1
                { kind: "FLOAT_VEC3", buffer: vb_tri, stride: 36, offset: 24 }, // position 2
            ],
        });
        gl.deleteBuffer(vb_tri);

        const transformFeedback = gl.createTransformFeedback()!;

        const vb_line = glBuffer(gl, { kind: "ARRAY_BUFFER", size: 12 * 2 * 8, usage: "STATIC_DRAW" });
        const vao_line = glVertexArray(gl, {
            attributes: [
                { kind: "FLOAT_VEC2", buffer: vb_line, stride: 8, offset: 0 }, // position
            ],
        });
        this.resources = { program, program_transform, program_line, uniforms, vao, transformFeedback, vao_tri, vao_line, vb_line } as const;
    }

    update(state: DerivedRenderState) {
        const { context, resources } = this;
        const { cube, localSpaceTranslation, outlines } = state;
        const { values } = this.uniforms;
        if (context.hasStateChanged({ cube, localSpaceTranslation })) {
            const { scale, position } = cube;
            const posLS = vec3.subtract(vec3.create(), position, localSpaceTranslation);
            const m = [
                scale, 0, 0, 0,
                0, scale, 0, 0,
                0, 0, scale, 0,
                ...posLS, 1
            ] as Parameters<typeof mat4.fromValues>;
            values.modelLocalMatrix = mat4.fromValues(...m);
        }
        if (context.hasStateChanged({ outlines })) {
            values.nearOutlineColor = outlines.nearClipping.color;
        }
        context.updateUniformBuffer(resources.uniforms, this.uniforms);
    }

    render(state: DerivedRenderState) {
        const { context, resources } = this;
        const { program, program_line, program_transform, uniforms, vao, transformFeedback, vao_tri, vao_line, vb_line } = resources;
        const { gl, cameraUniforms, clippingUniforms } = context;

        if (state.cube.enabled) {
            // render normal cube
            glState(gl, {
                program,
                uniformBuffers: [cameraUniforms, clippingUniforms, uniforms],
                drawBuffers: ["COLOR_ATTACHMENT0", "COLOR_ATTACHMENT1", "COLOR_ATTACHMENT2", "COLOR_ATTACHMENT3"],
                depthTest: true,
                cullEnable: false,
                vertexArrayObject: vao,
            });
            glDraw(gl, { kind: "elements", mode: "TRIANGLES", indexType: "UNSIGNED_SHORT", count: 36 });

            if (state.outlines.nearClipping.enable) {
                // transform vertex triplets into intersection lines
                glState(gl, {
                    program: program_transform,
                    uniformBuffers: [cameraUniforms, uniforms],
                    vertexArrayObject: vao_tri,
                });
                glTransformFeedback(gl, { kind: "POINTS", transformFeedback, outputBuffers: [vb_line], count: 12 });

                // render intersection lines
                glState(gl, {
                    program: program_line,
                    drawBuffers: ["COLOR_ATTACHMENT0"],
                    depthTest: true,
                    vertexArrayObject: vao_line,
                });
                glDraw(gl, { kind: "arrays", mode: "LINES", count: 12 * 2 });
            }
        }
    }

    contextLost(): void {
    }

    dispose() {
        const { context, resources } = this;
        const { gl } = context;
        this.contextLost();
        glDelete(gl, resources);
    }
}

function createVertices(pack: (position: ReadonlyVec3, normal: ReadonlyVec3, color: ReadonlyVec3) => Iterable<number>) {
    function face(x: ReadonlyVec3, y: ReadonlyVec3, color: ReadonlyVec3) {
        const normal = vec3.cross(vec3.create(), y, x);
        function vert(fx: "add" | "sub", fy: "add" | "sub") {
            const pos = vec3.clone(normal);
            vec3[fx](pos, pos, x);
            vec3[fy](pos, pos, y);
            return pack(pos, normal, color);
            // return [...pos, ...normal, ...color];
        }
        return [
            ...vert("sub", "sub"),
            ...vert("add", "sub"),
            ...vert("sub", "add"),
            ...vert("add", "add"),
        ];
    }

    return new Float32Array([
        ...face([0, 0, -1], [0, 1, 0], [1, 0, 0]), // right (1, 0, 0)
        ...face([0, 0, 1], [0, 1, 0], [0, 1, 1]), // left (-1, 0, 0)
        ...face([1, 0, 0], [0, 0, 1], [0, 1, 0]), // top (0, 1, 0)
        ...face([1, 0, 0], [0, 0, -1], [1, 0, 1]), // bottom (0, -1, 0)
        ...face([1, 0, 0], [0, 1, 0], [0, 0, 1]), // front (0, 0, 1)
        ...face([-1, 0, 0], [0, 1, 0], [1, 1, 0]), // back (0, 0, -1)
    ])
}

function createIndices() {
    let idxOffset = 0;
    function face() {
        const idx = [0, 2, 1, 1, 2, 3].map(i => i + idxOffset);
        idxOffset += 4;
        return idx;
    }
    return new Uint16Array([
        ...face(),
        ...face(),
        ...face(),
        ...face(),
        ...face(),
        ...face(),
    ]);
}
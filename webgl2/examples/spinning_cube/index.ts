import { WebGL2Renderer } from "webgl2";
import vertexShader from "./shader.vert";
import fragmentShader from "./shader.frag";
import { mat4, ReadonlyVec3, vec3 } from "gl-matrix";

export async function spinning_cube(renderer: WebGL2Renderer) {
    const program = renderer.createProgram({ vertexShader, fragmentShader, uniformBufferBlocks: ["Uniforms"] });
    const uniformBuffer = renderer.createBuffer({ kind: "UNIFORM_BUFFER", size: 4 * 4 * 4 })
    // const proj = renderer.gl.getUniformLocation(program, "proj");
    const vb = renderer.createBuffer({ kind: "ARRAY_BUFFER", srcData: createVertices() });
    const ib = renderer.createBuffer({ kind: "ELEMENT_ARRAY_BUFFER", srcData: createIndices() });
    const vao = renderer.createVertexArray({
        attributes: [
            { kind: "FLOAT_VEC3", buffer: vb, stride: 24, }, // position
            { kind: "FLOAT_VEC3", buffer: vb, stride: 24, offset: 12 } // color
        ],
        indices: ib
    });

    return function draw(time: number) {
        const { width, height } = renderer.canvas;
        const viewProjMtx = generateMatrix(time, width / height);
        renderer.update({ kind: "UNIFORM_BUFFER", srcData: new Float32Array(viewProjMtx), targetBuffer: uniformBuffer });
        renderer.state({
            viewport: { width, height },
            uniformBuffers: [uniformBuffer],
            program,
            cullEnable: true,
            depthTest: true,
            // uniforms: [{ kind: "Matrix4f", location: proj, value: [...viewProjMtx] }],
            vertexArrayObject: vao,
        });

        renderer.clear({ kind: "back_buffer", color: [0, 0, .25, 1] });
        renderer.draw({ kind: "elements", mode: "TRIANGLES", indexType: "UNSIGNED_SHORT", count: 36 });
    }
}

function generateMatrix(time: number, aspectRatio: number) {
    const fovY = 45 * Math.PI / 180;
    const mtxObj = mat4.fromRotation(mat4.create(), time / 1000, vec3.fromValues(0, 1, 0));
    const mtxView = mat4.lookAt(mat4.create(), vec3.fromValues(0, 3, -5), vec3.create(), vec3.fromValues(0, 1, 0));
    const mtxProj = mat4.perspective(mat4.create(), fovY, aspectRatio, 1, 1000);
    const mtx = mat4.create();
    mat4.mul(mtx, mtx, mtxProj)
    mat4.mul(mtx, mtx, mtxView)
    mat4.mul(mtx, mtx, mtxObj)
    return mtx;
}

function createVertices() {
    function face(x: ReadonlyVec3, y: ReadonlyVec3, color: ReadonlyVec3) {
        const z = vec3.cross(vec3.create(), y, x);
        function vert(fx: "add" | "sub", fy: "add" | "sub") {
            const v = vec3.clone(z);
            vec3[fx](v, v, x);
            vec3[fy](v, v, y);
            return [...v, ...color];
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
import { vec3, type ReadonlyMat4, type ReadonlyVec3, type ReadonlyVec4, mat4, vec2, type ReadonlyVec2, vec4 } from "gl-matrix";
import type { OctreeModuleContext, RenderNode } from "./context";
import { orthoNormalBasisMatrixFromPlane } from "core3d/util";
import { glCreateBuffer, glCreateVertexArray, glDelete, glDraw, glState } from "webgl2";
import { OctreeNode } from "./node";
import type { Mesh } from "./mesh";
import type { WasmInstance } from "./worker/wasm_loader";
import type { Arena } from "@novorender/wasm-parser";

type NodeLineVertices = Map<number, LineVertices>; // key: child_index

// type LineVertices = readonly ReadonlyVec2[]; // use Float32Array instead?;
type LineVertices = Float32Array;
type ChildIndex = number;
type ObjectIndex = number;

interface ChildRange {
    readonly childIndex: number;
    readonly begin: number;
    readonly end: number;
}


class NodeIntersection {
    constructor(
        // readonly pointsVAO: WebGLVertexArrayObject, // edge intersections
        readonly lineRanges: readonly ChildRange[],
        readonly linesVAO: WebGLVertexArrayObject, // triangle intersections
        // TODO: Add triangles VAO for void filling
    ) { }

    render(mask: number) {
        // we need render context (and possibly render state) here...
    }
}

class NodeIntersectionBuilder {
    static readonly maxBufferSize = 0x100000;
    offset = 0;
    // get outputBuffer() { return this.buffer.subarray(this.offset); }
    emitVertex(x: number, y: number): void {
        this.buffer[this.offset++] = x;
        this.buffer[this.offset++] = y;
    }

    constructor(readonly buffer: Float32Array, readonly ownedBuffer: boolean) {

    }

    vertices() {
        if (this.ownedBuffer){
            return this.buffer.subarray(0, this.offset)
        }else{
            return this.buffer.slice(0, this.offset)
        }
    }
}


/*
Just as with object highlights, we can do intersection testing at load time.
This means we already have everything in system memory and no copies are needed.
Also, we can probably save memory (and performance) by clipping against all clipping planes in the process.
We could even do void filling with triangles here by clipping to node boundaries.

For rendering it's probably a good idea to keep a separate VAO per node,
possibly with draw ranges/multidraw, just like normal rendering would.

We can also render the clipping plane in separate 2D space.

For analysis/measurement, we should probably copy from GPU memory on demand (per node) and combine into singular/global lists.
We could also merge line segment soup into strips and loops, merging partial lines and optimizing in the process.

How do we stay within GPU memory budget?
*/

// TODO: Alloc fixed sized render buffer(s) and draw in batches.
// TODO: Reuse previous render buffers if nothing has changed since last frame
// TODO: Ignore transparent meshes/materials
// TODO: Apply alpha from intersection normal
// TODO: Render lines with quads instead.
// TODO: Render edge intersections as circles.
// TODO: Do intersection tests at load time (and store in cache)
// TODO: Render per node (no need to merge into single/big VB).
// TODO: Apply highlighting.
// TODO: Combine all clipping planes in same renderer.
// TODO: Fill in voids with texture/polys.

export class OutlineRenderer {
    static readonly denormMatrix = normInt16ToFloatMatrix();
    readonly planeLocalMatrix: ReadonlyMat4;
    readonly localPlaneMatrix: ReadonlyMat4;
    readonly nodeLinesCache = new WeakMap<OctreeNode, NodeLineVertices>();
    readonly nodeIntersectionCache = new WeakMap<OctreeNode, NodeIntersection>();

    constructor(
        readonly context: OctreeModuleContext,
        readonly localSpaceTranslation: ReadonlyVec3,
        readonly plane: ReadonlyVec4,
    ) {
        const { planeLocalMatrix, localPlaneMatrix } = planeMatrices(plane, localSpaceTranslation);
        this.planeLocalMatrix = planeLocalMatrix;
        this.localPlaneMatrix = localPlaneMatrix;
    }

    *intersectTriangles(wasm: WasmInstance | undefined, arena: Arena | undefined, renderNodes: readonly RenderNode[]): IterableIterator<LineVertices> {
        for (const { mask, node } of renderNodes) {
            if (node.intersectsPlane(this.plane)) {
                const nodeLineVertices = this.nodeLinesCache.get(node) ?? this.createNodeLineVertices(wasm, arena, node);
                // convert clusters into a map by objectId by merging the vertices of actively rendered child indices
                for (const [childIndex, vertices] of nodeLineVertices) {
                    if ((1 << childIndex) & mask) {
                        yield vertices;
                    }
                }
            }
        }
    }

    // create intersection line clusters for node
    createNodeLineVertices(wasm: WasmInstance | undefined, arena: Arena | undefined, node: OctreeNode) {
        const childBuilders = new Map<ChildIndex, NodeIntersectionBuilder>();
        const { context, localSpaceTranslation, localPlaneMatrix } = this;
        const { gl } = context.renderContext;
        const { denormMatrix } = OutlineRenderer;
        const modelLocalMatrix = node.getModelLocalMatrix(localSpaceTranslation);
        let modelPlaneMatrix = mat4.create();
        // modelPlaneMatrix = localPlaneMatrix * modelLocalMatrix * denormMatrix
        mat4.mul(modelPlaneMatrix, mat4.mul(modelPlaneMatrix, localPlaneMatrix, modelLocalMatrix), denormMatrix);
        let wasmModePlaneMatrix;
        if(wasm !== undefined && arena !== undefined) {
            if (modelPlaneMatrix instanceof Array) {
                wasmModePlaneMatrix = wasm.allocate_mat4(new Float32Array(modelPlaneMatrix));
            }else{
                wasmModePlaneMatrix = wasm.allocate_mat4(modelPlaneMatrix);
            }
        }
        for (const mesh of node.meshes) {
            if (mesh.numTriangles && mesh.drawParams.mode == "TRIANGLES" && !mesh.baseColorTexture && mesh.idxBuf) {
                const { drawRanges, objectRanges } = mesh;
                const { idxBuf, posBuf } = getMeshBuffers(arena, gl, mesh);
                // intersect triangles for all draw ranges
                for (const drawRange of drawRanges) {
                    const { childIndex } = drawRange;

                    let childBuilder = childBuilders.get(childIndex);
                    if (!childBuilder) {
                        let buffer;
                        if (arena !== undefined) {
                            buffer = arena.allocate_f32(NodeIntersectionBuilder.maxBufferSize);
                            childBuilder = new NodeIntersectionBuilder(buffer, false);
                        }else{
                            buffer = new Float32Array(NodeIntersectionBuilder.maxBufferSize);
                            childBuilder = new NodeIntersectionBuilder(buffer, true);
                        }
                        childBuilders.set(childIndex, childBuilder);
                    }
                    const { buffer } = childBuilder;

                    const beginTriangle = drawRange.first / 3;
                    const endTriangle = beginTriangle + drawRange.count / 3;
                    const idxViews = [];
                    // extract one object range at a time.
                    for (const objectRange of objectRanges) {
                        if (objectRange.beginTriangle < beginTriangle || objectRange.endTriangle > endTriangle)
                            continue;
                        const begin = objectRange.beginTriangle * 3;
                        const end = objectRange.endTriangle * 3;
                        const idxView = idxBuf.subarray(begin, end);
                        idxViews.push(idxView);
                    }

                    let lines = 0;
                    if(wasm !== undefined && wasmModePlaneMatrix) {
                        const output = buffer.subarray(childBuilder.offset);
                        if(idxBuf instanceof Uint16Array) {
                            lines = wasm.intersect_triangles_u16(idxViews, posBuf, wasmModePlaneMatrix, output);
                        }else{
                            lines = wasm.intersect_triangles_u32(idxViews, posBuf, wasmModePlaneMatrix, output);
                        }
                    }else{
                        lines = intersectTriangles(buffer, childBuilder.offset, idxViews, posBuf, modelPlaneMatrix);
                    }

                    childBuilder.offset += lines * 4;
                }
            }
        }
        // const linesVAO = new Map<ChildIndex, NodeIntersection>();
        // this.makeVAO([{ objectId: 0xffff_ffff, vertices: lineVertBuf.subarray(0, lineVertBufOffset) }])
        // const nodeIntersection = new NodeIntersection(linesVAO);
        // this.nodeIntersectionCache.set(node, nodeIntersection);
        const lineClusters = new Map<ChildIndex, LineVertices>(
            [...childBuilders.entries()].map(([childIndex, builder]) => ([childIndex, builder.vertices()] as const))
        );
        this.nodeLinesCache.set(node, lineClusters);

        arena?.reset();
        return lineClusters;
    }

    makeLinesVAO(lineVertices: readonly LineVertices[]) {
        let count = 0;
        let vao: WebGLVertexArrayObject | null = null;
        if (lineVertices.length > 0) {
            const { context } = this;
            const { gl } = context.renderContext;
            let totalLines = 0;
            for (const vertices of lineVertices) {
                totalLines += vertices.length / 4;
            }
            const pos = new Float32Array(totalLines * 4);
            const color = new Uint32Array(totalLines);
            const objectId = new Uint32Array(totalLines);
            let lineOffset = 0;
            for (const vertices of lineVertices) {
                const numLines = vertices.length / 4;
                pos.set(vertices, lineOffset * 4);
                color.fill(0xff00_00ff, lineOffset, lineOffset + numLines);
                objectId.fill(0xffff_ffff, lineOffset, lineOffset + numLines);
                lineOffset += numLines;
            }
            console.assert(totalLines == lineOffset);
            count = totalLines;
            const posBuffer = glCreateBuffer(gl, { kind: "ARRAY_BUFFER", srcData: pos, usage: "STREAM_DRAW" });
            const colorBuffer = glCreateBuffer(gl, { kind: "ARRAY_BUFFER", srcData: color, usage: "STREAM_DRAW" });
            const objectIdBuffer = glCreateBuffer(gl, { kind: "ARRAY_BUFFER", srcData: objectId, usage: "STREAM_DRAW" });
            vao = glCreateVertexArray(gl, {
                attributes: [
                    { kind: "FLOAT", componentCount: 4, componentType: "FLOAT", normalized: false, buffer: posBuffer, byteOffset: 0, byteStride: 16, divisor: 1 },
                    { kind: "FLOAT", componentCount: 4, componentType: "UNSIGNED_BYTE", normalized: true, buffer: colorBuffer, byteOffset: 0, byteStride: 4, divisor: 1 },
                    { kind: "UNSIGNED_INT", componentCount: 1, componentType: "UNSIGNED_INT", buffer: objectIdBuffer, byteOffset: 0, byteStride: 4, divisor: 1 },
                ],
            });
            glDelete(gl, [posBuffer, colorBuffer, objectIdBuffer]); // the vertex array already references these buffers, so we release our reference on them early.
        }
        return {
            count,
            vao,
        } as const;
    }

    render(renderNodes: readonly RenderNode[]) {

    }

    renderLines(count: number, vao: WebGLVertexArrayObject | null) {
        if (!vao)
            return;
        const { context } = this;
        const { renderContext } = context;
        const { programs } = context.resources;
        const { gl, cameraUniforms, clippingUniforms, outlineUniforms } = renderContext;
        glState(gl, {
            // drawbuffers: both?
            uniformBuffers: [cameraUniforms, clippingUniforms, outlineUniforms, null],
            program: programs.line,
            vertexArrayObject: vao,
            depth: {
                test: false,
                writeMask: false
            },
        });
        const stats = glDraw(gl, { kind: "arrays_instanced", mode: "LINES", count: 2, instanceCount: count });
        renderContext.addRenderStatistics(stats);
    }

    renderPoints(count: number, vao: WebGLVertexArrayObject | null) {
        if (!vao)
            return;
        const { context } = this;
        const { renderContext } = context;
        const { programs } = context.resources;
        const { gl, cameraUniforms, clippingUniforms, outlineUniforms } = renderContext;
        glState(gl, {
            // drawbuffers: both?
            uniformBuffers: [cameraUniforms, clippingUniforms, outlineUniforms, null],
            program: programs.point,
            vertexArrayObject: vao,
            depth: {
                test: false,
                writeMask: false
            },
        });
        const stats = glDraw(gl, { kind: "arrays_instanced", mode: "POINTS", count: 1, instanceCount: count });
        renderContext.addRenderStatistics(stats);
    }

}

function getMeshBuffers(arena: Arena | undefined, gl: WebGL2RenderingContext, mesh: Mesh) {
    gl.bindVertexArray(null);
    const numIndices = mesh.numTriangles * 3;
    const { numVertices } = mesh;
    // get index buffer
    let idxBuf;
    if(arena !== undefined) {
        if(numVertices > 0xffff) {
            idxBuf = arena.allocate_u32(numIndices);
        }else{
            idxBuf = arena.allocate_u16(numIndices);
        }
    }else{
        const IdxType = numVertices > 0xffff ? Uint32Array : Uint16Array;
        idxBuf = new IdxType(numIndices);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.idxBuf);
    gl.getBufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, idxBuf, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    let posBuf;
    if(arena !== undefined) {
        posBuf = arena.allocate_i16(numVertices * 3);
    }else{
        posBuf = new Int16Array(numVertices * 3);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.posVB);
    gl.getBufferSubData(gl.ARRAY_BUFFER, 0, posBuf, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return { idxBuf, posBuf } as const;
}

function normInt16ToFloatMatrix() {
    // Positions in model (node) space are given in 16 bit signed normalized ints.
    // Prior to opengl 4.2, this means mapping [-0x8000, 0x7fff] to [-1, 1] respectively: https://www.khronos.org/opengl/wiki/Normalized_Integer
    // This roughly equates to f = (v + 0.5) / 32767.5
    const s = 1 / 32767.5;
    const o = 0.5 * s;
    return mat4.fromValues(
        s, 0, 0, 0,
        0, s, 0, 0,
        0, 0, s, 0,
        o, o, o, 1,
    );
}

function flattenF32Arrays(items: readonly Float32Array[]): Float32Array {
    const size = items.map(item => item.length).reduce((a, b) => (a + b));
    const output = new Float32Array(size);
    let offset = 0;
    for (const item of items) {
        output.set(item, offset);
        offset += item.length;
    }
    return output;
}

function planeMatrices(plane: ReadonlyVec4, localSpaceTranslation: ReadonlyVec3) {
    const [x, y, z, o] = plane;
    const normal = vec3.fromValues(x, y, z);
    const distance = -o - vec3.dot(localSpaceTranslation, normal);
    const planeLS = vec4.fromValues(normal[0], normal[1], normal[2], -distance);
    const planeLocalMatrix = orthoNormalBasisMatrixFromPlane(planeLS);
    const localPlaneMatrix = mat4.invert(mat4.create(), planeLocalMatrix);
    return { planeLocalMatrix, localPlaneMatrix } as const;
}

/**
 * Intersect triangles against specificed plane
 * @param output Output line vertex (xy coord) buffer.
 * @param offset Start index to write in vertex output buffer.
 * @param idx Vertex index triplets (triangles)
 * @param pos Vertex positions in model (node) space, as snorm16
 * @param modelToPlaneMatrix Matrix to transform from snorm16 model space into plane space
 */
function intersectTriangles(output: Float32Array, offset: number, idxViews: Array<Uint16Array | Uint32Array>, pos: Int16Array, modelToPlaneMatrix: ReadonlyMat4) {
    const p0 = vec3.create(); const p1 = vec3.create(); const p2 = vec3.create();
    let n = 0;
    function emit(x: number, y: number) {
        output[offset++] = x;
        output[offset++] = y;
        n++;
    }

    for (const idx of idxViews) {
        // for each triangle...
        console.assert(idx.length % 3 == 0); // assert that we are dealing with triangles.
        for (let i = 0; i < idx.length; i += 3) {
            const i0 = idx[i + 0]; const i1 = idx[i + 1]; const i2 = idx[i + 2];
            vec3.set(p0, pos[i0 * 3 + 0], pos[i0 * 3 + 1], pos[i0 * 3 + 2]);
            vec3.set(p1, pos[i1 * 3 + 0], pos[i1 * 3 + 1], pos[i1 * 3 + 2]);
            vec3.set(p2, pos[i2 * 3 + 0], pos[i2 * 3 + 1], pos[i2 * 3 + 2]);
            // transform positions into clipping plane space, i.e. xy on plane, z above or below
            vec3.transformMat4(p0, p0, modelToPlaneMatrix);
            vec3.transformMat4(p1, p1, modelToPlaneMatrix);
            vec3.transformMat4(p2, p2, modelToPlaneMatrix);
            // check if z-coords are greater and less than 0
            const z0 = p0[2]; const z1 = p1[2]; const z2 = p2[2];
            const gt0 = z0 > 0; const gt1 = z1 > 0; const gt2 = z2 > 0;
            const lt0 = z0 < 0; const lt1 = z1 < 0; const lt2 = z2 < 0;
            // does triangle intersect plane?
            // this test is not just a possible optimization, but also excludes problematic triangles that straddles the plane along an edge
            if ((gt0 || gt1 || gt2) && (lt0 || lt1 || lt2)) { // SIMD: any()?
                // check for edge intersections
                intersectEdge(emit, p0, p1);
                intersectEdge(emit, p1, p2);
                intersectEdge(emit, p2, p0);
                console.assert(n % 2 == 0); // check that there are always pairs of vertices
            }
        }
    }
    return n / 2;
}

function intersectEdge(emit: (x: number, y: number) => void, v0: ReadonlyVec3, v1: ReadonlyVec3) {
    const [x0, y0, z0] = v0;
    const [x1, y1, z1] = v1;
    if ((z0 <= 0 && z1 > 0) || (z1 <= 0 && z0 > 0)) {
        const t = -z0 / (z1 - z0);
        emit(
            lerp(x0, x1, t),
            lerp(y0, y1, t),
        );
    }
}

function lerp(a: number, b: number, t: number) {
    return a + (b - a) * t;
}

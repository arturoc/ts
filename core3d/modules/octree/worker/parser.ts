import { type ReadonlyVec3, vec3 } from "gl-matrix";
import type { AABB, BoundingSphere } from "core3d/state";
import { BufferReader, Float16Array } from "./util";
import type { ComponentType, ShaderAttributeType, TextureParams } from "webgl2";
import { parseKTX } from "core3d/ktx";
import type { Mutex } from "../mutex";
import * as Current from "./2_1";
import * as Previous from "./2_0";
const { MaterialType, OptionalVertexAttribute, PrimitiveType, TextureSemantic } = Current;
type Current = typeof Current;
type Previous = typeof Previous;
// extract common types and ensure that current and previous binary format versions of them are 100% overlapping
type Float3 = Current.Float3 | Previous.Float3;
type Double3 = Current.Double3 | Previous.Double3;
type Schema = Current.Schema | Previous.Schema;
type SubMeshProjection = Current.SubMeshProjection | Previous.SubMeshProjection;
type MaterialType = Current.MaterialType | Previous.MaterialType;
type TextureSemantic = Current.TextureSemantic | Previous.TextureSemantic;
type PrimitiveType = Current.PrimitiveType | Previous.PrimitiveType;
type OptionalVertexAttribute = Current.OptionalVertexAttribute | Previous.OptionalVertexAttribute;

function isCurrentSchema(schema: Schema): schema is Current.Schema {
    return schema.version == Current.version;
}

export function isSupportedVersion(version: string) {
    return version == Current.version || version == Previous.version;
}

/** @internal */
export interface MeshDrawRange {
    readonly childIndex: number;
    readonly byteOffset: number; // in bytes
    readonly first: number; // # indices
    readonly count: number; // # indices
}

/** @internal */
export interface MeshObjectRange {
    readonly objectId: number;
    readonly beginVertex: number;
    readonly endVertex: number;
    readonly beginTriangle: number;
    readonly endTriangle: number;
}

/** @internal */
export interface Highlights {
    readonly indices: Uint8Array;
    readonly mutex: Mutex;
}

const primitiveTypeStrings = ["POINTS", "LINES", "LINE_LOOP", "LINE_STRIP", "TRIANGLES", "TRIANGLE_STRIP", "TRIANGLE_FAN"] as const;
/** @internal */
export type PrimitiveTypeString = typeof primitiveTypeStrings[number];

/** @internal */
export interface NodeBounds {
    readonly box: AABB;
    readonly sphere: BoundingSphere;
};

// node data contains everything needed to create a new node, except its geometry and textures
// this data comes from the parent node and is used to determine visibility and whether to load node geometry or not
/** @internal */
export interface NodeData {
    readonly id: string;
    readonly childIndex: number; // octant # (not mask, but index)
    readonly childMask: number; // 32-bit mask for what child indices (octants) have geometry
    readonly descendantObjectIds?: readonly number[]; // optional array of all object ids found in descendant nodes for filter optimization
    readonly tolerance: number;
    readonly byteSize: number; // uncompressed byte size of node file
    readonly offset: ReadonlyVec3;
    readonly scale: number;
    readonly bounds: NodeBounds;
    // readonly primitiveType: PrimitiveTypeString;
    // Used to predict the cost of creating geometry, potentially with filtering. Note that this does not consider the cost of loading, which ideally is a streaming process with low memory footprint
    readonly primitives: number;
    readonly primitivesDelta: number; // # new primitives introduced compared to parent
    readonly gpuBytes: number;
}

/** @internal */
export interface VertexAttributeData {
    readonly kind: ShaderAttributeType;
    readonly componentType: ComponentType;
    readonly buffer: number; // index into buffer array
    readonly componentCount: 1 | 2 | 3 | 4;
    readonly normalized: boolean;
    readonly byteStride: number;
    readonly byteOffset?: number;
};

/** @internal */
export interface VertexAttributes {
    readonly position: VertexAttributeData;
    readonly normal: VertexAttributeData | null;
    readonly material: VertexAttributeData | null;
    readonly objectId: VertexAttributeData | null;
    readonly texCoord: VertexAttributeData | null;
    readonly color: VertexAttributeData | null;
    readonly projectedPos: VertexAttributeData | null;
    readonly deviations: VertexAttributeData | null;
    readonly triangles0: VertexAttributeData | null;
    readonly triangles1: VertexAttributeData | null;
    readonly triangles2: VertexAttributeData | null;
    readonly trianglesObjId: VertexAttributeData | null;
    readonly highlight: VertexAttributeData | null;
    readonly highlightTri: VertexAttributeData | null;
}

/** @internal */
export const enum VertexAttribIndex {
    triangles, position, normal, material, objectId, texCoord, color, projectedPos, deviations, highlight, highlightTri
};

/** @internal */
export interface NodeSubMesh {
    readonly materialType: MaterialType;
    readonly primitiveType: PrimitiveTypeString;
    readonly vertexAttributes: VertexAttributes;
    readonly numVertices: number;
    readonly numTriangles: number;
    readonly objectRanges: readonly MeshObjectRange[];
    // either index range (if index buffer is defined) for use with drawElements(), or vertex range for use with drawArray()
    readonly drawRanges: readonly MeshDrawRange[];
    readonly vertexBuffers: readonly ArrayBuffer[];
    readonly indices: Uint16Array | Uint32Array | number; // Index buffer, or # vertices of none
    readonly baseColorTexture: number | undefined; // texture index
}

/** @internal */
export interface NodeTexture {
    readonly semantic: TextureSemantic;
    readonly transform: readonly number[]; // 3x3 matrix
    readonly params: TextureParams;
}

// node geometry and textures
/** @internal */
export interface NodeGeometry {
    readonly subMeshes: readonly NodeSubMesh[];
    readonly textures: readonly (NodeTexture | undefined)[];
}

function getVec3(v: Float3 | Double3, i: number) {
    return vec3.fromValues(v.x[i], v.y[i], v.z[i]);
}

type Range = readonly [begin: number, end: number];
type DeviationsCount = 0 | 1 | 2 | 3 | 4;

function getRange(v: { readonly start: ArrayLike<number>, count: ArrayLike<number>; }, i: number): Range {
    const begin = v.start[i];
    const end = begin + v.count[i];
    return [begin, end] as const;
}

function computePrimitiveCount(primitiveType: PrimitiveType, numIndices: number) {
    switch (primitiveType) {
        case PrimitiveType.points:
            return numIndices;
        case PrimitiveType.lines:
            return numIndices / 2;
        case PrimitiveType.line_loops:
            return numIndices;
        case PrimitiveType.line_strip:
            return numIndices - 1;
        case PrimitiveType.triangles:
            return numIndices / 3;
        case PrimitiveType.triangle_strip:
            return numIndices - 2;
        case PrimitiveType.triangle_fan:
            return numIndices - 2;
        default:
            console.warn(`Unknown primitive type: ${primitiveType}!`);
    }
}

function getVertexAttribs(deviations: number) {
    return {
        position: { type: Uint16Array, components: ["x", "y", "z"] },
        normal: { type: Int8Array, components: ["x", "y", "z"] },
        texCoord: { type: Float16Array, components: ["x", "y"] },
        color: { type: Uint8Array, components: ["red", "green", "blue", "alpha"] },
        projectedPos: { type: Uint16Array, components: ["x", "y", "z"] },
        deviations: { type: Float16Array, components: ["a", "b", "c", "d"].slice(0, deviations) },
        materialIndex: { type: Uint8Array },
        objectId: { type: Uint32Array },
    } as const;
}
type VertexAttribs = ReturnType<typeof getVertexAttribs>;
type VertexAttribNames = keyof VertexAttribs;
type VertexAttrib = { readonly type: VertexAttribs[VertexAttribNames]["type"], readonly components?: readonly string[]; };

function computeVertexOffsets(attribs: readonly VertexAttribNames[], deviations = 0) {
    let offset = 0;
    let offsets: any = {};
    function alignOffset(alignment: number) {
        const padding = alignment - 1 - (offset + alignment - 1) % alignment;
        offset += padding; // pad offset to be memory aligned.
    }
    let maxAlign = 1;
    const vertexAttribs = getVertexAttribs(deviations);
    for (const attrib of attribs) {
        const { type, components } = vertexAttribs[attrib] as VertexAttrib;
        const count = components?.length ?? 1;
        maxAlign = Math.max(maxAlign, type.BYTES_PER_ELEMENT);
        alignOffset(type.BYTES_PER_ELEMENT);
        offsets[attrib] = offset;
        offset += type.BYTES_PER_ELEMENT * count;
    }
    alignOffset(maxAlign); // align stride to largest typed array
    offsets.stride = offset;
    return offsets as { readonly [P in VertexAttribNames]?: number; } & { readonly stride: number; };
}

function getVertexAttribNames(optionalAttributes: OptionalVertexAttribute, deviations: DeviationsCount, hasMaterials: boolean, hasObjectIds: boolean) {
    const attribNames: VertexAttribNames[] = ["position"];
    if (optionalAttributes & OptionalVertexAttribute.normal) attribNames.push("normal");
    if (optionalAttributes & OptionalVertexAttribute.texCoord) attribNames.push("texCoord");
    if (optionalAttributes & OptionalVertexAttribute.color) attribNames.push("color");
    if (optionalAttributes & OptionalVertexAttribute.projectedPos) attribNames.push("projectedPos");
    if (deviations > 0) attribNames.push("deviations");
    if (hasMaterials) {
        attribNames.push("materialIndex");
    }
    if (hasObjectIds) {
        attribNames.push("objectId");
    }
    return attribNames;
}

/** @internal */
export function aggregateSubMeshProjections(subMeshProjection: SubMeshProjection, range: Range, separatePositionBuffer: boolean, predicate?: (objectId: number) => boolean) {
    let primitives = 0;
    let totalTextureBytes = 0;
    let totalNumIndices = 0;
    let totalNumVertices = 0;
    let totalNumVertexBytes = 0;

    const [begin, end] = range;
    for (let i = begin; i < end; i++) {
        const objectId = subMeshProjection.objectId[i];
        if (predicate?.(objectId) ?? true) {
            const indices = subMeshProjection.numIndices[i];
            const vertices = subMeshProjection.numVertices[i];
            const textureBytes = subMeshProjection.numTextureBytes[i]; // TODO: adjust by device profile/resolution
            const attributes = subMeshProjection.attributes[i];
            const deviations = subMeshProjection.numDeviations[i] as DeviationsCount;
            const primitiveType = subMeshProjection.primitiveType[i];
            // we assume that textured nodes are terrain with no material index (but object_id?).
            // TODO: state these values explicitly in binary format instead
            const hasMaterials = textureBytes == 0;
            const hasObjectIds = true;
            const [pos, ...rest] = getVertexAttribNames(attributes, deviations, hasMaterials, hasObjectIds);
            const numBytesPerVertex = separatePositionBuffer ?
                computeVertexOffsets([pos]).stride + computeVertexOffsets(rest, deviations).stride :
                computeVertexOffsets([pos, ...rest], deviations).stride;
            primitives += computePrimitiveCount(primitiveType, indices ? indices : vertices) ?? 0;
            totalNumIndices += indices;
            totalNumVertices += vertices;
            totalNumVertexBytes += vertices * numBytesPerVertex;
            totalTextureBytes += textureBytes;
        } else {
            // debugger;
        }
    }
    const idxStride = totalNumVertices < 0xffff ? 2 : 4;
    const gpuBytes = totalTextureBytes + totalNumVertexBytes + totalNumIndices * idxStride;
    return { primitives, gpuBytes } as const;
}

function toHex(bytes: Uint8Array) {
    return Array.prototype.map.call(bytes, x => ('00' + x.toString(16).toUpperCase()).slice(-2)).join('');
}

/** @internal */
export function getChildren(parentId: string, schema: Schema, separatePositionBuffer: boolean, predicate?: (objectId: number) => boolean): NodeData[] {
    const { childInfo, hashBytes } = schema;
    const children: NodeData[] = [];


    // compute parent/current mesh primitive counts per child partition
    const parentPrimitiveCounts: number[] = [];

    for (let i = 0; i < childInfo.length; i++) {
        const childIndex = childInfo.childIndex[i];
        const childMask = childInfo.childMask[i];
        const [hashBegin, hashEnd] = getRange(childInfo.hash, i);
        const hash = hashBytes.slice(hashBegin, hashEnd);
        const id = toHex(hash); // parentId + childIndex.toString(32); // use radix 32 (0-9, a-v) encoding, which allows for max 32 children per node
        const tolerance = childInfo.tolerance[i];
        const byteSize = childInfo.totalByteSize[i];
        const offset = getVec3(childInfo.offset, i);
        const scale = childInfo.scale[i];
        const bounds: NodeBounds = {
            box: {
                min: getVec3(childInfo.bounds.box.min, i),
                max: getVec3(childInfo.bounds.box.max, i),
            },
            sphere: {
                center: getVec3(childInfo.bounds.sphere.origo, i),
                radius: childInfo.bounds.sphere.radius[i],
            }
        };
        // offset bounds
        const { sphere, box } = bounds;
        vec3.add(sphere.center as vec3, sphere.center, offset);
        vec3.add(box.min as vec3, box.min, offset);
        vec3.add(box.max as vec3, box.max, offset);

        const subMeshProjectionRange = getRange(childInfo.subMeshes, i);
        const parentPrimitives = parentPrimitiveCounts[childIndex];
        const { primitives, gpuBytes } = aggregateSubMeshProjections(schema.subMeshProjection, subMeshProjectionRange, separatePositionBuffer, predicate);
        const primitivesDelta = primitives - (parentPrimitives ?? 0);
        let descendantObjectIds: number[] | undefined;
        if (isCurrentSchema(schema)) {
            const [idsBegin, idsEnd] = getRange(schema.childInfo.descendantObjectIds, i);
            if (idsBegin != idsEnd) {
                descendantObjectIds = [...schema.descendantObjectIds.slice(idsBegin, idsEnd)];
            }
        }
        // console.assert(parentId == "0" || primitivesDelta >= 0, "negative primitive delta");
        children.push({ id, childIndex, childMask, tolerance, byteSize, offset, scale, bounds, primitives, primitivesDelta, gpuBytes, descendantObjectIds });
    }
    return children;
}

/** @internal */
export function* getSubMeshes(schema: Schema, predicate?: (objectId: number) => boolean) {
    const { subMesh } = schema;
    for (let i = 0; i < subMesh.length; i++) {
        const objectId = subMesh.objectId[i];
        const primitive = subMesh.primitiveType[i];
        if (predicate?.(objectId) ?? true) {
            const childIndex = subMesh.childIndex[i];
            const objectId = subMesh.objectId[i];
            const materialIndex = subMesh.materialIndex[i];
            const materialType = materialIndex ==
                0xff && subMesh.textures.count[i] == 0 && (primitive == PrimitiveType.triangle_strip || primitive == PrimitiveType.triangles) ?
                MaterialType.elevation :
                subMesh.materialType[i];
            const primitiveType = subMesh.primitiveType[i];
            const attributes = subMesh.attributes[i];
            const deviations = subMesh.numDeviations[i] as DeviationsCount;
            const vertexRange = getRange(subMesh.vertices, i);
            const indexRange = getRange(subMesh.primitiveVertexIndices, i);
            const textureRange = getRange(subMesh.textures, i);
            yield { childIndex, objectId, materialIndex, materialType, primitiveType, attributes, deviations, vertexRange, indexRange, textureRange };
        }
    }
}
type TypedArray = Uint8Array | Uint16Array | Uint32Array | Int8Array | Int16Array | Int32Array | Float32Array | Float64Array;

// Candidates for wasm implementation?
function copyToInterleavedArray<T extends TypedArray>(dst: T, src: T, byteOffset: number, byteStride: number, begin: number, end: number) {
    const offset = byteOffset / dst.BYTES_PER_ELEMENT;
    const stride = byteStride / dst.BYTES_PER_ELEMENT;
    console.assert(Math.round(offset) == offset);
    console.assert(Math.round(stride) == stride);
    let j = offset;
    for (let i = begin; i < end; i++) {
        dst[j] = src[i];
        j += stride;
    }
}

function fillToInterleavedArray<T extends TypedArray>(dst: T, src: number, byteOffset: number, byteStride: number, begin: number, end: number) {
    const offset = byteOffset / dst.BYTES_PER_ELEMENT;
    const stride = byteStride / dst.BYTES_PER_ELEMENT;
    console.assert(Math.round(offset) == offset);
    console.assert(Math.round(stride) == stride);
    let j = offset;
    for (let i = begin; i < end; i++) {
        dst[j] = src;
        j += stride;
    }
}

function getGeometry(schema: Schema, separatePositionBuffer: boolean, enableOutlines: boolean, highlights: Highlights, predicate?: (objectId: number) => boolean): NodeGeometry {
    const { vertex, vertexIndex } = schema;

    const filteredSubMeshes = [...getSubMeshes(schema, predicate)];

    let subMeshes: NodeSubMesh[] = [];
    const referencedTextures = new Set<number>();

    // group submeshes into drawable meshes (with common attributes)
    type Group = {
        readonly materialType: number;
        readonly primitiveType: number;
        readonly attributes: number;
        readonly deviations: DeviationsCount;
        readonly subMeshIndices: number[];
    };
    const groups = new Map<string, Group>();
    for (let i = 0; i < filteredSubMeshes.length; i++) {
        const { materialType, primitiveType, attributes, deviations, childIndex } = filteredSubMeshes[i];
        const key = `${materialType}_${primitiveType}_${attributes}_${deviations}_${childIndex}`;
        let group = groups.get(key);
        if (!group) {
            group = { materialType, primitiveType, attributes, deviations, subMeshIndices: [] };
            groups.set(key, group);
        }
        group.subMeshIndices.push(i);
    }

    // we don't want highlights to change during parsing, so we hold the lock for the entire file
    highlights.mutex.lockSync();

    // create drawable meshes
    for (const { materialType, primitiveType, attributes, deviations, subMeshIndices } of groups.values()) {
        if (subMeshIndices.length == 0)
            continue;
        const groupMeshes = subMeshIndices.map(i => filteredSubMeshes[i]);
        const hasMaterials = groupMeshes.some(m => m.materialIndex != 0xff);
        const hasObjectIds = groupMeshes.some(m => m.objectId != 0xffffffff);

        const allAttribNames = getVertexAttribNames(attributes, deviations, hasMaterials, hasObjectIds);
        const [posName, ...extraAttribNames] = allAttribNames; // pop off positions since we're potentially putting them in a separate buffer
        const attribNames = separatePositionBuffer ? extraAttribNames : allAttribNames;
        const positionStride = computeVertexOffsets([posName], deviations).stride;
        const trianglePosStride = positionStride * 3;
        const attribOffsets = computeVertexOffsets(attribNames, deviations);
        const vertexStride = attribOffsets.stride;

        const childIndices = [...new Set<number>(groupMeshes.map(sm => sm.childIndex))].sort();
        let numVertices = 0;
        let numIndices = 0;
        let numTriangles = 0;
        for (let i = 0; i < groupMeshes.length; i++) {
            const sm = groupMeshes[i];
            const vtxCnt = sm.vertexRange[1] - sm.vertexRange[0];
            const idxCnt = sm.indexRange[1] - sm.indexRange[0];
            numVertices += vtxCnt;
            numIndices += idxCnt;
            if (primitiveType == PrimitiveType.triangles) {
                numTriangles += Math.round((idxCnt > 0 ? idxCnt : vtxCnt) / 3);
            }
        }
        const vertexBuffer = new ArrayBuffer(numVertices * vertexStride);
        let trianglePosBuffer: Int16Array | undefined;
        let triangleObjectIdBuffer: Uint32Array | undefined;
        let highlightBufferTri: Uint8Array | undefined;
        if (enableOutlines && primitiveType == PrimitiveType.triangles) { // TODO: support triangle strips and fans too
            trianglePosBuffer = new Int16Array(new ArrayBuffer(numTriangles * trianglePosStride));
            triangleObjectIdBuffer = new Uint32Array(numTriangles);
            highlightBufferTri = new Uint8Array(numTriangles);
        }
        const positionBuffer = separatePositionBuffer ? new ArrayBuffer(numVertices * positionStride) : undefined;
        let indexBuffer: Uint32Array | Uint16Array | undefined;
        if (vertexIndex) {
            indexBuffer = new (numVertices < 0xffff ? Uint16Array : Uint32Array)(numIndices);
        }
        const highlightBuffer = new Uint8Array(numVertices);
        let indexOffset = 0;
        let vertexOffset = 0;
        let triangleOffset = 0;
        let drawRanges: MeshDrawRange[] = [];
        type Mutable<T> = { -readonly [P in keyof T]: T[P] };
        const objectRanges: Mutable<MeshObjectRange>[] = [];

        function enumerateBuffers<K extends string>(possibleBuffers: { readonly [P in K]: ArrayBuffer | undefined }) {
            const buffers: ArrayBuffer[] = [];
            const indices = {} as { readonly [P in K]: number };
            for (const [key, value] of Object.entries(possibleBuffers)) {
                const buffer = value as ArrayBuffer | undefined;
                let index = -1;
                if (buffer) {
                    index = buffers.indexOf(buffer);
                    if (index < 0) {
                        index = buffers.length;
                        buffers.push(buffer);
                    }
                }
                Reflect.set(indices, key, index);
            }
            return [buffers, indices] as const;
        }

        const [vertexBuffers, bufIdx] = enumerateBuffers({
            primary: vertexBuffer,
            highlight: highlightBuffer?.buffer,
            pos: positionBuffer,
            triPos: trianglePosBuffer?.buffer,
            triId: triangleObjectIdBuffer?.buffer,
            highlightTri: highlightBufferTri?.buffer,
        });

        for (const childIndex of childIndices) {
            const meshes = groupMeshes.filter(sm => sm.childIndex == childIndex);
            if (meshes.length == 0)
                continue;

            const drawRangeBegin = indexBuffer ? indexOffset : vertexOffset;

            for (const subMesh of meshes) {
                const { vertexRange, indexRange, materialIndex, deviations, objectId } = subMesh;
                const context = { materialIndex, objectId };
                const [beginVtx, endVtx] = vertexRange;
                const [beginIdx, endIdx] = indexRange;

                // initialize vertex buffer
                const vertexAttribs = getVertexAttribs(deviations);
                for (const attribName of attribNames) {
                    const { type, components } = vertexAttribs[attribName] as VertexAttrib;
                    const dst = new type(vertexBuffer, vertexOffset * vertexStride);
                    const count = components?.length ?? 1;
                    for (var c = 0; c < count; c++) {
                        const offs = attribOffsets[attribName]! + c * type.BYTES_PER_ELEMENT;
                        if (attribName in vertex) {
                            let src = Reflect.get(vertex, attribName) as typeof dst;
                            if (components) {
                                src = Reflect.get(src, components[c]);
                            }
                            copyToInterleavedArray(dst, src, offs, vertexStride, beginVtx, endVtx);
                        } else {
                            const src = Reflect.get(context, attribName) as number;
                            fillToInterleavedArray(dst, src, offs, vertexStride, beginVtx, endVtx);
                        }
                    }
                }

                // initialize triangle vertex buffer for clipping intersection
                let numTrianglesInSubMesh = 0;
                if (trianglePosBuffer && triangleObjectIdBuffer) {
                    const { x, y, z } = vertex.position;
                    let j = triangleOffset * 3 * 3;
                    if (vertexIndex && indexBuffer) {
                        numTrianglesInSubMesh = (endIdx - beginIdx) / 3;
                        for (let i = beginIdx; i < endIdx; i++) {
                            // TODO: Add support for triangle strips and fans as well...
                            const idx = vertexIndex[i] + beginVtx;
                            trianglePosBuffer[j++] = x[idx];
                            trianglePosBuffer[j++] = y[idx];
                            trianglePosBuffer[j++] = z[idx];
                        }
                    } else {
                        numTrianglesInSubMesh = (endVtx - beginVtx) / 3;
                        for (let i = beginVtx; i < endVtx; i++) {
                            const idx = i;
                            trianglePosBuffer[j++] = x[idx];
                            trianglePosBuffer[j++] = y[idx];
                            trianglePosBuffer[j++] = z[idx];
                        }
                    }
                    triangleObjectIdBuffer.fill(objectId, triangleOffset, triangleOffset + numTrianglesInSubMesh);
                }

                if (positionBuffer) {
                    // initialize separate positions buffer
                    const i16 = new Int16Array(positionBuffer, vertexOffset * positionStride);
                    copyToInterleavedArray(i16, vertex.position.x, 0, positionStride, beginVtx, endVtx);
                    copyToInterleavedArray(i16, vertex.position.y, 2, positionStride, beginVtx, endVtx);
                    copyToInterleavedArray(i16, vertex.position.z, 4, positionStride, beginVtx, endVtx);
                }

                // initialize index buffer (if any)
                if (vertexIndex && indexBuffer) {
                    for (let i = beginIdx; i < endIdx; i++) {
                        indexBuffer[indexOffset++] = vertexIndex[i] + vertexOffset;
                    }
                }

                const endVertex = vertexOffset + (endVtx - beginVtx);
                const endTriangle = triangleOffset + (endIdx - beginIdx) / 3;
                // initialize highlight buffer
                const highlightIndex = highlights.indices[objectId] ?? 0;
                if (highlightIndex) {
                    highlightBuffer.fill(highlightIndex, vertexOffset, endVertex);
                    highlightBufferTri?.fill(highlightIndex, triangleOffset, endTriangle);
                }

                // update object ranges
                const prev = objectRanges.length - 1;
                if (prev >= 0 && objectRanges[prev].objectId == objectId) {
                    // merge with previous entry
                    objectRanges[prev].endVertex = endVertex;
                    objectRanges[prev].endTriangle = endTriangle;
                } else {
                    objectRanges.push({ objectId, beginVertex: vertexOffset, endVertex, beginTriangle: triangleOffset, endTriangle });
                }
                triangleOffset += numTrianglesInSubMesh;
                vertexOffset += endVtx - beginVtx;
            }

            const drawRangeEnd = indexBuffer ? indexOffset : vertexOffset;
            const byteOffset = drawRangeBegin * (indexBuffer ? indexBuffer.BYTES_PER_ELEMENT : vertexStride);
            const count = drawRangeEnd - drawRangeBegin;
            drawRanges.push({ childIndex, byteOffset, first: drawRangeBegin, count });
        }

        console.assert(vertexOffset == numVertices);
        console.assert(indexOffset == numIndices);
        console.assert(triangleOffset == (triangleObjectIdBuffer?.length ?? 0));
        const indices = indexBuffer ?? numVertices;

        const [beginTexture, endTexture] = groupMeshes[0].textureRange;
        let baseColorTexture: number | undefined;
        if (endTexture > beginTexture) {
            baseColorTexture = beginTexture;
        }

        if (baseColorTexture != undefined) {
            referencedTextures.add(baseColorTexture);
        }

        const stride = vertexStride;
        const deviationsKind = deviations == 0 || deviations == 1 ? "FLOAT" as const : `FLOAT_VEC${deviations}` as const;
        const vertexAttributes = {
            position: { kind: "FLOAT_VEC4", buffer: bufIdx.pos, componentCount: 3, componentType: "SHORT", normalized: true, byteOffset: attribOffsets["position"], byteStride: separatePositionBuffer ? 0 : stride },
            normal: (attributes & OptionalVertexAttribute.normal) != 0 ? { kind: "FLOAT_VEC3", buffer: bufIdx.primary, componentCount: 3, componentType: "BYTE", normalized: true, byteOffset: attribOffsets["normal"], byteStride: stride } : null,
            material: hasMaterials ? { kind: "UNSIGNED_INT", buffer: bufIdx.primary, componentCount: 1, componentType: "UNSIGNED_BYTE", normalized: false, byteOffset: attribOffsets["materialIndex"], byteStride: stride } : null,
            objectId: hasObjectIds ? { kind: "UNSIGNED_INT", buffer: bufIdx.primary, componentCount: 1, componentType: "UNSIGNED_INT", normalized: false, byteOffset: attribOffsets["objectId"], byteStride: stride } : null,
            texCoord: (attributes & OptionalVertexAttribute.texCoord) != 0 ? { kind: "FLOAT_VEC2", buffer: bufIdx.primary, componentCount: 2, componentType: "HALF_FLOAT", normalized: false, byteOffset: attribOffsets["texCoord"], byteStride: stride } : null,
            color: (attributes & OptionalVertexAttribute.color) != 0 ? { kind: "FLOAT_VEC4", buffer: bufIdx.primary, componentCount: 4, componentType: "UNSIGNED_BYTE", normalized: true, byteOffset: attribOffsets["color"], byteStride: stride } : null,
            projectedPos: (attributes & OptionalVertexAttribute.projectedPos) != 0 ? { kind: "FLOAT_VEC4", buffer: bufIdx.primary, componentCount: 3, componentType: "SHORT", normalized: true, byteOffset: attribOffsets["projectedPos"], byteStride: stride } : null,
            deviations: deviations != 0 ? { kind: deviationsKind, buffer: bufIdx.primary, componentCount: deviations, componentType: "HALF_FLOAT", normalized: false, byteOffset: attribOffsets["deviations"], byteStride: stride } : null,
            triangles0: trianglePosBuffer ? { kind: "FLOAT_VEC4", buffer: bufIdx.triPos, componentCount: 3, componentType: "SHORT", normalized: true, byteOffset: 0, byteStride: 18 } : null,
            triangles1: trianglePosBuffer ? { kind: "FLOAT_VEC4", buffer: bufIdx.triPos, componentCount: 3, componentType: "SHORT", normalized: true, byteOffset: 6, byteStride: 18 } : null,
            triangles2: trianglePosBuffer ? { kind: "FLOAT_VEC4", buffer: bufIdx.triPos, componentCount: 3, componentType: "SHORT", normalized: true, byteOffset: 12, byteStride: 18 } : null,
            trianglesObjId: trianglePosBuffer ? { kind: "UNSIGNED_INT", buffer: bufIdx.triId, componentCount: 1, componentType: "UNSIGNED_INT", normalized: false, byteOffset: 0, byteStride: 4 } : null,
            highlight: { kind: "UNSIGNED_INT", buffer: bufIdx.highlight, componentCount: 1, componentType: "UNSIGNED_BYTE", normalized: false, byteOffset: 0, byteStride: 0 },
            highlightTri: { kind: "UNSIGNED_INT", buffer: bufIdx.highlightTri, componentCount: 1, componentType: "UNSIGNED_BYTE", normalized: false, byteOffset: 0, byteStride: 0 },
        } as const satisfies VertexAttributes;

        objectRanges.sort((a, b) => (a.objectId - b.objectId));

        subMeshes.push({
            materialType,
            primitiveType: primitiveTypeStrings[primitiveType],
            numVertices,
            numTriangles,
            objectRanges,
            vertexAttributes,
            vertexBuffers,
            indices,
            baseColorTexture,
            drawRanges
        });
    }

    highlights.mutex.unlock();

    const textures = new Array<NodeTexture | undefined>(schema.textureInfo.length);
    const { textureInfo } = schema;
    for (const i of referencedTextures) {
        const [begin, end] = getRange(textureInfo.pixelRange, i);
        const semantic = textureInfo.semantic[i];
        const transform = [
            textureInfo.transform.e00[i],
            textureInfo.transform.e01[i],
            textureInfo.transform.e02[i],
            textureInfo.transform.e10[i],
            textureInfo.transform.e11[i],
            textureInfo.transform.e12[i],
            textureInfo.transform.e20[i],
            textureInfo.transform.e21[i],
            textureInfo.transform.e22[i],
        ] as const;
        const ktx = schema.texturePixels.subarray(begin, end);
        const params = parseKTX(ktx);
        textures[i] = { semantic, transform, params };
    }

    return { subMeshes, textures } as const satisfies NodeGeometry;
}

export function parseNode(id: string, separatePositionBuffer: boolean, enableOutlines: boolean, version: string, buffer: ArrayBuffer, highlights: Highlights, applyFilter: boolean) {
    console.assert(isSupportedVersion(version));
    // const begin = performance.now();
    const r = new BufferReader(buffer);
    var schema = version == Current.version ? Current.readSchema(r) : Previous.readSchema(r);
    let predicate: ((objectId: number) => boolean) | undefined;
    predicate = applyFilter ? (objectId =>
        highlights.indices[objectId] != 0xff
    ) : undefined;
    const childInfos = getChildren(id, schema, separatePositionBuffer, predicate);
    const geometry = getGeometry(schema, separatePositionBuffer, enableOutlines, highlights, predicate);
    // const end = performance.now();
    // console.log((end - begin));
    return { childInfos, geometry } as const;
}

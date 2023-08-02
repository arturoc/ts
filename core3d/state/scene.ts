import type { ReadonlyVec3, ReadonlyMat4 } from "gl-matrix";

/** Static, streamable geometry render state.
 * @remarks
 * Any change to this state will trigger a complete reload of the streamable scene.
 */
export interface RenderStateScene {
    /** Base url whence the scene was downloaded. */
    readonly url: string;
    /** @internal. */
    readonly config: SceneConfig;
    /** Flags for whether to hide/filter various kinds of geometry. */
    readonly hide?: RenderStateStaticGeometryKinds;
}

/** Axis-aligned bounding box */
export interface AABB {
    /** Minimum coordinates. */
    readonly min: ReadonlyVec3;
    /** Maximum coordinates. */
    readonly max: ReadonlyVec3;
}

/** Bounding sphere */
export interface BoundingSphere {
    /** Sphere center. */
    readonly center: ReadonlyVec3;
    /** Sphere radius. */
    readonly radius: number;
}

/** @internal */
export type Base64String = string;

/** Scene materials property arrays, encoded as base 64 strings. */
export interface MaterialProperties {
    /** Diffuse color properties. */
    readonly diffuse: {
        readonly red: Base64String;
        readonly green: Base64String;
        readonly blue: Base64String;
    };
    /** Opacity properties. */
    readonly opacity: Base64String;
    /** Specular properties. */
    readonly specular: {
        readonly red: Base64String;
        readonly green: Base64String;
        readonly blue: Base64String;
    };
    /** Shininess properties. */
    readonly shininess: Base64String;
}

/** Flags for what types of geometry to render or not. */
export interface RenderStateStaticGeometryKinds {
    /** Whether to render terrain geometry. */
    readonly terrain?: boolean,
    /** Whether to render (non-terrain) triangles. */
    readonly triangles?: boolean,
    /** Whether to render lines. */
    readonly lines?: boolean,
    /** Whether to render point (clouds). */
    readonly points?: boolean,
    /** Whether to render document geometry, e.g. rendered PDF. */
    readonly documents?: boolean,
};

/** Scene Configuration */
export interface SceneConfig {
    /** Scene kind. */
    readonly kind: "octree";
    /** Scene id. */
    readonly id: string;
    /** Binary format version. */
    readonly version: string;
    /** Weighted center point of scene, in world space. */
    readonly center: ReadonlyVec3;
    /** Offset used to geo reference scene, in world space. */
    readonly offset: ReadonlyVec3;
    /** Scene bounding sphere, in world space. */
    readonly boundingSphere: BoundingSphere; // bounding sphere in model space
    /** Scene bounding box, in world space. */
    readonly aabb: AABB;
    /** Byte size of root node. */
    readonly rootByteSize: number;
    /** Total # of selectable objects in scene. */
    readonly numObjects: number;
    /** Total # of materials in scene. */
    readonly numMaterials: number;
    /** Scene material properties. */
    readonly materialProperties: MaterialProperties;

    /** Model to world space transformation matrix. */
    readonly modelWorldMatrix?: ReadonlyMat4; //
    /** List of geometry type subtrees within this scene. */
    readonly subtrees?: ("" | "terrain" | "triangles" | "lines" | "points" | "documents")[];
    /** Optional point cloud attributes. */
    readonly variants?: ("deviation" | "intensity")[];
    /** Binary root node meta information */
    readonly root: Base64String;
}

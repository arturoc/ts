import type { ReadonlyQuat, ReadonlyVec3, ReadonlyVec4, ReadonlyMat4, ReadonlyMat3 } from "gl-matrix";
import type { RGB, RGBA, FixedSizeArray, RecursivePartial } from "./types";
import type { RenderStateScene } from "./scene";
import type { RenderStateDynamicObjects } from "./dynamic";
export * from "./dynamic";
export * from "./types";
export * from "./scene";
export * from "./default";
export * from "./modify";

export interface RenderState {
    readonly output: RenderStateOutput;
    readonly background: RenderStateBackground;
    readonly camera: RenderStateCamera;
    readonly quality: RenderStateQuality;
    readonly grid: RenderStateGrid;
    readonly debug: RenderStateDebug;
    readonly cube: RenderStateCube;
    readonly scene: RenderStateScene | undefined;
    readonly terrain: RenderStateTerrain;
    readonly dynamic: RenderStateDynamicObjects;
    readonly clipping: RenderStateClipping;
    readonly highlights: RenderStateHighlightGroups;
    readonly outlines: RenderStateOutlines;
    readonly tonemapping: RenderStateTonemapping;
    readonly points: RenderStatePointCloud;
    readonly toonOutline: RenderStateToonOutline;
    readonly pick: RenderStatePick;
}

export interface DerivedRenderState extends RenderState {
    readonly localSpaceTranslation: ReadonlyVec3; // local space is a variant of world space that is much closer to camera to avoid excessively (for float32) large coordinates in shader
    readonly matrices: Matrices;
    readonly viewFrustum: ViewFrustum; // in world space
    readonly effectiveSamplesMSAA: number; // from output.SamplesMSAA, but limited to device's MAX_SAMPLES
}

export type RenderStateChanges = RecursivePartial<RenderState>;

export interface ViewFrustum {
    readonly left: ReadonlyVec4;
    readonly right: ReadonlyVec4;
    readonly top: ReadonlyVec4;
    readonly bottom: ReadonlyVec4;
    readonly near: ReadonlyVec4;
    readonly far: ReadonlyVec4;
    readonly image: ReadonlyVec4; // a plane coincident with camera position and parallel to screen/image plane in world space
    readonly planes: readonly [left: ReadonlyVec4, right: ReadonlyVec4, top: ReadonlyVec4, bottom: ReadonlyVec4, near: ReadonlyVec4, far: ReadonlyVec4];
}

export enum CoordSpace {
    World,
    View,
    Clip,
};

export interface Matrices {
    getMatrix(from: CoordSpace, to: CoordSpace): ReadonlyMat4;
    getMatrixNormal(from: CoordSpace, to: CoordSpace): ReadonlyMat3;
}

export interface RenderStateOutput {
    readonly width: number;
    readonly height: number;
    readonly samplesMSAA: number;
}

export interface RenderStateBackground {
    readonly color?: RGBA;
    readonly url?: string;
    readonly blur?: number;
}

export interface RenderStateCamera {
    readonly kind: "pinhole" | "orthographic";
    readonly position: ReadonlyVec3;
    readonly rotation: ReadonlyQuat;
    readonly pivot: ReadonlyVec3 | undefined;
    readonly fov: number;
    readonly near: number;
    readonly far: number;
}

export interface RenderStateQuality {
    readonly detail: number;
}

export interface RenderStateDebug {
    readonly showNodeBounds: boolean;
}

export interface RenderStateGrid {
    readonly enabled: boolean;
    readonly color: RGB;
    readonly origin: ReadonlyVec3;
    readonly axisX: ReadonlyVec3;
    readonly axisY: ReadonlyVec3;
    readonly size1: number; // minor grid cell size, default = 1
    readonly size2: number; // major grid cell size, default = 10
    readonly distance: number; // max distance to render grid
}

export const CubeId = 0xfffffff8; // object_id for picking

export interface RenderStateCube {
    readonly enabled: boolean; // default = false
    readonly position: ReadonlyVec3; // default = (0,0,0)
    readonly scale: number; // default = 1
}

/** Gradient curve knot node. */
export interface RenderStateColorGradientKnot<T extends RGB | RGBA> {
    /** Knot position on the gradient ramp. */
    readonly position: number;
    /** Color to use at this gradient position. */
    readonly color: T;
}

/** A color gradient curve.
 * @remarks
 * This curve is used to visualize some scalar value as a color gradient, e.g. terrain evelvation or point cloud devience.
 */
export interface RenderStateColorGradient<T extends RGB | RGBA> {
    /**A set of knots defining a non-uniform linear spline curve.
     * @remarks
     * Nodes must be sorted in ascending order of elevation!
     * At least two nodes are required for any sort of gradient.
     * Nodes do not have to be uniformly distributed elevation-wise.
     * To create a discontinuity in the gradient, two adjacent nodes with identical elevation, but different colors may be used.
     * Any elevation outside the min/max range defined by this list will be clamped to the color of the nearest node (min or max), i.e., no extrapolation will occur.
     */
    readonly knots: readonly RenderStateColorGradientKnot<T>[];
}

/** Terrain render state. */
export interface RenderStateTerrain {
    /** Elevation gradient color curve.
     * @remarks
     * Elevations are defined as in meters above/below sea level (using negative values for sub sea terrain).
     */
    readonly elevationGradient: RenderStateColorGradient<RGB>;
    /** Flag for whether to draw terrain as background. */
    readonly asBackground: boolean;
};

/** Point cloud settings.
 * @remarks
 * The sizes are cumulative and computed as follows:
 * ``effective_point_pixel_size = max(1, pixelSize + projectedSizeOf(metricSize + tolerance * toleranceFactor))``.
 * Metric size is projected as a 3D sphere at the point origo to deterine pixel size.
 * The term pixel refers to the size of a pixel in the target canvas element, which resolution may differ from that of the render buffer.
 */
export interface RenderStatePointCloud {
    readonly size: {
        /** Point size in pixels. */
        pixel: number | undefined;
        /** Max point size in pixels. */
        maxPixel: number | undefined;
        /** Point size in meters. */
        metric: number | undefined;
        /** The scaling factor for applying the tolerance of the current level of detail to point size.
         * @remarks
         * Different levels of detail (LOD) will have different point densities.
         * Taking this difference into account may result in a more uniform point coverage and visually pleasing result.
         * The tolerance of each LOD reflects the point merging distance threshold in meters used to reduce # points, or 0 for the original level of detail.
         */
        toleranceFactor: number;
    };

    readonly deviation: {
        readonly index: number; // 0-3, which deviance vertex attribute to render
        readonly mixFactor: number; // 0-1, where 0 is 100% original vertex color and 1 is 100% color gradient color
        readonly colorGradient: RenderStateColorGradient<RGBA>;
    };


    /**Use pre calculated projected position instead of original */
    readonly useProjectedPosition: boolean;
}

export enum ClippingMode {
    intersection,
    union,
}

export enum ClippingId { // object_id's for picking
    plane0 = 0xfffffff0, plane1, plane2, plane3, plane4, plane5, plane6
}

export interface RenderStateClippingPlane {
    readonly normalOffset: ReadonlyVec4,
    readonly color?: RGBA;
}

export interface RenderStateClipping {
    readonly enabled: boolean;
    readonly draw: boolean;
    readonly mode: ClippingMode;
    readonly planes: readonly RenderStateClippingPlane[];
}

/** 5x4 row-major matrix for color/opacity transform.
 * @remarks
 * This matrix defines the linear transformation that is applied to the original RGBA color before rendering.
 * The fifth column is multiplied by a constant 1, making it useful for translation.
 * The resulting colors are computed thus:
 * ```
 * output_red = r*m[0] + g*m[1] + b*m[2] + a*m[3] + m[4]
 * output_green = r*m[5] + g*m[6] + b*m[7] + a*m[8] + m[9]
 * output_blue = r*m[10] + g*m[11] + b*m[12] + a*m[13] + m[14]
 * output_alpha = r*m[15] + g*m[16] + b*m[17] + a*m[18] + m[19]
 * ```
 * All input values are between 0 and 1 and output value will be clamped to this range.
 */
export type RGBATransform = FixedSizeArray<20, number>;

export interface RenderStateHighlightGroup {
    readonly rgbaTransform: RGBATransform | null; // null transform will hide group more effectively than using alpha=0
    readonly objectIds: Iterable<number>; // must be sorted in ascending order!
}

export interface RenderStateHighlightGroups {
    readonly defaultHighlight: RGBATransform;
    readonly groups: readonly RenderStateHighlightGroup[];
}

export enum TonemappingMode {
    color,
    normal,
    depth,
    objectId,
    deviation,
    zbuffer,
};

export interface RenderStateOutlinesNearClipping {
}

export interface RenderStateOutlines {
    readonly enabled: boolean;
    readonly color: RGB;
    readonly plane: ReadonlyVec4;
}

export interface RenderStateTonemapping {
    /** Camera light exposure as stops of power of 2.
     * @remarks
     * Negative values darkens the image, while positive ones brightens it.
     * The default value is 0.0.
     */
    readonly exposure: number;

    /** Debug display frame buffer */
    readonly mode: TonemappingMode;
}

export interface RenderStateToonOutline {
    readonly enabled: boolean;
    readonly color: RGB;
    readonly onlyOnIdleFrame: boolean;
}

export interface RenderStatePick {
    /** The opacity/alpha minimum (inclusive) threshold at which to include a pixel in the pick output.
     * @public
     * @remarks
     * A value between 0 and 1, where 0 includes all pixels no matter how transparent and 1 only includes 100% opaque pixels.
     * The default value is 1.
     */
    readonly opacityThreshold: number;
}
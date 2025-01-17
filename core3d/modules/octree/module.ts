import type { DeviceProfile, RenderContext } from "core3d";
import type { RenderModule } from "..";
import { glUBOProxy, type TextureParams2DUncompressed, type UniformTypes } from "webgl2";
import type { ResourceBin } from "core3d/resource";
import { OctreeModuleContext } from "./context";
import { NodeLoader } from "./loader";

/** @internal */
export const enum ShaderPass { color, pick, pre };
/** @internal */
export const enum ShaderMode { triangles, points, terrain };
/** @internal */
export const enum Gradient { size = 1024 };

/** @internal */
export class OctreeModule implements RenderModule {
    readonly kind = "octree";
    readonly sceneUniforms = {
        applyDefaultHighlight: "bool",
        iblMipCount: "float",
        pixelSize: "float",
        maxPixelSize: "float",
        metricSize: "float",
        toleranceFactor: "float",
        deviationIndex: "int",
        deviationFactor: "float",
        deviationRange: "vec2",
        deviationUndefinedColor: "vec4",
        useProjectedPosition: "bool",
        elevationRange: "vec2",
        pickOpacityThreshold: "float",
    } as const satisfies Record<string, UniformTypes>;

    readonly gradientImageParams: TextureParams2DUncompressed = { kind: "TEXTURE_2D", width: Gradient.size, height: 2, internalFormat: "RGBA8", type: "UNSIGNED_BYTE", image: null };
    readonly maxHighlights = 8;

    static readonly textureNames = ["base_color", "ibl.diffuse", "ibl.specular", "materials", "highlights", "gradients"] as const;
    static readonly textureUniforms = OctreeModule.textureNames.map(name => `textures.${name}`);
    static readonly uniformBufferBlocks = ["Camera", "Clipping", "Scene", "Node"];
    static readonly passes = [ShaderPass.color, ShaderPass.pick, ShaderPass.pre] as const;
    static readonly modes = [ShaderMode.triangles, ShaderMode.points, ShaderMode.terrain] as const;

    async withContext(context: RenderContext) {
        const uniforms = this.createUniforms();
        const resources = await this.createResources(context, uniforms);

        const loader = new NodeLoader(context.imports.loaderWorker);
        const maxObjects = 10_000_000;// TODO: Get from device profile?
        const maxByteLength = maxObjects + 4; // add four bytes for mutex
        const buffer = new SharedArrayBuffer(maxByteLength);
        await loader.setBuffer(buffer);
        return new OctreeModuleContext(context, this, uniforms, resources, buffer, loader);
    }

    createUniforms() {
        return {
            scene: glUBOProxy(this.sceneUniforms),
        } as const;
    }

    async createResources(context: RenderContext, uniforms: Uniforms) {
        const shaders = context.imports.shaders.octree;
        const bin = context.resourceBin("Watermark");
        const sceneUniforms = bin.createBuffer({ kind: "UNIFORM_BUFFER", srcData: uniforms.scene.buffer });
        const samplerNearest = bin.createSampler({ minificationFilter: "NEAREST", magnificationFilter: "NEAREST", wrap: ["CLAMP_TO_EDGE", "CLAMP_TO_EDGE"] });
        const defaultBaseColorTexture = bin.createTexture({ kind: "TEXTURE_2D", width: 1, height: 1, internalFormat: "RGBA8", type: "UNSIGNED_BYTE", image: new Uint8Array([255, 255, 255, 255]) });
        const materialTexture = bin.createTexture({ kind: "TEXTURE_2D", width: 256, height: 1, internalFormat: "RGBA8", type: "UNSIGNED_BYTE", image: null });
        const highlightTexture = bin.createTexture({ kind: "TEXTURE_2D", width: 256, height: 5, internalFormat: "RGBA32F", type: "FLOAT", image: null });
        const gradientsTexture = bin.createTexture(this.gradientImageParams);

        const transformFeedback = bin.createTransformFeedback()!;
        let vb_line: WebGLBuffer | null = null;
        let vao_line: WebGLVertexArrayObject | null = null;
        if (context.deviceProfile.features.outline) {
            vb_line = bin.createBuffer({ kind: "ARRAY_BUFFER", byteSize: this.maxLines * 24, usage: "STATIC_DRAW" });
            vao_line = bin.createVertexArray({
                attributes: [
                    { kind: "FLOAT_VEC4", buffer: vb_line, byteStride: 24, byteOffset: 0, componentType: "FLOAT", divisor: 1 }, // positions in plane space (line vertex pair)
                    { kind: "FLOAT", buffer: vb_line, byteStride: 24, byteOffset: 16, componentType: "FLOAT", divisor: 1 }, // opacity
                    { kind: "UNSIGNED_INT", buffer: vb_line, byteStride: 24, byteOffset: 20, componentType: "UNSIGNED_INT", divisor: 1 }, // object_id
                ],
            });
        }

        const { uniformBufferBlocks } = OctreeModule;
        const shadersPromise = OctreeModule.compileShaders(context, bin);
        const [/*color, pick, pre,*/ intersect, line, debug, corePrograms] = await Promise.all([
            // context.makeProgramAsync(bin, { ...shaders.render, uniformBufferBlocks, textureUniforms, header: OctreeModule.shaderConstants(ShaderPass.color, ShaderMode.triangles) }),
            // context.makeProgramAsync(bin, { ...shaders.render, uniformBufferBlocks, textureUniforms, header: OctreeModule.shaderConstants(ShaderPass.pick, ShaderMode.triangles) }),
            // context.makeProgramAsync(bin, { ...shaders.render, uniformBufferBlocks, textureUniforms, header: OctreeModule.shaderConstants(ShaderPass.pre, ShaderMode.triangles) }),
            context.makeProgramAsync(bin, { ...shaders.intersect, uniformBufferBlocks: ["Camera", "Clipping", "Outline", "Node"], transformFeedback: { varyings: ["line_vertices", "opacity", "object_id"], bufferMode: "INTERLEAVED_ATTRIBS" } }),
            context.makeProgramAsync(bin, { ...shaders.line, uniformBufferBlocks: ["Camera", "Clipping", "Outline", "Node"], header: { flags: context.deviceProfile.quirks.adreno600 ? ["ADRENO600"] : [] } }),
            context.makeProgramAsync(bin, { ...shaders.debug, uniformBufferBlocks }),
            shadersPromise,
        ]);
        const programs: Programs = { ...corePrograms, intersect, line, debug };
        // const programs = { color, pick, pre, intersect, line, debug };
        // const programs = { intersect, line, debug };
        return {
            bin, programs,
            transformFeedback, vb_line, vao_line,
            sceneUniforms, samplerNearest, defaultBaseColorTexture, materialTexture, highlightTexture, gradientsTexture
        } as const;
    }

    static readonly defaultProgramFlags = {
        clip: false as boolean,
        dither: false as boolean,
        highlight: false as boolean,
    } as const;

    static shaderConstants(deviceProfile: DeviceProfile, pass: ShaderPass, mode: ShaderMode, programFlags = OctreeModule.defaultProgramFlags) {
        const { clip, dither, highlight } = programFlags;
        const flags: string[] = [];
        if (clip || deviceProfile.quirks.slowShaderRecompile) { //Always complie in clip on devices with slow recomplie.
            flags.push("CLIP");
        }
        if (dither) {
            flags.push("DITHER");
        }
        if (highlight) {
            flags.push("HIGHLIGHT");
        }
        if (deviceProfile.quirks.adreno600) {
            flags.push("ADRENO600");
        }
        const defines = [
            { name: "PASS", value: pass.toString() },
            { name: "MODE", value: mode.toString() },
        ];
        return { defines, flags } as const;
    }

    static async compileShaders(context: RenderContext, bin: ResourceBin, programFlags = OctreeModule.defaultProgramFlags): Promise<PassPrograms> {
        const shaders = context.imports.shaders.octree;
        const { textureUniforms, uniformBufferBlocks } = OctreeModule;
        const programs = {} as Mutable<PassPrograms>;
        const promises: Promise<void>[] = [];
        for (const pass of OctreeModule.passes) {
            const modes = {} as Mutable<ModePrograms>;
            for (const mode of OctreeModule.modes) {
                const promise = context.makeProgramAsync(bin, { ...shaders.render, uniformBufferBlocks, textureUniforms, header: OctreeModule.shaderConstants(context.deviceProfile, pass, mode, programFlags) });
                const compiledPromise = promise.then(program => {
                    modes[mode] = program;
                });
                promises.push(compiledPromise);
            }
            programs[pass] = modes;
        }
        await Promise.all(promises);
        return programs;
    }

    readonly maxLines = 1024 * 1024; // TODO: find a proper size!
}

type Mutable<T> = { -readonly [P in keyof T]: T[P] };
/** @internal */
export type Uniforms = ReturnType<OctreeModule["createUniforms"]>;
/** @internal */
export type Resources = Awaited<ReturnType<OctreeModule["createResources"]>>;
type PassPrograms = { readonly [P in keyof typeof ShaderPass]: ModePrograms };
type ModePrograms = { readonly [P in keyof typeof ShaderMode]: WebGLProgram };
/** @internal */
export interface Programs extends PassPrograms {
    readonly intersect: WebGLProgram;
    readonly line: WebGLProgram;
    readonly debug: WebGLProgram;
}


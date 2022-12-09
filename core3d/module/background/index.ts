import type { DerivedRenderState, RenderContext, RenderStateBackground } from "core3d";
import { RenderModuleContext, RenderModule, RenderModuleState } from "..";
import { createUniformsProxy, glClear, glProgram, glSampler, glTexture, glDraw, glUniformLocations, glState, TextureParams, glBuffer, glDelete, TextureParams2DUncompressedMipMapped } from "webgl2";
import { KTX } from "./ktx";
import vertexShader from "./shader.vert";
import fragmentShader from "./shader.frag";

export class BackgroundModule implements RenderModule {
    private abortController: AbortController | undefined;
    url: string | undefined;
    textureParams: {
        readonly background: TextureParams;
        readonly irradiance: TextureParams;
        readonly radiance: TextureParams;
    } | null | undefined = null; // null means no textures, whereas undefined means no change in textures
    numMipMaps = 0;

    readonly uniforms = {
        envBlurNormalized: "float",
        mipCount: "int",
    } as const;

    withContext(context: RenderContext) {
        return new BackgroundModuleInstance(context, this);
    }

    // TODO: Move into worker?
    async downloadTextures(urlDir: string) {
        if (this.abortController) {
            this.abortController.abort();
        }
        const abortController = this.abortController = new AbortController();
        const { signal } = abortController;
        try {
            const scriptUrl = (document.currentScript as HTMLScriptElement | null)?.src ?? import.meta.url;
            const baseUrl = new URL(urlDir, scriptUrl);
            const promises = [
                download(new URL("background.ktx", baseUrl)),
                download(new URL("irradiance.ktx", baseUrl)),
                download(new URL("radiance.ktx", baseUrl)),
            ];
            const [background, irradiance, radiance] = await Promise.all(promises);
            this.textureParams = { background, irradiance, radiance } as const;
            const { mipMaps } = radiance as TextureParams2DUncompressedMipMapped;
            this.numMipMaps = typeof mipMaps == "number" ? mipMaps : mipMaps.length;
        } finally {
            this.abortController = undefined;
        }

        async function download(url: URL) {
            const response = await fetch(url, { mode: "cors", signal });
            if (response.ok) {
                var ktxData = await response.arrayBuffer();
                var params = KTX.parseKTX(ktxData);
                return params;
            } else {
                throw new Error(`HTTP Error:${response.status} ${response.status}`);
            }
        }
    }
}

interface RelevantRenderState {
    background: RenderStateBackground;
};

class BackgroundModuleInstance implements RenderModuleContext {
    readonly state;
    readonly uniforms;
    readonly textureUniformLocations;
    readonly resources;
    textures: undefined | {
        readonly background: WebGLTexture;
        readonly irradiance: WebGLTexture;
        readonly radiance: WebGLTexture;
    };

    constructor(readonly context: RenderContext, readonly data: BackgroundModule) {
        this.state = new RenderModuleState<RelevantRenderState>();
        const { gl } = context;
        this.uniforms = createUniformsProxy(data.uniforms);
        const uniformBufferBlocks = ["Camera", "Background"];
        const program = glProgram(gl, { vertexShader, fragmentShader, uniformBufferBlocks });
        const sampler = glSampler(gl, { minificationFilter: "LINEAR", magnificationFilter: "LINEAR", wrap: ["CLAMP_TO_EDGE", "CLAMP_TO_EDGE"] });
        const samplerMip = glSampler(gl, { minificationFilter: "LINEAR_MIPMAP_LINEAR", magnificationFilter: "LINEAR", wrap: ["CLAMP_TO_EDGE", "CLAMP_TO_EDGE"] });
        const uniforms = glBuffer(gl, { kind: "UNIFORM_BUFFER", size: this.uniforms.buffer.byteLength });
        this.resources = { program, sampler, samplerMip, uniforms } as const;
        this.textureUniformLocations = glUniformLocations(gl, program, ["background", "radiance"], "textures_");
    }

    updateUniforms(state: RelevantRenderState) {
        const { background } = state;
        const { values } = this.uniforms;
        values.envBlurNormalized = background.blur ?? 0;
        values.mipCount = this.data.numMipMaps; // 9
    }

    update(state: DerivedRenderState) {
        const { context, resources, data } = this;
        const { gl } = context;
        const { textureParams } = data;
        const { background } = state;

        if (textureParams !== undefined) {
            if (textureParams !== null) {
                const { background, irradiance, radiance } = textureParams;
                this.textures = {
                    background: glTexture(gl, background),
                    irradiance: glTexture(gl, irradiance),
                    radiance: glTexture(gl, radiance),
                };
            } else {
                this.textures = undefined;
            }
            data.textureParams = undefined; // we don't really want to keep a js mem copy of these.
        }

        if (this.state.hasChanged({ background }) || textureParams) {
            this.updateUniforms(state);
            context.updateUniformBuffer(resources.uniforms, this.uniforms);
            const { url } = state.background;
            if (url && (url != data.url)) {
                data.downloadTextures(url).then(() => { context.changed = true; });
            } else if (!url) {
                const { textures } = this;
                if (textures) {
                    const { background, irradiance, radiance } = textures;
                    gl.deleteTexture(background);
                    gl.deleteTexture(irradiance);
                    gl.deleteTexture(radiance);
                    this.textures = undefined;
                    data.textureParams = null;
                }
            }
            data.url = url;
        }
    }

    prepass() {
        glClear(this.context.gl, { kind: "DEPTH_STENCIL", depth: 1.0, stencil: 0 });
    }

    render() {
        const { context, resources, state } = this;
        const { program, uniforms, sampler, samplerMip } = resources;
        const { gl, cameraUniforms } = context;

        glState(gl, {
            drawBuffers: ["NONE", "COLOR_ATTACHMENT1", "COLOR_ATTACHMENT2", "COLOR_ATTACHMENT3"],
        });
        if (!context.usePrepass) {
            glClear(gl, { kind: "DEPTH_STENCIL", depth: 1.0, stencil: 0 });
        }
        glClear(gl, { kind: "COLOR", drawBuffer: 1, type: "Float", color: [Number.NaN, Number.NaN, 0, 0] });
        glClear(gl, { kind: "COLOR", drawBuffer: 2, type: "Float", color: [Number.POSITIVE_INFINITY, 0, 0, 0] });
        glClear(gl, { kind: "COLOR", drawBuffer: 3, type: "Uint", color: [0xffffffff, 0xffffffff, 0, 0] }); // 0xffff is bit-encoding for Float16.nan. (https://en.wikipedia.org/wiki/Half-precision_floating-point_format)
        glState(gl, {
            drawBuffers: ["COLOR_ATTACHMENT0"],
        });

        if (this.textures) {
            const { textureUniformLocations, textures } = this;
            glState(gl, {
                program,
                uniformBuffers: [cameraUniforms, uniforms],
                textures: [
                    { kind: "TEXTURE_CUBE_MAP", texture: textures.background, sampler, uniform: textureUniformLocations.background },
                    { kind: "TEXTURE_CUBE_MAP", texture: textures.radiance, sampler: samplerMip, uniform: textureUniformLocations.radiance },
                ],
                depthTest: false,
                depthWriteMask: false,
            });
            glDraw(gl, { kind: "arrays", mode: "TRIANGLE_STRIP", count: 4 });
        } else {
            glClear(gl, { kind: "COLOR", drawBuffer: 0, color: state.current?.background.color });
        }
    }

    contextLost() {
        const { data } = this;
        data.url = undefined; // force a envmap texture reload
    }

    dispose() {
        const { context, resources, textures } = this;
        const { gl } = context;
        this.contextLost();
        glDelete(gl, resources);
        if (textures) {
            glDelete(gl, { resources: textures });
            this.textures = undefined;
        }
    }
}

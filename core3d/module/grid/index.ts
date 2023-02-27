import type { DerivedRenderState, RenderContext } from "@novorender/core3d";
import type { RenderModuleContext, RenderModule } from "..";
import { glUBOProxy, glDraw, glState, type UniformTypes } from "@novorender/webgl2";
import vertexShader from "./shader.vert";
import fragmentShader from "./shader.frag";
import { mat4, vec3 } from "gl-matrix";
import { type ResourceBin } from "@novorender/core3d/resource";

export class GridModule implements RenderModule {
    readonly uniforms = {
        origin: "vec3",
        axisX: "vec3",
        axisY: "vec3",
        size1: "float",
        size2: "float",
        color: "vec3",
        distance: "float",
    } as const satisfies Record<string, UniformTypes>;

    withContext(context: RenderContext) {
        return new GridModuleContext(context, this, context.resourceBin("Grid"));
    }
}

class GridModuleContext implements RenderModuleContext {
    readonly uniforms;
    readonly resources;

    constructor(readonly context: RenderContext, readonly data: GridModule, readonly resourceBin: ResourceBin) {
        this.uniforms = glUBOProxy(data.uniforms);
        const { gl, commonChunk } = context;
        const program = resourceBin.createProgram({ vertexShader, fragmentShader, commonChunk, uniformBufferBlocks: ["Camera", "Grid"] });
        const uniforms = resourceBin.createBuffer({ kind: "UNIFORM_BUFFER", srcData: this.uniforms.buffer });
        this.resources = { program, uniforms } as const;
    }

    update(state: DerivedRenderState) {
        const { context, resources } = this;
        const { uniforms } = resources;
        const { grid, localSpaceTranslation } = state;
        if (context.hasStateChanged({ grid, localSpaceTranslation })) {
            const { values } = this.uniforms;
            const { axisX, axisY, origin } = grid;
            const worldLocalMatrix = mat4.fromTranslation(mat4.create(), vec3.negate(vec3.create(), localSpaceTranslation));
            values.origin = vec3.transformMat4(vec3.create(), origin, worldLocalMatrix);
            values.axisX = axisX;
            values.axisY = axisY;
            values.color = grid.color;
            values.size1 = grid.size1;
            values.size2 = grid.size2;
            values.distance = grid.distance;
            context.updateUniformBuffer(uniforms, this.uniforms);
        }
    }

    render(state: DerivedRenderState) {
        const { context, resources } = this;
        const { program, uniforms } = resources;
        const { gl, cameraUniforms } = context;

        if (state.grid.enabled) {
            glState(gl, {
                program,
                uniformBuffers: [cameraUniforms, uniforms],
                depth: {
                    test: true,
                    writeMask: false,
                },
                blend: {
                    enable: true,
                    srcRGB: "SRC_ALPHA",
                    dstRGB: "ONE_MINUS_SRC_ALPHA",
                    srcAlpha: "ZERO",
                    dstAlpha: "ONE",
                },
            });
            const stats = glDraw(gl, { kind: "arrays", mode: "TRIANGLE_STRIP", count: 4 });
            context["addRenderStatistics"](stats);
        }
    }

    contextLost(): void {
    }

    dispose() {
        this.contextLost();
        this.resourceBin.dispose();
    }
}
import type { DerivedRenderState, Matrices, RenderContext, RenderStateGrid } from "core3d";
import { CoordSpace } from "core3d";
import { RenderModuleContext, RenderModule, RenderModuleState } from "..";
import { createUniformBufferProxy } from "core3d/uniforms";
import vertexShader from "./shader.vert";
import fragmentShader from "./shader.frag";
import { mat4 } from "gl-matrix";

export class GridModule implements RenderModule {
    readonly uniformsData;
    constructor() {
        this.uniformsData = createUniformBufferProxy({
            objectClipMatrix: "mat4",
            color: "vec4",
            size: "int",
            spacing: "float",
        });
    }

    withContext(context: RenderContext) {
        return new GridModuleContext(context, this.uniformsData);
    }
}

type UniformsData = GridModule["uniformsData"];

interface RelevantRenderState {
    grid: RenderStateGrid;
    matrices: Matrices;
};

// class GridModuleContext extends RenderModuleBase<RelevantRenderState> implements RenderModuleContext {
class GridModuleContext implements RenderModuleContext {
    private readonly state;
    readonly program: WebGLProgram;
    readonly gridUniformsBuffer: WebGLBuffer;

    constructor(readonly context: RenderContext, readonly gridUniformsData: UniformsData) {
        this.state = new RenderModuleState<RelevantRenderState>();
        const { renderer } = context;
        // create static GPU resources here
        const uniformBufferBlocks = ["Camera", "Grid"];
        this.program = renderer.createProgram({ vertexShader, fragmentShader, uniformBufferBlocks });
        this.gridUniformsBuffer = renderer.createBuffer({ kind: "UNIFORM_BUFFER", srcData: gridUniformsData.buffer });
    }

    render(state: DerivedRenderState) {
        const { context, program, gridUniformsBuffer } = this;
        const { renderer, cameraUniformsBuffer } = context;
        if (this.state.hasChanged(state)) {
            const { gridUniformsData } = this;
            updateUniforms(gridUniformsData.uniforms, state);
            renderer.update({ kind: "UNIFORM_BUFFER", srcData: gridUniformsData.buffer, targetBuffer: gridUniformsBuffer });
            // const { begin, end } = gridUniformsData.dirtyRange;
            // renderer.update({ kind: "UNIFORM_BUFFER", srcData: gridUniformsData.buffer, targetBuffer: gridUniformsBuffer, size: end - begin, srcOffset: begin, targetOffset: begin });
        }

        if (state.grid.enabled) {
            const { size } = state.grid;
            renderer.state({
                program,
                uniformBuffers: [cameraUniformsBuffer, gridUniformsBuffer],
                depthTest: true,
            });
            renderer.draw({ kind: "arrays", mode: "LINES", count: (size + 1) * 2 * 2 });
        }
    }

    contextLost(): void {
    }

    dispose() {
        const { context, program, gridUniformsBuffer } = this;
        const { renderer } = context;
        this.contextLost();
        renderer.deleteProgram(program);
        renderer.deleteBuffer(gridUniformsBuffer);
    }
}

function updateUniforms(uniforms: UniformsData["uniforms"], state: RelevantRenderState) {
    const { grid, matrices } = state;
    const { axisX, axisY, origin } = grid;
    const m = [
        ...axisX, 0,
        ...axisY, 0,
        0, 0, 1, 0,
        ...origin, 1
    ] as Parameters<typeof mat4.fromValues>;
    const worldClipMatrix = matrices.getMatrix(CoordSpace.World, CoordSpace.Clip);
    const objectWorldMatrix = mat4.fromValues(...m);
    uniforms.objectClipMatrix = mat4.mul(mat4.create(), worldClipMatrix, objectWorldMatrix);
    uniforms.color = grid.color;
    uniforms.size = grid.size;
    uniforms.spacing = grid.spacing;
}

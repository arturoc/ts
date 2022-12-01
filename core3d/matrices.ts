import { mat3, mat4, ReadonlyMat3, ReadonlyMat4, vec3, vec4 } from "gl-matrix";
import { CoordSpace, Matrices, RenderStateCamera, RenderStateOutput } from "./state";

function index(from: CoordSpace, to: CoordSpace): number {
    return from * 4 + to;
}

export function matricesFromRenderState(state: { output: RenderStateOutput; camera: RenderStateCamera; }): Matrices {
    const { camera, output } = state;
    const { width, height } = output;
    const aspectRatio = width / height;
    const fovY = camera.fov * Math.PI / 180;
    const worldView = mat4.fromRotationTranslation(mat4.create(), camera.rotation, camera.position);
    const viewClip = mat4.perspective(mat4.create(), fovY, aspectRatio, camera.near, camera.far);
    return new MatricesImpl(worldView, viewClip);
}

class MatricesImpl implements Matrices {
    private _mtx4 = new Array<mat4 | undefined>(4 * 4);
    private _mtx3 = new Array<mat3 | undefined>(4 * 4);

    constructor(viewWorld: mat4, viewClip: mat4) {
        this._mtx4[index(CoordSpace.View, CoordSpace.World)] = viewWorld;
        this._mtx4[index(CoordSpace.View, CoordSpace.Clip)] = viewClip;
        const worldView = this._mtx4[index(CoordSpace.World, CoordSpace.View)] = mat4.create();
        const clipView = this._mtx4[index(CoordSpace.Clip, CoordSpace.View)] = mat4.create();
        mat4.invert(worldView, viewWorld);
        mat4.invert(clipView, viewClip);
    }

    getMatrix(from: CoordSpace, to: CoordSpace): ReadonlyMat4 {
        console.assert(from != to);
        const idx = index(from, to);
        let m = this._mtx4[idx];
        if (!m) {
            this._mtx4[idx] = m = mat4.create();
            // recursively combine from neighbor matrices
            if (to > from) {
                mat4.multiply(m, this.getMatrix(to - 1, to), this.getMatrix(from, to - 1));
            } else {
                mat4.multiply(m, this.getMatrix(from - 1, to), this.getMatrix(from, from - 1));
            }
        }
        return m;
    }

    getMatrixNormal(from: CoordSpace, to: CoordSpace): ReadonlyMat3 {
        console.assert(from != to);
        const idx = index(from, to);
        let m = this._mtx3[idx];
        if (!m) {
            this._mtx3[idx] = m = mat3.create();
            mat3.normalFromMat4(m, this.getMatrix(from, to));
        }
        return m;
    }
}

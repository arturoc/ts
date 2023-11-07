import type * as WasmNamespace from "@novorender/wasm-parser";

// For wasm bindgen target web
import * as wasmWrapper from "@novorender/wasm-parser/wasm_parser";

// For wasm bindgen target bundler
// // @ts-ignore
// import * as wasmWrapper from "@novorender/wasm-parser/wasm_parser_bg";

export type WasmInstance = typeof WasmNamespace;

/** @internal */
export async function esbuildWasmInstance(wasmData: ArrayBuffer): Promise<WasmInstance> {
    // For wasm bindgen target bundler
    // let imports = {
    //     ["./wasm_parser_bg.js"]: wasmWrapper,
    // };
    // const { instance } = await WebAssembly.instantiate(wasmData, imports);
    // wasmWrapper.__wbg_set_wasm(instance.exports);

    // For wasm bindgen target web
    await wasmWrapper.default(wasmData);

    // Common
    wasmWrapper.init_console();
    return wasmWrapper;
}
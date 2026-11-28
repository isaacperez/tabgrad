import { attachPython } from '/python.js';
import { checkResidentMatrixTransfers, compactPythonSource } from '/helpers/compact-float-cases.mjs';
import { pythonBooleanMaskSource } from '/helpers/boolean-mask-cases.mjs';
import { pythonArgmaxSource } from '/helpers/integer-argmax-cases.mjs';
import { pythonBadSelectionCopySource, pythonIndexSelectionSource } from "/helpers/index-selection-cases.mjs";
addEventListener('message', async ({ data }) => {
  let binding;
  try {
    for (const name of ['Suspending', 'promising', 'Suspender']) {
      if (!Reflect.deleteProperty(WebAssembly, name) || name in WebAssembly) throw Error(`Cannot disable JSPI: ${name}`);
    }
    const { loadPyodide } = await import('/pyodide/pyodide.mjs');
    const interpreter = await loadPyodide({ indexURL: '/pyodide/' });
    if (data.variant !== null) {
      const { selectCpuProfile } = await import('/helpers/cpu-profile.mjs');
      selectCpuProfile(data.variant);
    }
    binding = await attachPython(interpreter, data.webgpu ? { webgpu: data.webgpu } : {});
    const { source, composition, counts } = compactPythonSource(data.reference, data.device, data.dtype, data.fractionBits, data.arithmetic);
    await binding.runPythonAsync(source);
    if (composition) {
      const before = binding.diagnostics();
      await binding.runPythonAsync(composition);
      checkResidentMatrixTransfers(data.device, before, binding.diagnostics());
    }
    if (data.booleanMask) await binding.runPythonAsync(pythonBooleanMaskSource(data.device, data.grid));
    if (data.integerArgmax) await binding.runPythonAsync(pythonArgmaxSource(data.device));
    if (data.indexSelection) {
      await binding.runPythonAsync(pythonIndexSelectionSource(data.device));
      try {
        await binding.runPythonAsync(pythonBadSelectionCopySource(data.device));
        throw Error("The managed entry accepted a failed index_select copy");
      } catch (error) {
        if (error.code !== "INDEX_OUT_OF_BOUNDS") throw error;
      }
    }
    const beforeClose = binding.diagnostics();
    await binding.close();
    postMessage({ ok: true, pyodide: interpreter.version, worker: true, jspiAvailable: false,
      cases: { construction: data.reference.construction.words.length, pointwise: data.reference.pointwise.left.length,
        broadcasts: 10, oddDense: 2, channelCompositions: 1, ...counts },
      beforeClose, final: binding.diagnostics(), booleanMask: data.booleanMask });
  } catch (error) { postMessage({ ok: false, error: String(error) }); }
  finally { await binding?.close(); }
}, { once: true });

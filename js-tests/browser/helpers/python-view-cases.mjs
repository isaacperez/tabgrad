import { pythonTensorDeviceSource } from "./python-tensor-device.mjs";

/** Compare empty metadata without observing its potentially enormous outer list. */
export function pythonViewMetadataChecks(oracle, device = "cpu") {
  if (!Array.isArray(oracle.emptyViewMetadataCases) || oracle.emptyViewMetadataCases.length !== 24) {
    throw new Error("Missing native empty-view metadata cases");
  }
  const cases = oracle.emptyViewMetadataCases.map(fixture => ({
    ...fixture, source: pythonTensorDeviceSource(fixture.source, device),
    metadata: device === "cpu" ? fixture.metadata
      : fixture.metadata.with(5, "device(type='webgpu')").with(6, device).with(7, device),
  }));
  return `
import torch, json, gc
def check_empty_view_metadata():
    session = torch._runtime_session
    for case in json.loads(${JSON.stringify(JSON.stringify(cases))}):
        before = session.diagnostics()
        namespace = {'torch': torch}
        exec(case['source'], namespace)
        result, base = namespace['result'], namespace['base']
        assert result is not base
        assert ${oracle.metadataExpression} == case['metadata'], case['name']
        assert result.shape.numel() == case['numel'] == 0, case['name']
        after = session.diagnostics()
        assert after.kernelCalls == before.kernelCalls
        assert after.hostToWasmCopies == before.hostToWasmCopies
        assert after.liveAllocationBytes == before.liveAllocationBytes
        assert after.liveOperationRecords == before.liveOperationRecords
        assert after.liveTensorHandles == before.liveTensorHandles + 2
        if ${device === "webgpu" ? "True" : "False"}:
            for field in ['kernelCalls', 'uploadBytes', 'readbackBytes',
                          'ownedBufferBytes', 'pendingSubmissions']:
                assert getattr(after.webgpu, field) == getattr(before.webgpu, field)
        del namespace, base
        gc.collect()
        assert result.view(-1).tolist() == []
        del result
        gc.collect()
        assert session.diagnostics().liveTensorHandles == before.liveTensorHandles
        assert session.diagnostics().liveTensorValues == before.liveTensorValues
check_empty_view_metadata()
del check_empty_view_metadata
`;
}

/** Protect frontend types, runtime error order and rejection without publication. */
export function pythonViewBoundaryChecks(device = "cpu") {
  return `
import torch, gc
from pyodide.ffi import JsException
def check_view_boundaries():
    events = []
    class CustomInt(int):
        def __float__(self):
            events.append('float')
            raise AssertionError('custom coercion')
    class CustomList(list):
        def __iter__(self):
            events.append('iterate')
            raise AssertionError('custom iteration')
    class CustomTuple(tuple): pass
    class CustomIndex:
        def __index__(self):
            events.append('index')
            raise AssertionError('custom index')
    source = torch.tensor([], dtype=torch.float32, device=${JSON.stringify(device)})
    type_errors = ['source.view()', 'source.view(True)', 'source.view(0.0)',
        'source.view(CustomInt(0))', 'source.view(CustomList([0]))',
        'source.view(CustomTuple((0,)))', 'source.view(CustomIndex())',
        'source.view([0, 1.0])', 'source.view(shape=(0,))', 'source.view(torch.float32)']
    shape_errors = ['source.view(2**53, 0)', 'source.view(0, 2**53 + 1)',
        'source.view(10**1000, 0)', 'source.view(-10**1000, 0)',
        'source.view(-2**53, 0)', 'source.view(-2, 0)', 'source.view(-1, -1)',
        'source.view(0, -1)', 'source.view(())', 'source.view(1)']
    before = torch._runtime_session.diagnostics()
    for expressions, expected in [(type_errors, TypeError), (shape_errors, RuntimeError)]:
        for expression in expressions:
            try: eval(expression)
            except expected as error:
                if expected is RuntimeError:
                    assert isinstance(error.__cause__, JsException)
                    assert error.__cause__.js_error.code == 'INVALID_SHAPE'
            else: raise AssertionError(expression)
            after = torch._runtime_session.diagnostics()
            for field in ['liveTensorHandles', 'liveTensorValues', 'liveOperationRecords',
                          'liveDerivativeNodes', 'liveSavedValues', 'kernelCalls',
                          'hostToWasmCopies', 'liveAllocationBytes']:
                assert getattr(after, field) == getattr(before, field), (expression, field)
            if ${device === "webgpu" ? "True" : "False"}:
                for field in ['kernelCalls', 'uploadBytes', 'readbackBytes',
                              'ownedBufferBytes', 'pendingSubmissions']:
                    assert getattr(after.webgpu, field) == getattr(before.webgpu, field)
    assert events == []
    source._handle.close()
    for expression in type_errors:
        try: eval(expression)
        except TypeError: pass
        else: raise AssertionError(expression)
    for expression in shape_errors + ['source.view(2**53 - 1, 0)']:
        try: eval(expression)
        except JsException as error: assert error.js_error.code == 'CLOSED_TENSOR'
        else: raise AssertionError(expression)
    assert events == []
check_view_boundaries()
del check_view_boundaries
gc.collect()
`;
}

import { restrictDispatchAxis } from '/helpers/gpu-dispatch-cases.mjs';

/** Exercise grid dispatch on the real device without increasing allocations. */
export function restrictGpuDispatch() {
  const physical = navigator.gpu;
  Object.defineProperty(navigator, 'gpu', { value: {
    requestAdapter: async options => {
      const adapter = await physical.requestAdapter(options);
      if (adapter === null) return null;
      return new Proxy(adapter, { get(target, name) {
        if (name === 'requestDevice') return async descriptor => restrictDispatchAxis(await target.requestDevice(descriptor), 17);
        const value = Reflect.get(target, name, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
  } });
}

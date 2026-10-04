// Shared managed Python checks for main-thread and worker CPU profiles.
export const pythonNoGradChecks = `
import torch, gc
def check_no_grad():
    for data in (2., [2., 3.], [[], []]):
        x = torch.tensor(data, dtype=torch.float32, requires_grad=True)
        loss = (x * x).sum()
        with torch.no_grad() as entered:
            assert entered is None
            assert not (x * x).requires_grad
            v = x.view(tuple(x.shape))
            assert v.requires_grad
            factory = torch.tensor(5., dtype=torch.float32, requires_grad=True)
            assert factory.requires_grad
            assert torch.autograd.grad(factory, factory)[0].tolist() == 1.
            gradient = torch.autograd.grad(loss, x)[0]
        assert gradient.tolist() == (4. if x.shape == () else [4., 6.] if x.shape == (2,) else [[], []])
        active = v + v
        assert active.requires_grad
        seed = torch.tensor(data, dtype=torch.float32)
        assert torch.autograd.grad(active, active, seed)[0].tolist() == data
        for output, requested in ((v, v), (active, v), (active, x)):
            try:
                torch.autograd.grad(output, requested, seed)
            except RuntimeError:
                pass
            else:
                raise AssertionError('Special view acquired a derivative accumulator')
check_no_grad()
gc.collect()
assert torch._runtime_session.diagnostics().liveDerivativeNodes == 0
assert torch._runtime_session.diagnostics().liveSavedValues == 0
`;

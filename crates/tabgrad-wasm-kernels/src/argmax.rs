use crate::abi::{
    STATUS_INVALID_GEOMETRY, STATUS_OK, STATUS_OUT_OF_BOUNDS, STATUS_OUTPUT_OVERLAP,
    STATUS_UNALIGNED, checked_typed_range, overlaps,
};

trait Maximum: Copy {
    fn replaces(self, current: Self) -> bool;
}

impl Maximum for f32 {
    fn replaces(self, current: Self) -> bool {
        self > current || (self.is_nan() && !current.is_nan())
    }
}

impl Maximum for i32 {
    fn replaces(self, current: Self) -> bool {
        self > current
    }
}

impl Maximum for i64 {
    fn replaces(self, current: Self) -> bool {
        self > current
    }
}

fn argmax<T: Maximum>(input: u32, output: u32, groups: u32, terms: u32, inner: u32) -> u32 {
    let width = size_of::<T>() as u32;
    if !input.is_multiple_of(width) || !output.is_multiple_of(8) {
        return STATUS_UNALIGNED;
    }
    let Some(elements) = groups.checked_mul(terms) else {
        return STATUS_INVALID_GEOMETRY;
    };
    if terms == 0 || inner == 0 || !groups.is_multiple_of(inner) {
        return STATUS_INVALID_GEOMETRY;
    }
    let memory = core::arch::wasm32::memory_size(0) as u64 * 65_536;
    let Some(input_range) = checked_typed_range(input, elements, width, memory) else {
        return STATUS_OUT_OF_BOUNDS;
    };
    let Some(output_range) = checked_typed_range(output, groups, 8, memory) else {
        return STATUS_OUT_OF_BOUNDS;
    };
    if overlaps(input_range, output_range) {
        return STATUS_OUTPUT_OVERLAP;
    }

    let (groups, terms, inner) = (groups as usize, terms as usize, inner as usize);
    let source = input as *const T;
    let indices = output as *mut i64;
    for group in 0..groups {
        let first = (group / inner) * terms * inner + group % inner;
        // SAFETY: the checked product covers every source term and output group.
        unsafe {
            let mut maximum = source.add(first).read();
            let mut best = 0;
            for term in 1..terms {
                let candidate = source.add(first + term * inner).read();
                if candidate.replaces(maximum) {
                    maximum = candidate;
                    best = term;
                }
            }
            indices.add(group).write(best as i64);
        }
    }
    STATUS_OK
}

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_argmax_f32(
    input: u32,
    output: u32,
    groups: u32,
    terms: u32,
    inner: u32,
) -> u32 {
    argmax::<f32>(input, output, groups, terms, inner)
}

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_argmax_i32(
    input: u32,
    output: u32,
    groups: u32,
    terms: u32,
    inner: u32,
) -> u32 {
    argmax::<i32>(input, output, groups, terms, inner)
}

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_argmax_i64(
    input: u32,
    output: u32,
    groups: u32,
    terms: u32,
    inner: u32,
) -> u32 {
    argmax::<i64>(input, output, groups, terms, inner)
}

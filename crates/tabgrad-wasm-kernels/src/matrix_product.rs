use crate::abi::{
    FLOAT_ALIGNMENT, STATUS_INVALID_GEOMETRY, STATUS_OK, STATUS_OUT_OF_BOUNDS,
    STATUS_OUTPUT_OVERLAP, STATUS_UNALIGNED, checked_range, overlaps,
};
use crate::fused_multiply_add::fused_multiply_add;

fn validate_matrix_ranges(left: u32, right: u32, output: u32, m: u32, k: u32, n: u32, flags: u32) -> u32 {
    if flags > 3 { return STATUS_INVALID_GEOMETRY; }
    if !left.is_multiple_of(FLOAT_ALIGNMENT) || !right.is_multiple_of(FLOAT_ALIGNMENT)
        || !output.is_multiple_of(FLOAT_ALIGNMENT) { return STATUS_UNALIGNED; }
    let (Some(mk), Some(kn), Some(mn)) = (m.checked_mul(k), k.checked_mul(n), m.checked_mul(n)) else {
        return STATUS_OUT_OF_BOUNDS;
    };
    let memory_bytes = (core::arch::wasm32::memory_size(0) as u64) * 65_536;
    let (Some(a), Some(b), Some(c)) = (checked_range(left, mk, memory_bytes),
        checked_range(right, kn, memory_bytes), checked_range(output, mn, memory_bytes)) else {
        return STATUS_OUT_OF_BOUNDS;
    };
    if overlaps(c, a) || overlaps(c, b) { return STATUS_OUTPUT_OVERLAP; }
    STATUS_OK
}

#[cfg(target_feature = "simd128")]
unsafe fn vector_columns(left: *const f32, right: *const f32, output: *mut f32,
    m: usize, k: usize, n: usize, flags: u32, row: usize) -> usize {
    use core::arch::wasm32::*;
    use crate::fused_multiply_add::fused_multiply_add_four;
    let end = n - n % 4;
    for column in (0..end).step_by(4) {
        let mut accumulator = f32x4_splat(0.);
        for t in 0..k {
            // SAFETY: products and complete four-column blocks were range-checked.
            unsafe {
                let a = *left.add(if flags & 1 != 0 { t * m + row } else { row * k + t });
                let b = if flags & 2 != 0 {
                    f32x4(*right.add(column * k + t), *right.add((column + 1) * k + t),
                        *right.add((column + 2) * k + t), *right.add((column + 3) * k + t))
                } else { v128_load(right.add(t * n + column).cast()) };
                accumulator = fused_multiply_add_four(accumulator, f32x4_splat(a), b);
            }
        }
        // SAFETY: output is disjoint and this complete block is within MN.
        unsafe { v128_store(output.add(row * n + column).cast(), accumulator); }
    }
    end
}

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_matmul_f32(left_offset: u32, right_offset: u32, output_offset: u32,
    m: u32, k: u32, n: u32, flags: u32) -> u32 {
    let status = validate_matrix_ranges(left_offset, right_offset, output_offset, m, k, n, flags);
    if status != STATUS_OK || m == 0 || n == 0 { return status; }
    let left = left_offset as *const f32;
    let right = right_offset as *const f32;
    let output = output_offset as *mut f32;
    let (m, k, n) = (m as usize, k as usize, n as usize);
    for row in 0..m {
        let start = {
            #[cfg(target_feature = "simd128")]
            { unsafe { vector_columns(left, right, output, m, k, n, flags, row) } }
            #[cfg(not(target_feature = "simd128"))]
            { 0 }
        };
        for column in start..n {
            let mut accumulator = 0.;
            for t in 0..k {
                // SAFETY: all MK/KN/MN ranges and their products were checked.
                unsafe {
                    let a = *left.add(if flags & 1 != 0 { t * m + row } else { row * k + t });
                    let b = *right.add(if flags & 2 != 0 { column * k + t } else { t * n + column });
                    accumulator = fused_multiply_add(accumulator, a, b);
                }
            }
            // SAFETY: each output index is in the validated distinct MN range.
            unsafe { *output.add(row * n + column) = accumulator; }
        }
    }
    STATUS_OK
}

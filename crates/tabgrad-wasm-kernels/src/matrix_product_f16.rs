use crate::abi::STATUS_OK;
use crate::binary16::{decode, encode};
use crate::matrix_product::{left_index, right_index, validate_matrix_ranges};

const HALF_WIDTH: u32 = size_of::<u16>() as u32;

#[cfg(target_feature = "simd128")]
unsafe fn vector_columns(
    left: *const u16,
    right: *const u16,
    output: *mut u16,
    [m, k, n]: [usize; 3],
    flags: u32,
    row: usize,
) -> usize {
    use crate::binary16::decode_four;
    use core::arch::wasm32::*;

    let end = n - n % 4;
    for column in (0..end).step_by(4) {
        let mut accumulator = f32x4_splat(0.);
        for t in 0..k {
            // SAFETY: all four logical indices belong to the checked matrix ranges.
            unsafe {
                let a = decode(*left.add(left_index(row, t, m, k, flags)));
                let b = if flags & 2 != 0 {
                    f32x4(
                        decode(*right.add(column * k + t)),
                        decode(*right.add((column + 1) * k + t)),
                        decode(*right.add((column + 2) * k + t)),
                        decode(*right.add((column + 3) * k + t)),
                    )
                } else {
                    decode_four(v128_load64_zero(right.add(t * n + column).cast()))
                };
                accumulator = f32x4_add(accumulator, f32x4_mul(f32x4_splat(a), b));
            }
        }
        // SAFETY: the distinct output range contains this entire block.
        unsafe {
            let target = output.add(row * n + column);
            target.write(encode(f32x4_extract_lane::<0>(accumulator)));
            target
                .add(1)
                .write(encode(f32x4_extract_lane::<1>(accumulator)));
            target
                .add(2)
                .write(encode(f32x4_extract_lane::<2>(accumulator)));
            target
                .add(3)
                .write(encode(f32x4_extract_lane::<3>(accumulator)));
        }
    }
    end
}

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_matmul_f16(
    left_offset: u32,
    right_offset: u32,
    output_offset: u32,
    m: u32,
    k: u32,
    n: u32,
    flags: u32,
) -> u32 {
    let status = validate_matrix_ranges(
        [left_offset, right_offset, output_offset],
        [m, k, n],
        flags,
        HALF_WIDTH,
    );
    if status != STATUS_OK || m == 0 || n == 0 {
        return status;
    }
    let left = left_offset as *const u16;
    let right = right_offset as *const u16;
    let output = output_offset as *mut u16;
    let (m, k, n) = (m as usize, k as usize, n as usize);
    for row in 0..m {
        #[cfg(target_feature = "simd128")]
        let start = unsafe { vector_columns(left, right, output, [m, k, n], flags, row) };
        #[cfg(not(target_feature = "simd128"))]
        let start = 0;
        for column in start..n {
            let mut accumulator = 0.0_f32;
            // Finite binary16 products are exact normal binary32 numbers or zero.
            // Thus only addition rounds at each contraction step.
            for t in 0..k {
                // SAFETY: validated nonempty input ranges cover the indexed terms.
                unsafe {
                    let a = decode(*left.add(left_index(row, t, m, k, flags)));
                    let b = decode(*right.add(right_index(column, t, k, n, flags)));
                    accumulator += a * b;
                }
            }
            // SAFETY: each output index is in the validated distinct MN range.
            unsafe {
                output.add(row * n + column).write(encode(accumulator));
            }
        }
    }
    STATUS_OK
}

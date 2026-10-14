use crate::abi::{STATUS_OK, validate_binary_ranges};
use crate::fused_multiply_add::fused_multiply_add;

#[cfg(target_feature = "simd128")]
unsafe fn vector_add_alpha(
    parameter: *const f32,
    gradient: *const f32,
    output: *mut f32,
    alpha: f32,
    length: usize,
) -> usize {
    use crate::fused_multiply_add::{compensated_product_add, midpoint_correct};
    use core::arch::wasm32::*;
    let end = length - length % 4;
    // The coefficient is uniform across the complete update. Keep conversion
    // outside the loop; matrix products instead have independent lane factors.
    let coefficient = f64x2_splat(f64::from(alpha));
    for index in (0..end).step_by(4) {
        // SAFETY: the entry validated complete blocks and disjoint output.
        let parameters = unsafe { v128_load(parameter.add(index).cast()) };
        let gradients = unsafe { v128_load(gradient.add(index).cast()) };
        for half in 0..2 {
            let p = if half == 0 {
                parameters
            } else {
                i32x4_shuffle::<2, 3, 2, 3>(parameters, parameters)
            };
            let g = if half == 0 {
                gradients
            } else {
                i32x4_shuffle::<2, 3, 2, 3>(gradients, gradients)
            };
            let (high, low) = compensated_product_add(
                f64x2_promote_low_f32x4(p),
                f64x2_promote_low_f32x4(g),
                coefficient,
            );
            let highs = [f64x2_extract_lane::<0>(high), f64x2_extract_lane::<1>(high)];
            let lows = [f64x2_extract_lane::<0>(low), f64x2_extract_lane::<1>(low)];
            for lane in 0..2 {
                let offset = index + half * 2 + lane;
                // SAFETY: each lane belongs to the validated complete block.
                unsafe {
                    let p = *parameter.add(offset);
                    let g = *gradient.add(offset);
                    *output.add(offset) = if !p.is_finite() || !g.is_finite() || !alpha.is_finite()
                    {
                        fused_multiply_add(p, g, alpha)
                    } else {
                        midpoint_correct(highs[lane], lows[lane])
                    };
                }
            }
        }
    }
    end
}

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_add_alpha_f32(
    parameter_offset: u32,
    gradient_offset: u32,
    output_offset: u32,
    length: u32,
    alpha_bits: u32,
) -> u32 {
    let status = validate_binary_ranges(parameter_offset, gradient_offset, output_offset, length);
    if status != STATUS_OK {
        return status;
    }
    let parameter = parameter_offset as *const f32;
    let gradient = gradient_offset as *const f32;
    let output = output_offset as *mut f32;
    let alpha = f32::from_bits(alpha_bits);
    let start = {
        #[cfg(target_feature = "simd128")]
        {
            unsafe { vector_add_alpha(parameter, gradient, output, alpha, length as usize) }
        }
        #[cfg(not(target_feature = "simd128"))]
        {
            0
        }
    };
    for index in start..length as usize {
        // SAFETY: all pointers cover the validated ranges, including scalar tails.
        unsafe {
            *output.add(index) =
                fused_multiply_add(*parameter.add(index), *gradient.add(index), alpha);
        }
    }
    STATUS_OK
}

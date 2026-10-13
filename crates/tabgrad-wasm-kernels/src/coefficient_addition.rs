use crate::abi::{STATUS_OK, validate_binary_ranges};
use crate::fused_multiply_add::fused_multiply_add;

#[cfg(target_feature = "simd128")]
unsafe fn vector_add_alpha(parameter: *const f32, gradient: *const f32, output: *mut f32, alpha: f32, length: usize) -> usize {
    use core::arch::wasm32::*;
    use crate::fused_multiply_add::fused_multiply_add_four;
    let end = length - length % 4;
    for index in (0..end).step_by(4) {
        // SAFETY: the entry validated a complete four-element block and disjoint output.
        unsafe {
            let result = fused_multiply_add_four(v128_load(parameter.add(index).cast()),
                v128_load(gradient.add(index).cast()), f32x4_splat(alpha));
            v128_store(output.add(index).cast(), result);
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
            *output.add(index) = fused_multiply_add(*parameter.add(index), *gradient.add(index), alpha);
        }
    }
    STATUS_OK
}

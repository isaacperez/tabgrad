use crate::abi::{STATUS_OK, validate_binary_ranges};

fn next_up(bits: u32) -> f32 {
    f32::from_bits(if bits & 0x7fff_ffff == 0 {
        1
    } else if bits >> 31 != 0 {
        bits - 1
    } else {
        bits + 1
    })
}

fn next_down(bits: u32) -> f32 {
    f32::from_bits(if bits & 0x7fff_ffff == 0 {
        0x8000_0001
    } else if bits >> 31 != 0 {
        bits + 1
    } else {
        bits - 1
    })
}

// Every finite binary32 product is exact in binary64. TwoSum recovers the
// residual of its addition. That residual only changes the binary32 rounding
// when the high part is exactly a midpoint; its sign then selects the neighbor.
fn midpoint_correct(high: f64, low: f64) -> f32 {
    const OVERFLOW_TIE: f64 = 340282356779733661637539395458142568448.;
    if high == OVERFLOW_TIE && low < 0. {
        return f32::MAX;
    }
    if high == -OVERFLOW_TIE && low > 0. {
        return -f32::MAX;
    }
    let candidate = high as f32;
    if low == 0. || !candidate.is_finite() {
        return candidate;
    }
    let neighbor = if low > 0. {
        next_up(candidate.to_bits())
    } else {
        next_down(candidate.to_bits())
    };
    if neighbor.is_finite() && high == (f64::from(candidate) + f64::from(neighbor)) * 0.5 {
        neighbor
    } else {
        candidate
    }
}

fn add_alpha(parameter: f32, gradient: f32, alpha: f32) -> f32 {
    let product = f64::from(gradient) * f64::from(alpha);
    let addend = f64::from(parameter);
    let high = product + addend;
    // Keep finite products widened even with an infinite addend. Rounding the
    // product first would incorrectly turn an opposite infinite addend into NaN.
    if !parameter.is_finite() || !gradient.is_finite() || !alpha.is_finite() {
        return high as f32;
    }
    let z = high - product;
    let low = (product - (high - z)) + (addend - z);
    midpoint_correct(high, low)
}

#[cfg(target_feature = "simd128")]
unsafe fn vector_add_alpha(
    parameter: *const f32,
    gradient: *const f32,
    output: *mut f32,
    alpha: f32,
    length: usize,
) -> usize {
    use core::arch::wasm32::*;
    let end = length - length % 4;
    let coefficient = f64x2_splat(f64::from(alpha));
    for index in (0..end).step_by(4) {
        // SAFETY: the exported entry validated all ranges and output disjointness.
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
            let addend = f64x2_promote_low_f32x4(p);
            let product = f64x2_mul(f64x2_promote_low_f32x4(g), coefficient);
            let high = f64x2_add(product, addend);
            let z = f64x2_sub(high, product);
            let low = f64x2_add(f64x2_sub(product, f64x2_sub(high, z)), f64x2_sub(addend, z));
            let highs = [f64x2_extract_lane::<0>(high), f64x2_extract_lane::<1>(high)];
            let lows = [f64x2_extract_lane::<0>(low), f64x2_extract_lane::<1>(low)];
            for lane in 0..2 {
                let offset = index + half * 2 + lane;
                // SAFETY: offset belongs to a validated complete four-element block.
                let p = unsafe { *parameter.add(offset) };
                let g = unsafe { *gradient.add(offset) };
                let result = if !p.is_finite() || !g.is_finite() || !alpha.is_finite() {
                    add_alpha(p, g, alpha)
                } else {
                    midpoint_correct(highs[lane], lows[lane])
                };
                unsafe { *output.add(offset) = result };
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
            *output.add(index) = add_alpha(*parameter.add(index), *gradient.add(index), alpha);
        }
    }
    STATUS_OK
}

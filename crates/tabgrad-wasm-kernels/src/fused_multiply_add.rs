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
pub(crate) fn midpoint_correct(high: f64, low: f64) -> f32 {
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

pub(crate) fn fused_multiply_add(parameter: f32, gradient: f32, alpha: f32) -> f32 {
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
#[inline]
pub(crate) fn compensated_product_add(
    addend: core::arch::wasm32::v128,
    left: core::arch::wasm32::v128,
    right: core::arch::wasm32::v128,
) -> (core::arch::wasm32::v128, core::arch::wasm32::v128) {
    use core::arch::wasm32::*;
    let product = f64x2_mul(left, right);
    let high = f64x2_add(product, addend);
    let z = f64x2_sub(high, product);
    let low = f64x2_add(f64x2_sub(product, f64x2_sub(high, z)), f64x2_sub(addend, z));
    (high, low)
}

#[cfg(target_feature = "simd128")]
pub(crate) fn fused_multiply_add_four(
    addends: core::arch::wasm32::v128,
    left: core::arch::wasm32::v128,
    right: core::arch::wasm32::v128,
) -> core::arch::wasm32::v128 {
    use core::arch::wasm32::*;
    let parameters = [
        f32x4_extract_lane::<0>(addends),
        f32x4_extract_lane::<1>(addends),
        f32x4_extract_lane::<2>(addends),
        f32x4_extract_lane::<3>(addends),
    ];
    let gradients = [
        f32x4_extract_lane::<0>(left),
        f32x4_extract_lane::<1>(left),
        f32x4_extract_lane::<2>(left),
        f32x4_extract_lane::<3>(left),
    ];
    let coefficients = [
        f32x4_extract_lane::<0>(right),
        f32x4_extract_lane::<1>(right),
        f32x4_extract_lane::<2>(right),
        f32x4_extract_lane::<3>(right),
    ];
    let mut results = [0.; 4];
    for half in 0..2 {
        let p = if half == 0 {
            addends
        } else {
            i32x4_shuffle::<2, 3, 2, 3>(addends, addends)
        };
        let g = if half == 0 {
            left
        } else {
            i32x4_shuffle::<2, 3, 2, 3>(left, left)
        };
        let a = if half == 0 {
            right
        } else {
            i32x4_shuffle::<2, 3, 2, 3>(right, right)
        };
        let addend = f64x2_promote_low_f32x4(p);
        let (high, low) = compensated_product_add(
            addend,
            f64x2_promote_low_f32x4(g),
            f64x2_promote_low_f32x4(a),
        );
        let highs = [f64x2_extract_lane::<0>(high), f64x2_extract_lane::<1>(high)];
        let lows = [f64x2_extract_lane::<0>(low), f64x2_extract_lane::<1>(low)];
        for lane in 0..2 {
            let index = half * 2 + lane;
            results[index] = if !parameters[index].is_finite()
                || !gradients[index].is_finite()
                || !coefficients[index].is_finite()
            {
                fused_multiply_add(parameters[index], gradients[index], coefficients[index])
            } else {
                midpoint_correct(highs[lane], lows[lane])
            };
        }
    }
    f32x4(results[0], results[1], results[2], results[3])
}

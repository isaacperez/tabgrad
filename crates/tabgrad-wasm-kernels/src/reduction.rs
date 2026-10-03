use crate::abi::{
    FLOAT_ALIGNMENT, STATUS_OK, STATUS_OUT_OF_BOUNDS, STATUS_OUTPUT_OVERLAP, STATUS_UNALIGNED,
    checked_range, overlaps,
};

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_sum_f32(input_offset: u32, output_offset: u32, length: u32) -> u32 {
    if !input_offset.is_multiple_of(FLOAT_ALIGNMENT)
        || !output_offset.is_multiple_of(FLOAT_ALIGNMENT)
    {
        return STATUS_UNALIGNED;
    }
    let memory_bytes = (core::arch::wasm32::memory_size(0) as u64) * 65_536;
    let Some(input_range) = checked_range(input_offset, length, memory_bytes) else {
        return STATUS_OUT_OF_BOUNDS;
    };
    let Some(output_range) = checked_range(output_offset, 1, memory_bytes) else {
        return STATUS_OUT_OF_BOUNDS;
    };
    if length != 0 && overlaps(output_range, input_range) {
        return STATUS_OUTPUT_OVERLAP;
    }
    // SAFETY: the input range and distinct scalar output are aligned and valid.
    // A zero-length input is never dereferenced, including one at memory's end.
    unsafe {
        (output_offset as *mut f32).write(sum_f32(input_offset as *const f32, length as usize));
    }
    STATUS_OK
}

// Each leaf has at most 32 additions per lane. Balanced subdivision bounds
// rounding depth and stack use independently of the tensor payload: at most
// 26 subdivision frames for a u32 length, and no temporary tensor allocation.
const SUM_LEAF_ELEMENTS: usize = 128;

unsafe fn sum_f32(input: *const f32, length: usize) -> f32 {
    if length > SUM_LEAF_ELEMENTS {
        let middle = (length / 2) & !3;
        // SAFETY: both subranges partition the caller's validated input range.
        return unsafe { sum_f32(input, middle) + sum_f32(input.add(middle), length - middle) };
    }
    // SAFETY: the caller established a valid input range.
    unsafe { sum_leaf_f32(input, length) }
}

#[cfg(not(target_feature = "simd128"))]
unsafe fn sum_leaf_f32(input: *const f32, length: usize) -> f32 {
    let mut lanes = [0.0_f32; 4];
    let vector_end = length - length % 4;
    let mut index = 0;
    while index < vector_end {
        for (lane, accumulator) in lanes.iter_mut().enumerate() {
            // SAFETY: the caller established a valid range and index + lane < length.
            *accumulator += unsafe { input.add(index + lane).read() };
        }
        index += 4;
    }
    let mut result = (lanes[0] + lanes[1]) + (lanes[2] + lanes[3]);
    while index < length {
        // SAFETY: index remains inside the caller's validated range.
        result += unsafe { input.add(index).read() };
        index += 1;
    }
    result
}

#[cfg(target_feature = "simd128")]
unsafe fn sum_leaf_f32(input: *const f32, length: usize) -> f32 {
    use core::arch::wasm32::{f32x4_add, f32x4_extract_lane, f32x4_splat, v128, v128_load};

    let mut lanes = f32x4_splat(0.0);
    let vector_end = length - length % 4;
    let mut index = 0;
    while index < vector_end {
        // SAFETY: four complete elements remain; v128_load permits unaligned vectors.
        lanes = f32x4_add(lanes, unsafe { v128_load(input.add(index).cast::<v128>()) });
        index += 4;
    }
    let mut result = (f32x4_extract_lane::<0>(lanes) + f32x4_extract_lane::<1>(lanes))
        + (f32x4_extract_lane::<2>(lanes) + f32x4_extract_lane::<3>(lanes));
    while index < length {
        // SAFETY: index remains inside the caller's validated range.
        result += unsafe { input.add(index).read() };
        index += 1;
    }
    result
}

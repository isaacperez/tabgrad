use crate::abi::{
    FLOAT_ALIGNMENT, STATUS_OK, STATUS_OUT_OF_BOUNDS, STATUS_OUTPUT_OVERLAP, STATUS_UNALIGNED,
    checked_range, overlaps,
};

/// Expand one stored float32 value into a disjoint contiguous output range.
#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_expand_f32(input_offset: u32, output_offset: u32, length: u32) -> u32 {
    if !input_offset.is_multiple_of(FLOAT_ALIGNMENT)
        || !output_offset.is_multiple_of(FLOAT_ALIGNMENT)
    {
        return STATUS_UNALIGNED;
    }
    let memory_bytes = (core::arch::wasm32::memory_size(0) as u64) * 65_536;
    let Some(input_range) = checked_range(input_offset, 1, memory_bytes) else {
        return STATUS_OUT_OF_BOUNDS;
    };
    let Some(output_range) = checked_range(output_offset, length, memory_bytes) else {
        return STATUS_OUT_OF_BOUNDS;
    };
    if length != 0 && overlaps(input_range, output_range) {
        return STATUS_OUTPUT_OVERLAP;
    }
    // SAFETY: the scalar and complete output are aligned, in bounds and disjoint.
    // The empty output is legal, including at the end of linear memory.
    unsafe {
        expand_f32(
            (input_offset as *const f32).read(),
            output_offset as *mut f32,
            length as usize,
        );
    }
    STATUS_OK
}

#[cfg(not(target_feature = "simd128"))]
unsafe fn expand_f32(value: f32, output: *mut f32, length: usize) {
    for index in 0..length {
        // SAFETY: the caller checked the complete output range.
        unsafe { output.add(index).write(value) };
    }
}

#[cfg(target_feature = "simd128")]
unsafe fn expand_f32(value: f32, output: *mut f32, length: usize) {
    use core::arch::wasm32::{f32x4_splat, v128, v128_store};
    let vector = f32x4_splat(value);
    let mut index = 0;
    while index + 4 <= length {
        // SAFETY: four floats remain in the checked output; v128_store permits unaligned vectors.
        unsafe { v128_store(output.add(index).cast::<v128>(), vector) };
        index += 4;
    }
    while index < length {
        // SAFETY: the scalar tail remains in the checked output.
        unsafe { output.add(index).write(value) };
        index += 1;
    }
}

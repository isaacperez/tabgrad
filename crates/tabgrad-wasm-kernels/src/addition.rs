use crate::abi::{STATUS_OK, validate_binary_ranges};

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_add_f32(
    left_offset: u32,
    right_offset: u32,
    output_offset: u32,
    length: u32,
) -> u32 {
    let status = validate_binary_ranges(left_offset, right_offset, output_offset, length);
    if status != STATUS_OK {
        return status;
    }

    // SAFETY: all three ranges were checked against linear memory above, each
    // address is aligned for f32, and the output does not overlap either input.
    unsafe {
        add_f32(
            left_offset as *const f32,
            right_offset as *const f32,
            output_offset as *mut f32,
            length as usize,
        );
    }
    STATUS_OK
}

#[cfg(not(target_feature = "simd128"))]
unsafe fn add_f32(left: *const f32, right: *const f32, output: *mut f32, length: usize) {
    for index in 0..length {
        // SAFETY: the caller established valid non-overlapping ranges.
        unsafe {
            output
                .add(index)
                .write(left.add(index).read() + right.add(index).read());
        }
    }
}

#[cfg(target_feature = "simd128")]
unsafe fn add_f32(left: *const f32, right: *const f32, output: *mut f32, length: usize) {
    use core::arch::wasm32::{f32x4_add, v128, v128_load, v128_store};

    let vector_end = length - (length % 4);
    let mut index = 0;
    while index < vector_end {
        // SAFETY: the caller established valid ranges. WebAssembly vector loads
        // and stores permit addresses that are not aligned to 16 bytes.
        unsafe {
            let left_vector = v128_load(left.add(index).cast::<v128>());
            let right_vector = v128_load(right.add(index).cast::<v128>());
            v128_store(
                output.add(index).cast::<v128>(),
                f32x4_add(left_vector, right_vector),
            );
        }
        index += 4;
    }
    while index < length {
        // SAFETY: the caller established valid non-overlapping ranges.
        unsafe {
            output
                .add(index)
                .write(left.add(index).read() + right.add(index).read());
        }
        index += 1;
    }
}

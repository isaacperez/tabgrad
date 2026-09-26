#![no_std]

use core::panic::PanicInfo;

const STATUS_OK: u32 = 0;
const STATUS_UNALIGNED: u32 = 1;
const STATUS_OUT_OF_BOUNDS: u32 = 2;
const STATUS_OUTPUT_OVERLAP: u32 = 3;
const ABI_VERSION: u32 = 1;
const CAPABILITY_ADD_F32: u32 = 1;
const CAPABILITY_SUM_F32: u32 = 2;
const CAPABILITY_MUL_F32: u32 = 4;
const FLOAT_ALIGNMENT: u32 = align_of::<f32>() as u32;

unsafe extern "C" {
    static __heap_base: u8;
}

fn arena_base() -> u32 {
    // SAFETY: the linker provides `__heap_base` as an address-valued symbol.
    (&raw const __heap_base).addr() as u32
}

#[panic_handler]
fn panic(_information: &PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

fn checked_range(offset: u32, length: u32, memory_bytes: u64) -> Option<(u64, u64)> {
    if !offset.is_multiple_of(FLOAT_ALIGNMENT) {
        return None;
    }
    let start = u64::from(offset);
    let size = u64::from(length).checked_mul(size_of::<f32>() as u64)?;
    let end = start.checked_add(size)?;
    (start >= u64::from(arena_base()) && end <= memory_bytes).then_some((start, end))
}

fn overlaps(left: (u64, u64), right: (u64, u64)) -> bool {
    left.0 < right.1 && right.0 < left.1
}

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_capabilities() -> u32 {
    CAPABILITY_ADD_F32 | CAPABILITY_SUM_F32 | CAPABILITY_MUL_F32
}

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_arena_base() -> u32 {
    arena_base()
}

fn validate_binary_ranges(
    left_offset: u32,
    right_offset: u32,
    output_offset: u32,
    length: u32,
) -> u32 {
    if !left_offset.is_multiple_of(FLOAT_ALIGNMENT)
        || !right_offset.is_multiple_of(FLOAT_ALIGNMENT)
        || !output_offset.is_multiple_of(FLOAT_ALIGNMENT)
    {
        return STATUS_UNALIGNED;
    }

    let memory_bytes = (core::arch::wasm32::memory_size(0) as u64) * 65_536;
    let Some(left_range) = checked_range(left_offset, length, memory_bytes) else {
        return STATUS_OUT_OF_BOUNDS;
    };
    let Some(right_range) = checked_range(right_offset, length, memory_bytes) else {
        return STATUS_OUT_OF_BOUNDS;
    };
    let Some(output_range) = checked_range(output_offset, length, memory_bytes) else {
        return STATUS_OUT_OF_BOUNDS;
    };
    if overlaps(output_range, left_range) || overlaps(output_range, right_range) {
        return STATUS_OUTPUT_OVERLAP;
    }
    STATUS_OK
}

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

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_mul_f32(
    left_offset: u32,
    right_offset: u32,
    output_offset: u32,
    length: u32,
) -> u32 {
    let status = validate_binary_ranges(left_offset, right_offset, output_offset, length);
    if status != STATUS_OK {
        return status;
    }
    // SAFETY: validation establishes aligned readable inputs and a writable
    // disjoint output. Repeated and overlapping inputs remain read-only.
    unsafe {
        mul_f32(
            left_offset as *const f32,
            right_offset as *const f32,
            output_offset as *mut f32,
            length as usize,
        );
    }
    STATUS_OK
}

#[cfg(not(target_feature = "simd128"))]
unsafe fn mul_f32(left: *const f32, right: *const f32, output: *mut f32, length: usize) {
    for index in 0..length {
        // SAFETY: the caller established valid ranges with a disjoint output.
        unsafe {
            output
                .add(index)
                .write(left.add(index).read() * right.add(index).read());
        }
    }
}

#[cfg(target_feature = "simd128")]
unsafe fn mul_f32(left: *const f32, right: *const f32, output: *mut f32, length: usize) {
    use core::arch::wasm32::{f32x4_mul, v128, v128_load, v128_store};

    let vector_end = length - length % 4;
    let mut index = 0;
    while index < vector_end {
        // SAFETY: four elements remain in validated ranges; vector accesses
        // permit addresses that are not aligned to 16 bytes.
        unsafe {
            v128_store(
                output.add(index).cast::<v128>(),
                f32x4_mul(
                    v128_load(left.add(index).cast::<v128>()),
                    v128_load(right.add(index).cast::<v128>()),
                ),
            );
        }
        index += 4;
    }
    while index < length {
        // SAFETY: index remains within the caller's validated ranges.
        unsafe {
            output
                .add(index)
                .write(left.add(index).read() * right.add(index).read());
        }
        index += 1;
    }
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

#![no_std]

use core::panic::PanicInfo;

const STATUS_OK: u32 = 0;
const STATUS_UNALIGNED: u32 = 1;
const STATUS_OUT_OF_BOUNDS: u32 = 2;
const STATUS_OUTPUT_OVERLAP: u32 = 3;
const ABI_VERSION: u32 = 1;
const CAPABILITY_ADD_F32: u32 = 1;
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
    CAPABILITY_ADD_F32
}

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_arena_base() -> u32 {
    arena_base()
}

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_add_f32(
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

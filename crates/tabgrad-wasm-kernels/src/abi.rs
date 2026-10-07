pub(crate) const STATUS_OK: u32 = 0;
pub(crate) const STATUS_UNALIGNED: u32 = 1;
pub(crate) const STATUS_OUT_OF_BOUNDS: u32 = 2;
pub(crate) const STATUS_OUTPUT_OVERLAP: u32 = 3;
const ABI_VERSION: u32 = 1;
const CAPABILITY_ADD_F32: u32 = 1;
const CAPABILITY_SUM_F32: u32 = 2;
const CAPABILITY_MUL_F32: u32 = 4;
const CAPABILITY_EXPAND_F32: u32 = 8;
const CAPABILITY_ADD_ALPHA_F32: u32 = 16;
pub(crate) const FLOAT_ALIGNMENT: u32 = align_of::<f32>() as u32;

unsafe extern "C" {
    static __heap_base: u8;
}

fn arena_base() -> u32 {
    // SAFETY: the linker provides `__heap_base` as an address-valued symbol.
    (&raw const __heap_base).addr() as u32
}

pub(crate) fn checked_range(offset: u32, length: u32, memory_bytes: u64) -> Option<(u64, u64)> {
    if !offset.is_multiple_of(FLOAT_ALIGNMENT) {
        return None;
    }
    let start = u64::from(offset);
    let size = u64::from(length).checked_mul(size_of::<f32>() as u64)?;
    let end = start.checked_add(size)?;
    (start >= u64::from(arena_base()) && end <= memory_bytes).then_some((start, end))
}

pub(crate) fn overlaps(left: (u64, u64), right: (u64, u64)) -> bool {
    left.0 < right.1 && right.0 < left.1
}

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_capabilities() -> u32 {
    CAPABILITY_ADD_F32
        | CAPABILITY_SUM_F32
        | CAPABILITY_MUL_F32
        | CAPABILITY_EXPAND_F32
        | CAPABILITY_ADD_ALPHA_F32
}

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_arena_base() -> u32 {
    arena_base()
}

pub(crate) fn validate_binary_ranges(
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

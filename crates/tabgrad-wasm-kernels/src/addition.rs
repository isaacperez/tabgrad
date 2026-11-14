use crate::abi::{STATUS_OK, validate_binary_ranges};
use crate::pointwise::{Pointwise, broadcast, dense};

struct Addition;
impl Pointwise<2> for Addition {
    fn scalar([left, right]: [f32; 2]) -> f32 {
        left + right
    }
    #[cfg(target_feature = "simd128")]
    fn vector([left, right]: [core::arch::wasm32::v128; 2]) -> core::arch::wasm32::v128 {
        core::arch::wasm32::f32x4_add(left, right)
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_add_f32(left: u32, right: u32, output: u32, length: u32) -> u32 {
    let status = validate_binary_ranges(left, right, output, length);
    if status != STATUS_OK {
        return status;
    }
    // SAFETY: dense ranges are aligned, readable and disjoint from output.
    unsafe {
        dense::<Addition>(
            left as *const f32,
            right as *const f32,
            output as *mut f32,
            length as usize,
        );
    }
    STATUS_OK
}

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_broadcast_add_f32(
    left: u32,
    right: u32,
    output: u32,
    packet: u32,
    words: u32,
) -> u32 {
    // SAFETY: the common raw boundary validates the packet before any read.
    unsafe { broadcast::<Addition, 2>([left, right], output, packet, words) }
}

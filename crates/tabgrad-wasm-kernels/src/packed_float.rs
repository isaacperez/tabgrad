#[cfg(target_feature = "simd128")]
use core::arch::wasm32::{u32x4_extend_low_u16x8, u32x4_shl, v128};

pub(crate) trait PackedFloat {
    fn decode(bits: u16) -> f32;
    fn encode(value: f32) -> u16;

    #[cfg(target_feature = "simd128")]
    fn decode_four(low_words: v128) -> v128;
}

pub(crate) struct Binary16;

impl PackedFloat for Binary16 {
    fn decode(bits: u16) -> f32 {
        crate::binary16::decode(bits)
    }

    fn encode(value: f32) -> u16 {
        crate::binary16::encode(value)
    }

    #[cfg(target_feature = "simd128")]
    fn decode_four(low_words: v128) -> v128 {
        crate::binary16::decode_four(low_words)
    }
}

pub(crate) struct Bfloat16;

impl PackedFloat for Bfloat16 {
    fn decode(bits: u16) -> f32 {
        f32::from_bits(u32::from(bits) << 16)
    }

    fn encode(value: f32) -> u16 {
        let bits = value.to_bits();
        if bits & 0x7fff_ffff > 0x7f80_0000 {
            return 0x7fc0;
        }
        let upper = (bits >> 16) as u16;
        let lower = bits & 0xffff;
        upper + u16::from(lower > 0x8000 || (lower == 0x8000 && upper & 1 != 0))
    }

    #[cfg(target_feature = "simd128")]
    fn decode_four(low_words: v128) -> v128 {
        u32x4_shl(u32x4_extend_low_u16x8(low_words), 16)
    }
}

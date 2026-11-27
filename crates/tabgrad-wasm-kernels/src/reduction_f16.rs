use crate::abi::{STATUS_OK, validate_reduction_ranges};

const HALF_WIDTH: u32 = size_of::<u16>() as u32;
const POSITIVE_INFINITY: u16 = 0x7c00;
const NEGATIVE_INFINITY: u16 = 0xfc00;
const NAN: u16 = 0x7e00;
const SIGN: u16 = 0x8000;
const FRACTION: u16 = 0x03ff;

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_sum_f16(input_offset: u32, output_offset: u32, length: u32) -> u32 {
    let status = validate_reduction_ranges(input_offset, output_offset, length, HALF_WIDTH);
    if status != STATUS_OK {
        return status;
    }
    // SAFETY: both ranges are aligned and in the arena, and the output is distinct.
    // An empty input can end exactly at the memory boundary without a read.
    unsafe {
        let input = core::slice::from_raw_parts(input_offset as *const u16, length as usize);
        (output_offset as *mut u16).write(sum(input));
    }
    STATUS_OK
}

fn sum(input: &[u16]) -> u16 {
    let mut total = 0_i128;
    let mut infinities = 0_u8;
    // Every finite term has fewer than 40 magnitude bits in units of 2^-24.
    // Use i64 for the hot loop and combine bounded blocks in i128.
    for block in input.chunks(1 << 22) {
        let mut partial = 0_i64;
        for &bits in block {
            let magnitude = bits & !SIGN;
            if magnitude >= POSITIVE_INFINITY {
                if magnitude != POSITIVE_INFINITY {
                    return NAN;
                }
                infinities |= if bits & SIGN == 0 { 1 } else { 2 };
                continue;
            }
            let exponent = magnitude >> 10;
            let fraction = i64::from(magnitude & FRACTION);
            let units = if exponent == 0 {
                fraction
            } else {
                (1024 + fraction) << (exponent - 1)
            };
            partial += if bits & SIGN == 0 { units } else { -units };
        }
        total += i128::from(partial);
    }
    match infinities {
        0 => round_to_binary16(total),
        1 => POSITIVE_INFINITY,
        2 => NEGATIVE_INFINITY,
        _ => NAN,
    }
}

fn round_to_binary16(units: i128) -> u16 {
    let sign = if units < 0 { SIGN } else { 0 };
    let magnitude = units.unsigned_abs();
    // Midpoint between the maximum finite value and the next power of two.
    if magnitude >= 65520_u128 << 24 {
        return sign | POSITIVE_INFINITY;
    }
    let magnitude = magnitude as u64;
    if magnitude < 1024 {
        return sign | magnitude as u16;
    }
    let shift = magnitude.ilog2() - 10;
    let mut significand = magnitude >> shift;
    if shift != 0 {
        let remainder = magnitude & ((1 << shift) - 1);
        let midpoint = 1 << (shift - 1);
        significand +=
            u64::from(remainder > midpoint || (remainder == midpoint && significand & 1 != 0));
    }
    // Adding the implicit leading bit advances the exponent on a rounding carry.
    sign | (((shift << 10) + significand as u32) as u16)
}

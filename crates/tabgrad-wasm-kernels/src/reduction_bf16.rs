use crate::abi::{STATUS_OK, validate_reduction_ranges};
use core::cmp::Ordering;

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_sum_bf16(input_offset: u32, output_offset: u32, length: u32) -> u32 {
    let status =
        validate_reduction_ranges(input_offset, output_offset, length, size_of::<u16>() as u32);
    if status != STATUS_OK {
        return status;
    }
    // SAFETY: the aligned, disjoint ranges were admitted above. An empty
    // input may start at the end of memory and must not read any element.
    unsafe {
        let input = core::slice::from_raw_parts(input_offset as *const u16, length as usize);
        (output_offset as *mut u16).write(sum(input));
    }
    STATUS_OK
}

// In units of 2^-133, each finite value needs at most 261 bits.
// Even a full u32 count of maximum values fits in five limbs.
const WORDS: usize = 5;
const SIGN: u16 = 0x8000;
const INFINITY: u16 = 0x7f80;
const NAN: u16 = 0x7fc0;
type Wide = [u64; WORDS];

fn add_bin(destination: &mut Wide, value: u64, shift: usize) {
    let word = shift / 64;
    let offset = shift % 64;
    let term = u128::from(value) << offset;
    let low = u128::from(destination[word]) + u128::from(term as u64);
    destination[word] = low as u64;
    let mut carry = (low >> 64) + (term >> 64);
    for current in &mut destination[word + 1..] {
        if carry == 0 {
            break;
        }
        let updated = u128::from(*current) + carry;
        *current = updated as u64;
        carry = updated >> 64;
    }
}

fn round_wide(words: Wide, sign: u16) -> u16 {
    let Some(last) = words.iter().rposition(|value| *value != 0) else {
        return 0;
    };
    let highest = last * 64 + 63 - words[last].leading_zeros() as usize;
    // Keep eight significand bits. Subnormals are exact at the accumulator scale.
    let shift = highest.saturating_sub(7);
    let word = shift / 64;
    let offset = shift % 64;
    let mut top = words[word] >> offset;
    if offset != 0 && word + 1 < WORDS {
        top |= words[word + 1] << (64 - offset);
    }
    if shift != 0 {
        let guard_index = shift - 1;
        let guard_word = guard_index / 64;
        let guard_offset = guard_index % 64;
        let guard = (words[guard_word] >> guard_offset) & 1;
        let sticky = (words[guard_word] & ((1u64 << guard_offset) - 1)) != 0
            || words[..guard_word].iter().any(|value| *value != 0);
        top += u64::from(guard != 0 && (sticky || top & 1 != 0));
    }
    sign | (((shift as u64) << 7) + top).min(u64::from(INFINITY)) as u16
}

fn sum(values: &[u16]) -> u16 {
    // At most u32 terms of at most 8 significand bits enter each bin.
    // Combine equal-scale terms before carrying into the wide accumulator.
    let mut bins = [0_i64; 254];
    let mut infinities = 0;
    for &bits in values {
        let exponent = usize::from((bits >> 7) & 255);
        let fraction = i64::from(bits & 127);
        if exponent == 255 {
            if fraction != 0 {
                return NAN;
            }
            infinities |= if bits & SIGN == 0 { 1 } else { 2 };
        } else {
            let significand = if exponent == 0 {
                fraction
            } else {
                128 + fraction
            };
            bins[exponent.saturating_sub(1)] += if bits & SIGN == 0 {
                significand
            } else {
                -significand
            };
        }
    }
    if infinities != 0 {
        return match infinities {
            1 => INFINITY,
            2 => SIGN | INFINITY,
            _ => NAN,
        };
    }
    let (mut positive, mut negative) = ([0; WORDS], [0; WORDS]);
    for (shift, bin) in bins.into_iter().enumerate() {
        if bin == 0 {
            continue;
        }
        let destination = if bin > 0 {
            &mut positive
        } else {
            &mut negative
        };
        add_bin(destination, bin.unsigned_abs(), shift);
    }
    let (large, small, sign) = match positive.iter().rev().cmp(negative.iter().rev()) {
        Ordering::Equal => return 0,
        Ordering::Greater => (positive, negative, 0),
        Ordering::Less => (negative, positive, SIGN),
    };
    let mut magnitude = [0; WORDS];
    let mut borrow = false;
    for word in 0..WORDS {
        let (first, low) = large[word].overflowing_sub(small[word]);
        let (final_word, high) = first.overflowing_sub(u64::from(borrow));
        magnitude[word] = final_word;
        borrow = low || high;
    }
    round_wide(magnitude, sign)
}

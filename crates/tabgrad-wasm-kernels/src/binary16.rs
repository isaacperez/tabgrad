pub(crate) fn decode(bits: u16) -> f32 {
    let sign = u32::from(bits & 0x8000) << 16;
    let exponent = u32::from((bits >> 10) & 31);
    let fraction = u32::from(bits & 1023);
    let magnitude = if exponent == 31 {
        0x7f80_0000 | (fraction << 13)
    } else if exponent != 0 {
        ((exponent + 112) << 23) | (fraction << 13)
    } else if fraction == 0 {
        0
    } else {
        let shift = fraction.leading_zeros() - 21;
        ((113 - shift) << 23) | ((fraction << shift & 1023) << 13)
    };
    f32::from_bits(sign | magnitude)
}

fn rounded_shift(value: u32, distance: u32) -> u32 {
    if distance >= 32 {
        return 0;
    }
    let truncated = value >> distance;
    let remainder = value & ((1 << distance) - 1);
    let half = 1 << (distance - 1);
    truncated + u32::from(remainder > half || (remainder == half && truncated & 1 != 0))
}

pub(crate) fn encode(value: f32) -> u16 {
    let bits = value.to_bits();
    let sign = (bits >> 16) & 0x8000;
    let exponent = (bits >> 23) & 255;
    let fraction = bits & 0x7f_ffff;
    let magnitude = if exponent == 255 && fraction != 0 {
        0x7e00
    } else if exponent >= 143 {
        0x7c00
    } else if exponent < 113 {
        rounded_shift(fraction | 0x80_0000, 126 - exponent)
    } else {
        ((exponent - 112) << 10) + rounded_shift(fraction, 13)
    };
    (sign | magnitude) as u16
}

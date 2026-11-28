use crate::abi::FLOAT_ALIGNMENT;
use crate::pointwise::{Pointwise, broadcast, typed_dense};

struct Selection;

impl Pointwise<3> for Selection {
    const INPUT_WIDTHS: [u32; 3] = [1, FLOAT_ALIGNMENT, FLOAT_ALIGNMENT];
    const OUTPUT_WIDTH: u32 = FLOAT_ALIGNMENT;

    unsafe fn run(
        [mask, left, right]: [*const u8; 3],
        [mask_step, left_step, right_step]: [usize; 3],
        output: *mut u8,
        length: usize,
    ) {
        let (left, right, output) = (
            left.cast::<u32>(),
            right.cast::<u32>(),
            output.cast::<u32>(),
        );
        for index in 0..length {
            // SAFETY: the caller validates the typed inputs and disjoint output.
            unsafe {
                let value = if mask.add(index * mask_step).read() != 0 {
                    left.add(index * left_step).read()
                } else {
                    right.add(index * right_step).read()
                };
                output.add(index).write(value);
            }
        }
    }
}

struct MaskGradient<const WHEN_TRUE: bool>;

impl<const WHEN_TRUE: bool> Pointwise<2> for MaskGradient<WHEN_TRUE> {
    const INPUT_WIDTHS: [u32; 2] = [1, FLOAT_ALIGNMENT];
    const OUTPUT_WIDTH: u32 = FLOAT_ALIGNMENT;

    unsafe fn run(
        [mask, seed]: [*const u8; 2],
        [mask_step, seed_step]: [usize; 2],
        output: *mut u8,
        length: usize,
    ) {
        let (seed, output) = (seed.cast::<u32>(), output.cast::<u32>());
        for index in 0..length {
            // SAFETY: the caller validates the typed inputs and disjoint output.
            unsafe {
                let value = if (mask.add(index * mask_step).read() != 0) == WHEN_TRUE {
                    seed.add(index * seed_step).read()
                } else {
                    0
                };
                output.add(index).write(value);
            }
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_where_f32(
    mask: u32,
    left: u32,
    right: u32,
    output: u32,
    length: u32,
) -> u32 {
    typed_dense::<Selection, 3>([mask, left, right], output, length)
}

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_broadcast_where_f32(
    mask: u32,
    left: u32,
    right: u32,
    output: u32,
    packet: u32,
    words: u32,
) -> u32 {
    // SAFETY: the dispatcher validates all typed spans and the complete packet.
    unsafe { broadcast::<Selection, 3>([mask, left, right], output, packet, words) }
}

macro_rules! mask_gradient_exports {
    ($dense:ident, $projected:ident, $when_true:literal) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn $dense(mask: u32, seed: u32, output: u32, length: u32) -> u32 {
            typed_dense::<MaskGradient<$when_true>, 2>([mask, seed], output, length)
        }

        #[unsafe(no_mangle)]
        pub extern "C" fn $projected(
            mask: u32,
            seed: u32,
            output: u32,
            packet: u32,
            words: u32,
        ) -> u32 {
            // SAFETY: the dispatcher validates all typed spans and the complete packet.
            unsafe { broadcast::<MaskGradient<$when_true>, 2>([mask, seed], output, packet, words) }
        }
    };
}

mask_gradient_exports!(
    tabgrad_where_then_gradient_f32,
    tabgrad_broadcast_where_then_gradient_f32,
    true
);
mask_gradient_exports!(
    tabgrad_where_else_gradient_f32,
    tabgrad_broadcast_where_else_gradient_f32,
    false
);

use crate::abi::{FLOAT_ALIGNMENT, STATUS_OK, validate_binary_spans};
use crate::pointwise::{Pointwise, broadcast};

struct Greater;

impl Pointwise<2> for Greater {
    const INPUT_WIDTHS: [u32; 2] = [FLOAT_ALIGNMENT; 2];
    const OUTPUT_WIDTH: u32 = 1;

    unsafe fn run(inputs: [*const u8; 2], strides: [usize; 2], output: *mut u8, length: usize) {
        let [left, right] = inputs.map(|input| input.cast::<f32>());
        for index in 0..length {
            // SAFETY: the caller checks the complete inputs and disjoint output.
            unsafe {
                let left_value = left.add(index * strides[0]).read();
                let right_value = right.add(index * strides[1]).read();
                output.add(index).write(u8::from(left_value > right_value));
            }
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_gt_f32(left: u32, right: u32, output: u32, length: u32) -> u32 {
    let status = validate_binary_spans(left, right, output, length, FLOAT_ALIGNMENT, 1);
    if status != STATUS_OK {
        return status;
    }
    // SAFETY: the validated f32 inputs and byte output each cover length.
    unsafe {
        Greater::run(
            [left as *const u8, right as *const u8],
            [1, 1],
            output as *mut u8,
            length as usize,
        )
    }
    STATUS_OK
}

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_broadcast_gt_f32(
    left: u32,
    right: u32,
    output: u32,
    packet: u32,
    words: u32,
) -> u32 {
    // SAFETY: the dispatcher validates all typed spans and the complete packet.
    unsafe { broadcast::<Greater, 2>([left, right], output, packet, words) }
}

use crate::abi::{STATUS_OK, validate_typed_binary_ranges};
use crate::pointwise::{Pointwise, broadcast};

use crate::binary16::{decode, encode};

trait Arithmetic {
    fn calculate(left: f32, right: f32) -> f32;
}
struct Add;
struct Multiply;
impl Arithmetic for Add {
    fn calculate(left: f32, right: f32) -> f32 {
        left + right
    }
}
impl Arithmetic for Multiply {
    fn calculate(left: f32, right: f32) -> f32 {
        left * right
    }
}

struct Half<P>(core::marker::PhantomData<P>);
impl<P: Arithmetic> Pointwise<2> for Half<P> {
    type Element = u16;
    unsafe fn run(inputs: [*const u16; 2], strides: [usize; 2], output: *mut u16, length: usize) {
        for index in 0..length {
            // SAFETY: the common dense/broadcast boundary checked typed spans.
            let [left, right] = core::array::from_fn(|operand| unsafe {
                decode(inputs[operand].add(index * strides[operand]).read())
            });
            // Half products have <=22 significant bits. A half-add rounding
            // boundary has an exactly representable f32 sum; larger exponent
            // gaps cannot cross a half midpoint. Store once after each operation.
            unsafe {
                output.add(index).write(encode(P::calculate(left, right)));
            }
        }
    }
}

fn dense<P: Arithmetic>(left: u32, right: u32, output: u32, length: u32) -> u32 {
    let status = validate_typed_binary_ranges(left, right, output, length, 2);
    if status != STATUS_OK {
        return status;
    }
    // SAFETY: complete aligned, disjoint ranges were validated above.
    unsafe {
        Half::<P>::run(
            [left as *const u16, right as *const u16],
            [1, 1],
            output as *mut u16,
            length as usize,
        );
    }
    STATUS_OK
}

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_add_f16(left: u32, right: u32, output: u32, length: u32) -> u32 {
    dense::<Add>(left, right, output, length)
}
#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_mul_f16(left: u32, right: u32, output: u32, length: u32) -> u32 {
    dense::<Multiply>(left, right, output, length)
}
#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_broadcast_add_f16(
    left: u32,
    right: u32,
    output: u32,
    packet: u32,
    words: u32,
) -> u32 {
    // SAFETY: the shared traversal validates packet and typed spans before reads.
    unsafe { broadcast::<Half<Add>, 2>([left, right], output, packet, words) }
}
#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_broadcast_mul_f16(
    left: u32,
    right: u32,
    output: u32,
    packet: u32,
    words: u32,
) -> u32 {
    // SAFETY: the shared traversal validates packet and typed spans before reads.
    unsafe { broadcast::<Half<Multiply>, 2>([left, right], output, packet, words) }
}

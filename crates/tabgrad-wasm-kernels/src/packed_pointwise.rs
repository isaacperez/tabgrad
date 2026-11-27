use crate::abi::{STATUS_OK, validate_typed_binary_ranges};
use crate::pointwise::{Pointwise, broadcast};

use crate::packed_float::{Bfloat16, Binary16, PackedFloat};

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

struct Packed<F, P>(core::marker::PhantomData<(F, P)>);
impl<F: PackedFloat, P: Arithmetic> Pointwise<2> for Packed<F, P> {
    type Element = u16;
    unsafe fn run(inputs: [*const u16; 2], strides: [usize; 2], output: *mut u16, length: usize) {
        for index in 0..length {
            // SAFETY: the common dense/broadcast boundary checked typed spans.
            let [left, right] = core::array::from_fn(|operand| unsafe {
                F::decode(inputs[operand].add(index * strides[operand]).read())
            });
            unsafe {
                output
                    .add(index)
                    .write(F::encode(P::calculate(left, right)));
            }
        }
    }
}

fn dense<F: PackedFloat, P: Arithmetic>(left: u32, right: u32, output: u32, length: u32) -> u32 {
    let status = validate_typed_binary_ranges(left, right, output, length, 2);
    if status != STATUS_OK {
        return status;
    }
    // SAFETY: complete aligned, disjoint ranges were validated above.
    unsafe {
        Packed::<F, P>::run(
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
    dense::<Binary16, Add>(left, right, output, length)
}
#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_mul_f16(left: u32, right: u32, output: u32, length: u32) -> u32 {
    dense::<Binary16, Multiply>(left, right, output, length)
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
    unsafe { broadcast::<Packed<Binary16, Add>, 2>([left, right], output, packet, words) }
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
    unsafe { broadcast::<Packed<Binary16, Multiply>, 2>([left, right], output, packet, words) }
}

#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_add_bf16(left: u32, right: u32, output: u32, length: u32) -> u32 {
    dense::<Bfloat16, Add>(left, right, output, length)
}
#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_mul_bf16(left: u32, right: u32, output: u32, length: u32) -> u32 {
    dense::<Bfloat16, Multiply>(left, right, output, length)
}
#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_broadcast_add_bf16(
    left: u32,
    right: u32,
    output: u32,
    packet: u32,
    words: u32,
) -> u32 {
    // SAFETY: the shared traversal validates packet and typed spans before reads.
    unsafe { broadcast::<Packed<Bfloat16, Add>, 2>([left, right], output, packet, words) }
}
#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_broadcast_mul_bf16(
    left: u32,
    right: u32,
    output: u32,
    packet: u32,
    words: u32,
) -> u32 {
    // SAFETY: the shared traversal validates packet and typed spans before reads.
    unsafe { broadcast::<Packed<Bfloat16, Multiply>, 2>([left, right], output, packet, words) }
}

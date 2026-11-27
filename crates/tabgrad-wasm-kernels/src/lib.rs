#![no_std]

use core::panic::PanicInfo;

mod abi;
mod addition;
mod binary16;
mod coefficient_addition;
mod expansion;
mod fused_multiply_add;
mod half;
mod matrix_product;
mod multiplication;
mod pointwise;
mod receiving;
mod reduction;
mod reduction_f16;

#[panic_handler]
fn panic(_information: &PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

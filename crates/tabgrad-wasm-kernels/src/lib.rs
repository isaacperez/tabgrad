#![no_std]

use core::panic::PanicInfo;

mod abi;
mod addition;
mod coefficient_addition;
mod expansion;
mod fused_multiply_add;
mod matrix_product;
mod multiplication;
mod pointwise;
mod receiving;
mod reduction;

#[panic_handler]
fn panic(_information: &PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

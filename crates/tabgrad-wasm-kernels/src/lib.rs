#![no_std]

use core::panic::PanicInfo;

mod abi;
mod addition;
mod binary16;
mod coefficient_addition;
mod comparison;
mod expansion;
mod fused_multiply_add;
mod matrix_product;
mod matrix_product_packed;
mod multiplication;
mod packed_float;
mod packed_pointwise;
mod pointwise;
mod receiving;
mod reduction;
mod reduction_bf16;
mod reduction_f16;

#[panic_handler]
fn panic(_information: &PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

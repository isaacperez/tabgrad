#![no_std]

use core::panic::PanicInfo;

mod abi;
mod addition;
mod coefficient_addition;
mod expansion;
mod multiplication;
mod reduction;

#[panic_handler]
fn panic(_information: &PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

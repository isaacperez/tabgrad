use crate::abi::{
    FLOAT_ALIGNMENT, STATUS_INVALID_GEOMETRY, STATUS_OK, STATUS_OUT_OF_BOUNDS,
    STATUS_OUTPUT_OVERLAP, STATUS_UNALIGNED, checked_range, overlaps,
};

/// Arithmetic is statically selected; traversal has no operation-name dispatch.
pub(crate) trait Pointwise<const N: usize> {
    fn scalar(values: [f32; N]) -> f32;
    #[cfg(target_feature = "simd128")]
    fn vector(values: [core::arch::wasm32::v128; N]) -> core::arch::wasm32::v128;
}

/// Retained binary dense schedule, with arithmetic selected statically.
/// Separate unit-stride loops avoid imposing projected-address code on this path.
pub(crate) unsafe fn dense<P: Pointwise<2>>(
    left: *const f32,
    right: *const f32,
    output: *mut f32,
    length: usize,
) {
    let mut index = 0;
    #[cfg(target_feature = "simd128")]
    {
        use core::arch::wasm32::{v128_load, v128_store};
        let vector_end = length - length % 4;
        while index < vector_end {
            // SAFETY: callers validate complete dense disjoint ranges first.
            unsafe {
                let left_vector = v128_load(left.add(index).cast());
                let right_vector = v128_load(right.add(index).cast());
                v128_store(
                    output.add(index).cast(),
                    P::vector([left_vector, right_vector]),
                );
            }
            index += 4;
        }
    }
    while index < length {
        // SAFETY: one element remains in each caller-validated dense range.
        unsafe {
            output
                .add(index)
                .write(P::scalar([left.add(index).read(), right.add(index).read()]));
        }
        index += 1;
    }
}

/// The caller validates every projected span and distinct output first.
pub(crate) unsafe fn run<P: Pointwise<N>, const N: usize>(
    inputs: [*const f32; N],
    strides: [usize; N],
    output: *mut f32,
    length: usize,
) {
    let mut index = 0;
    #[cfg(target_feature = "simd128")]
    if strides.iter().all(|stride| *stride <= 1) {
        use core::arch::wasm32::{f32x4_splat, v128_load, v128_store};
        let vector_end = length - length % 4;
        while index < vector_end {
            // SAFETY: zero/unit strides select one scalar or four valid inputs.
            let values = core::array::from_fn(|operand| unsafe {
                if strides[operand] == 0 {
                    f32x4_splat(inputs[operand].read())
                } else {
                    v128_load(inputs[operand].add(index).cast())
                }
            });
            // SAFETY: four writable output elements remain.
            unsafe {
                v128_store(output.add(index).cast(), P::vector(values));
            }
            index += 4;
        }
    }
    while index < length {
        // SAFETY: projected coordinates stay inside the validated input spans.
        let values = core::array::from_fn(|operand| unsafe {
            inputs[operand].add(index * strides[operand]).read()
        });
        unsafe {
            output.add(index).write(P::scalar(values));
        }
        index += 1;
    }
}

/// rank, arity, output count, N input counts, rank*(dimension,N strides),
/// then rank private counters. Packet and payloads must be disjoint.
pub(crate) unsafe fn broadcast<P: Pointwise<N>, const N: usize>(
    input_offsets: [u32; N],
    output_offset: u32,
    packet_offset: u32,
    packet_words: u32,
) -> u32 {
    if input_offsets
        .iter()
        .chain([output_offset, packet_offset].iter())
        .any(|offset| !offset.is_multiple_of(FLOAT_ALIGNMENT))
    {
        return STATUS_UNALIGNED;
    }
    let memory_bytes = core::arch::wasm32::memory_size(0) as u64 * 65_536;
    let Some(packet_range) = checked_range(packet_offset, packet_words, memory_bytes) else {
        return STATUS_OUT_OF_BOUNDS;
    };
    if packet_words < (3 + N) as u32 {
        return STATUS_INVALID_GEOMETRY;
    }
    let packet = packet_offset as *mut u32;
    // SAFETY: the fixed header fits the complete validated packet range.
    let rank = unsafe { packet.read() } as usize;
    if rank
        .checked_mul(N + 2)
        .and_then(|size| size.checked_add(3 + N))
        != Some(packet_words as usize)
        || unsafe { packet.add(1).read() } != N as u32
    {
        return STATUS_INVALID_GEOMETRY;
    }
    let count = unsafe { packet.add(2).read() };
    let lengths: [u32; N] =
        core::array::from_fn(|operand| unsafe { packet.add(3 + operand).read() });
    let Some(output_range) = checked_range(output_offset, count, memory_bytes) else {
        return STATUS_OUT_OF_BOUNDS;
    };
    for operand in 0..N {
        let Some(range) = checked_range(input_offsets[operand], lengths[operand], memory_bytes)
        else {
            return STATUS_OUT_OF_BOUNDS;
        };
        if overlaps(range, output_range) || overlaps(range, packet_range) {
            return STATUS_OUTPUT_OVERLAP;
        }
    }
    if overlaps(output_range, packet_range) {
        return STATUS_OUTPUT_OVERLAP;
    }
    let body = 3 + N;
    let mut expected = [1_u64; N];
    let mut total = 1_u64;
    for axis in (0..rank).rev() {
        let dimension = unsafe { packet.add(body + axis * (N + 1)).read() };
        if dimension == 0 {
            return STATUS_INVALID_GEOMETRY;
        }
        total *= u64::from(dimension);
        if total > u64::from(u32::MAX) {
            return STATUS_INVALID_GEOMETRY;
        }
        for (operand, elements) in expected.iter_mut().enumerate() {
            let stride = unsafe { packet.add(body + axis * (N + 1) + 1 + operand).read() };
            if stride != 0 {
                if u64::from(stride) != *elements {
                    return STATUS_INVALID_GEOMETRY;
                }
                *elements *= u64::from(dimension);
                if *elements > u64::from(u32::MAX) {
                    return STATUS_INVALID_GEOMETRY;
                }
            }
        }
    }
    if total != u64::from(count)
        || expected
            .iter()
            .zip(lengths)
            .any(|(expected, length)| *expected != u64::from(length))
    {
        return STATUS_INVALID_GEOMETRY;
    }
    let counters = unsafe { packet.add(body + rank * (N + 1)) };
    for axis in 0..rank {
        unsafe {
            counters.add(axis).write(0);
        }
    }
    let inner = if rank == 0 {
        1
    } else {
        (unsafe { packet.add(body + (rank - 1) * (N + 1)).read() }) as usize
    };
    let inner_strides = core::array::from_fn(|operand| {
        if rank == 0 {
            0
        } else {
            (unsafe { packet.add(body + (rank - 1) * (N + 1) + 1 + operand).read() }) as usize
        }
    });
    let mut offsets = [0_usize; N];
    for start in (0..count as usize).step_by(inner) {
        let inputs = core::array::from_fn(|operand| unsafe {
            (input_offsets[operand] as *const f32).add(offsets[operand])
        });
        unsafe {
            run::<P, N>(
                inputs,
                inner_strides,
                (output_offset as *mut f32).add(start),
                inner,
            );
        }
        for axis in (0..rank.saturating_sub(1)).rev() {
            let coordinate = unsafe { counters.add(axis).read() } + 1;
            let dimension = unsafe { packet.add(body + axis * (N + 1)).read() };
            for (operand, offset) in offsets.iter_mut().enumerate() {
                *offset +=
                    unsafe { packet.add(body + axis * (N + 1) + 1 + operand).read() } as usize;
            }
            if coordinate < dimension {
                unsafe {
                    counters.add(axis).write(coordinate);
                }
                break;
            }
            unsafe {
                counters.add(axis).write(0);
            }
            for (operand, offset) in offsets.iter_mut().enumerate() {
                *offset -= dimension as usize
                    * unsafe { packet.add(body + axis * (N + 1) + 1 + operand).read() } as usize;
            }
        }
    }
    STATUS_OK
}

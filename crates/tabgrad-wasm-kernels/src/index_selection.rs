use crate::abi::{
    STATUS_INVALID_GEOMETRY, STATUS_OK, STATUS_OUT_OF_BOUNDS, STATUS_OUTPUT_OVERLAP,
    STATUS_UNALIGNED, checked_typed_range, overlaps,
};
use core::{arch::wasm32, mem::size_of, ptr};

const INDEX_ERROR: u32 = 0x8000_0000;

trait SignedIndex: Copy {
    fn number(self) -> i64;
}

impl SignedIndex for i32 {
    #[inline]
    fn number(self) -> i64 {
        i64::from(self)
    }
}

impl SignedIndex for i64 {
    #[inline]
    fn number(self) -> i64 {
        self
    }
}

fn index_select<T: Copy, I: SignedIndex>(
    source: u32,
    indices: u32,
    output: u32,
    bound: u64,
    count: u32,
    inner: u32,
    elements: u32,
) -> u32 {
    let data_width = size_of::<T>() as u32;
    let index_width = size_of::<I>() as u32;
    if !source.is_multiple_of(data_width)
        || !output.is_multiple_of(data_width)
        || !indices.is_multiple_of(index_width)
    {
        return STATUS_UNALIGNED;
    }
    let memory_bytes = (wasm32::memory_size(0) as u64) * 65536;
    let Some(index_span) = checked_typed_range(indices, count, index_width, memory_bytes) else {
        return STATUS_OUT_OF_BOUNDS;
    };
    // One status bit distinguishes payload bounds errors from ABI faults.
    if count >= INDEX_ERROR {
        return STATUS_INVALID_GEOMETRY;
    }

    let (outer, source_elements) = if elements == 0 {
        (0, 0)
    } else {
        let Ok(axis) = u32::try_from(bound) else {
            return STATUS_INVALID_GEOMETRY;
        };
        let Some(output_block) = count.checked_mul(inner).filter(|block| *block != 0) else {
            return STATUS_INVALID_GEOMETRY;
        };
        if axis == 0 || !elements.is_multiple_of(output_block) {
            return STATUS_INVALID_GEOMETRY;
        }
        let outer = elements / output_block;
        let Some(source_elements) = outer
            .checked_mul(axis)
            .and_then(|size| size.checked_mul(inner))
        else {
            return STATUS_INVALID_GEOMETRY;
        };
        (outer, source_elements)
    };
    let Some(source_span) = checked_typed_range(source, source_elements, data_width, memory_bytes)
    else {
        return STATUS_OUT_OF_BOUNDS;
    };
    let Some(output_span) = checked_typed_range(output, elements, data_width, memory_bytes) else {
        return STATUS_OUT_OF_BOUNDS;
    };
    if elements != 0 && (overlaps(output_span, source_span) || overlaps(output_span, index_span)) {
        return STATUS_OUTPUT_OVERLAP;
    }

    let index_values = indices as *const I;
    // SAFETY: the ABI checked every storage span and disjoint writable output.
    // Check all indices before deriving any address or modifying output.
    unsafe {
        for position in 0..count {
            let index = index_values.add(position as usize).read().number();
            if index < 0 || index as u64 >= bound {
                return INDEX_ERROR | position;
            }
        }
        let source_values = source as *const T;
        let output_values = output as *mut T;
        let axis = bound as u32;
        for block in 0..outer {
            for position in 0..count {
                let index = index_values.add(position as usize).read().number() as u32;
                let from = ((block * axis + index) * inner) as usize;
                let to = ((block * count + position) * inner) as usize;
                ptr::copy_nonoverlapping(
                    source_values.add(from),
                    output_values.add(to),
                    inner as usize,
                );
            }
        }
    }
    STATUS_OK
}

macro_rules! select_words {
    ($name:ident, $data:ty, $index:ty) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn $name(
            source: u32,
            indices: u32,
            output: u32,
            bound_low: u32,
            bound_high: u32,
            count: u32,
            inner: u32,
            elements: u32,
        ) -> u32 {
            let bound = u64::from(bound_high) << 32 | u64::from(bound_low);
            index_select::<$data, $index>(source, indices, output, bound, count, inner, elements)
        }
    };
}

select_words!(tabgrad_index_select_u32_i32, u32, i32);
select_words!(tabgrad_index_select_u32_i64, u32, i64);
select_words!(tabgrad_index_select_u64_i32, u64, i32);
select_words!(tabgrad_index_select_u64_i64, u64, i64);

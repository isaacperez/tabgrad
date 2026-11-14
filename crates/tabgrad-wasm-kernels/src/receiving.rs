use crate::abi::{
    FLOAT_ALIGNMENT, STATUS_INVALID_GEOMETRY, STATUS_OK, STATUS_OUT_OF_BOUNDS,
    STATUS_OUTPUT_OVERLAP, STATUS_UNALIGNED, checked_range, overlaps,
};
use crate::reduction::{ContiguousSource, SumSource, sum_f32};

unsafe fn project(mut index: usize, packet: *const u32, start: usize, rank: usize) -> usize {
    let mut offset = 0;
    for axis in (0..rank).rev() {
        let dimension = unsafe { packet.add(start + axis * 2).read() } as usize;
        let stride = unsafe { packet.add(start + axis * 2 + 1).read() } as usize;
        offset += (index % dimension) * stride;
        index /= dimension;
    }
    offset
}

struct GroupSource {
    input: *const f32,
    base: usize,
    packet: *const u32,
    start: usize,
    rank: usize,
}
impl SumSource for GroupSource {
    unsafe fn load(&self, index: usize) -> f32 {
        // SAFETY: validated disjoint group/term axes partition the full input.
        let offset = unsafe { project(index, self.packet, self.start, self.rank) };
        unsafe { self.input.add(self.base + offset).read() }
    }
}

/// source count, groups, terms/group, group rank, term rank, then ordered
/// (dimension, source stride) pairs for group axes and term axes.
#[unsafe(no_mangle)]
pub extern "C" fn tabgrad_receive_f32(
    input: u32,
    output: u32,
    packet_offset: u32,
    packet_words: u32,
) -> u32 {
    if [input, output, packet_offset]
        .iter()
        .any(|offset| !offset.is_multiple_of(FLOAT_ALIGNMENT))
    {
        return STATUS_UNALIGNED;
    }
    let memory_bytes = core::arch::wasm32::memory_size(0) as u64 * 65_536;
    let Some(packet_range) = checked_range(packet_offset, packet_words, memory_bytes) else {
        return STATUS_OUT_OF_BOUNDS;
    };
    if packet_words < 5 {
        return STATUS_INVALID_GEOMETRY;
    }
    let packet = packet_offset as *const u32;
    // SAFETY: only the complete validated packet is inspected below.
    unsafe {
        let count = packet.read();
        let groups = packet.add(1).read();
        let terms = packet.add(2).read();
        let group_rank = packet.add(3).read() as usize;
        let term_rank = packet.add(4).read() as usize;
        if group_rank
            .checked_add(term_rank)
            .and_then(|rank| rank.checked_mul(2))
            .and_then(|size| size.checked_add(5))
            != Some(packet_words as usize)
        {
            return STATUS_INVALID_GEOMETRY;
        }
        let Some(input_range) = checked_range(input, count, memory_bytes) else {
            return STATUS_OUT_OF_BOUNDS;
        };
        let Some(output_range) = checked_range(output, groups, memory_bytes) else {
            return STATUS_OUT_OF_BOUNDS;
        };
        if groups != 0
            && ((count != 0 && overlaps(output_range, input_range))
                || overlaps(output_range, packet_range))
        {
            return STATUS_OUTPUT_OVERLAP;
        }
        if count == 0 {
            if terms != 0 || group_rank != 0 || term_rank != 0 {
                return STATUS_INVALID_GEOMETRY;
            }
            for index in 0..groups as usize {
                (output as *mut f32).add(index).write(0.0);
            }
            return STATUS_OK;
        }
        if u64::from(groups) * u64::from(terms) != u64::from(count) {
            return STATUS_INVALID_GEOMETRY;
        }
        let term_start = 5 + group_rank * 2;
        let mut remaining = [group_rank, term_rank];
        let starts = [5, term_start];
        let mut products = [1_u64; 2];
        let mut stride = 1_u64;
        // Merging both reversed ordered axis lists proves a contiguous full
        // source partition, not merely a maximum in-bounds selected address.
        while remaining != [0, 0] {
            // Singleton coordinates contribute no address offset and may share
            // a stride with their neighbor without duplicating source positions.
            for list in 0..2 {
                while remaining[list] != 0
                    && packet.add(starts[list] + (remaining[list] - 1) * 2).read() == 1
                {
                    remaining[list] -= 1;
                }
            }
            if remaining == [0, 0] {
                break;
            }
            let candidate = core::array::from_fn::<_, 2, _>(|list| {
                if remaining[list] == 0 {
                    u64::MAX
                } else {
                    u64::from(
                        packet
                            .add(starts[list] + (remaining[list] - 1) * 2 + 1)
                            .read(),
                    )
                }
            });
            let list = usize::from(candidate[1] < candidate[0]);
            if candidate[list] != stride {
                return STATUS_INVALID_GEOMETRY;
            }
            let dimension = packet.add(starts[list] + (remaining[list] - 1) * 2).read();
            if dimension == 0 {
                return STATUS_INVALID_GEOMETRY;
            }
            products[list] *= u64::from(dimension);
            stride *= u64::from(dimension);
            if stride > u64::from(count) {
                return STATUS_INVALID_GEOMETRY;
            }
            remaining[list] -= 1;
        }
        if products != [u64::from(groups), u64::from(terms)] {
            return STATUS_INVALID_GEOMETRY;
        }
        let contiguous =
            term_rank == 0 || (term_rank == 1 && packet.add(term_start + 1).read() == 1);
        for group in 0..groups as usize {
            let source = GroupSource {
                input: input as *const f32,
                base: project(group, packet, 5, group_rank),
                packet,
                start: term_start,
                rank: term_rank,
            };
            let value = if contiguous {
                sum_f32(
                    &ContiguousSource(source.input.add(source.base)),
                    0,
                    terms as usize,
                )
            } else {
                sum_f32(&source, 0, terms as usize)
            };
            (output as *mut f32).add(group).write(value);
        }
    }
    STATUS_OK
}

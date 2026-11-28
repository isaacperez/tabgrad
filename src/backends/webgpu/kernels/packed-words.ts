/** A four-byte storage word contains two logical 16-bit values. */
export const PACKED16_VALUES_PER_WORD = 2;

/** A four-byte storage word contains four logical boolean bytes. */
export const BOOL_VALUES_PER_WORD = 4;

export const PACKED16_LANE_SOURCE = `
fn packed16_lane(word: u32, index: u32) -> u32 {
  return (word >> ((index & 1u) * 16u)) & 0xffffu;
}
`;

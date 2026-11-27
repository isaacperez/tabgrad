import { invocationEntry, type LinearDispatchLayout } from "../linear-dispatch.js";
import { WEBGPU_ADDITION_ARITHMETIC_SOURCE } from "./addition.js";
import { BINARY16_ROUND_SHIFT_SOURCE } from "./half.js";
import { WEBGPU_MATRIX_STORAGE_SOURCE, WEBGPU_MATRIX_WORKGROUP_SIZE } from "./matrix-product.js";
import { PACKED16_LANE_SOURCE, PACKED16_VALUES_PER_WORD } from "./packed-words.js";

export function createHalfMatrixSource(layout: LinearDispatchLayout): string {
  const entry = invocationEntry(layout, WEBGPU_MATRIX_WORKGROUP_SIZE);
  const valuesPerWord = PACKED16_VALUES_PER_WORD;
  return `${WEBGPU_ADDITION_ARITHMETIC_SOURCE}${BINARY16_ROUND_SHIFT_SOURCE}${PACKED16_LANE_SOURCE}${WEBGPU_MATRIX_STORAGE_SOURCE}
fn exact_half_product(left_bits: u32, right_bits: u32) -> u32 {
  let a = left_bits & 0x7fffu;
  let b = right_bits & 0x7fffu;
  let sign = ((left_bits ^ right_bits) & 0x8000u) << 16u;
  if a > 0x7c00u || b > 0x7c00u { return 0x7fc00000u; }
  if a == 0x7c00u || b == 0x7c00u {
    if a == 0u || b == 0u { return 0x7fc00000u; }
    return sign | 0x7f800000u;
  }
  if a == 0u || b == 0u { return sign; }
  let ae = a >> 10u;
  let be = b >> 10u;
  let av = (a & 1023u) | select(0u, 1024u, ae != 0u);
  let bv = (b & 1023u) | select(0u, 1024u, be != 0u);
  let product = av * bv;
  let leading = firstLeadingBit(product);
  // Each half significand carries scale 2^(max(E, 1)-25).
  // The product fits in at most 22 bits and is normal in binary32.
  let exponent = max(ae, 1u) + max(be, 1u) + leading + 77u;
  let fraction = (product << (23u - leading)) & 0x7fffffu;
  return sign | (exponent << 23u) | fraction;
}

fn narrow_to_half(bits: u32) -> u32 {
  let sign = (bits >> 16u) & 0x8000u;
  let exponent = (bits >> 23u) & 255u;
  let fraction = bits & 0x7fffffu;
  if exponent == 255u && fraction != 0u { return 0x7e00u; }
  if exponent >= 143u { return sign | 0x7c00u; }
  if exponent < 113u { return sign | half_round_shift(fraction | 0x800000u, 126u - exponent); }
  return sign | (((exponent - 112u) << 10u) + half_round_shift(fraction, 13u));
}

@compute @workgroup_size(${WEBGPU_MATRIX_WORKGROUP_SIZE})
${entry.signature}
  let word = ${entry.index};
  let first = word * ${valuesPerWord}u;
  let count = matrix.rows * matrix.columns;
  if first >= count { return; }
  let row = first / matrix.columns;
  let column = first % matrix.columns;
  let next_column = column + 1u;
  let crosses_row = next_column == matrix.columns;
  let has_second = first + 1u < count;
  let second_row = row + u32(crosses_row && has_second);
  let second_column = select(next_column, 0u, crosses_row);
  let transpose_left = (matrix.flags & 1u) != 0u;
  let transpose_right = (matrix.flags & 2u) != 0u;
  let left_step = select(1u, matrix.rows, transpose_left);
  let right_step = select(matrix.columns, 1u, transpose_right);
  var a = select(row * matrix.contraction, row, transpose_left);
  var a_second = select(second_row * matrix.contraction, second_row, transpose_left);
  var b = select(column, column * matrix.contraction, transpose_right);
  var b_second = select(second_column, second_column * matrix.contraction, transpose_right);
  var first_total = 0u;
  var second_total = 0u;
  for (var t = 0u; t < matrix.contraction; t++) {
    let left_bits = packed16_lane(left[a / ${valuesPerWord}u], a);
    let right_bits = packed16_lane(right[b / ${valuesPerWord}u], b);
    first_total = add_binary32(first_total, exact_half_product(left_bits, right_bits));
    if has_second {
      // Neighboring columns usually share the same left operand.
      var left_other = left_bits;
      if crosses_row { left_other = packed16_lane(left[a_second / ${valuesPerWord}u], a_second); }
      let right_other = packed16_lane(right[b_second / ${valuesPerWord}u], b_second);
      second_total = add_binary32(second_total, exact_half_product(left_other, right_other));
    }
    a += left_step;
    a_second += left_step;
    b += right_step;
    b_second += right_step;
  }
  // The missing high lane never reads an operand and retains positive zero.
  let packed = narrow_to_half(first_total) | (narrow_to_half(second_total) << 16u);
  output[word] = packed;
}
`;
}

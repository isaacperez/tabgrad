import { invocationEntry, type LinearDispatchLayout } from "../linear-dispatch.js";
import { WEBGPU_MATRIX_STORAGE_SOURCE, WEBGPU_MATRIX_WORKGROUP_SIZE } from "./matrix-product.js";
import { PACKED16_LANE_SOURCE, PACKED16_VALUES_PER_WORD } from "./packed-words.js";

export function createPackedMatrixSource(layout: LinearDispatchLayout, arithmetic: string): string {
  const entry = invocationEntry(layout, WEBGPU_MATRIX_WORKGROUP_SIZE);
  const valuesPerWord = PACKED16_VALUES_PER_WORD;
  return `${arithmetic}${PACKED16_LANE_SOURCE}${WEBGPU_MATRIX_STORAGE_SOURCE}
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
    first_total = accumulate_packed(first_total, left_bits, right_bits);
    if has_second {
      // Neighboring columns usually share the same left operand.
      var left_other = left_bits;
      if crosses_row { left_other = packed16_lane(left[a_second / ${valuesPerWord}u], a_second); }
      let right_other = packed16_lane(right[b_second / ${valuesPerWord}u], b_second);
      second_total = accumulate_packed(second_total, left_other, right_other);
    }
    a += left_step;
    a_second += left_step;
    b += right_step;
    b_second += right_step;
  }
  // The missing high lane never reads an operand and retains positive zero.
  let packed = narrow_packed(first_total) | (narrow_packed(second_total) << 16u);
  output[word] = packed;
}
`;
}

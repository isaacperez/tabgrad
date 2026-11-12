const pythonChecks = {
  "functional-gradients": {
    assertions: "assert dx.tolist() == [9.0, 13.0]\nassert dy.tolist() == [2.0, 3.0]\nassert not dx.requires_grad",
    from: "[2.0, 3.0]",
    to: "[1.0, 4.0]",
    expected: "dx: [7.0, 15.0]\ndy: [1.0, 4.0]",
  },
  "matrix-products": {
    assertions: "assert y.tolist() == [[58., 64.], [139., 154.]]\nassert ga.tolist() == [[23., 29., 35.], [53., 67., 81.]]\nassert gb.tolist() == [[13., 18.], [17., 24.], [21., 30.]]",
    from: "[[1., 2.], [3., 4.]]",
    to: "[[1., 1.], [1., 1.]]",
    expected: "product: [[58.0, 64.0], [139.0, 154.0]]\ndA: [[15.0, 19.0, 23.0], [15.0, 19.0, 23.0]]\ndB: [[5.0, 5.0], [7.0, 7.0], [9.0, 9.0]]",
  },
};

/** Keep fixed-value checks in the test driver, leaving visitor examples editable.
 * Both CPU and GPU drivers pass their actual device-specific catalogue source.
 * @param {{examples: {id:string,python:{code:string,expected:string}}[], select:(id:string)=>void, execute:(source:string)=>Promise<string>}} options
 * @returns {Promise<void>}
 */
export async function checkEditablePythonExamples({ examples, select, execute }) {
  for (const [id, control] of Object.entries(pythonChecks)) {
    const example = examples.find(example => example.id === id);
    if (!example || !example.python.code.includes(control.from)) throw new Error(`Missing editable Python case: ${id}`);
    select(id);
    const checked = await execute(example.python.code + "\n" + control.assertions);
    if (checked !== example.python.expected) throw new Error(`Original Python result changed: ${id}`);
    const edited = await execute(example.python.code.replace(control.from, control.to));
    if (edited !== control.expected) throw new Error(`Edited Python result changed: ${id}: ${edited}`);
  }
}

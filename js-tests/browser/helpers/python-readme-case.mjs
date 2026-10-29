/** Execute the exact public README snippet with the attached interpreter. */
export function pythonReadmeCheck(source) {
  return `
import ast, contextlib, gc, io

def check_documented_python_example():
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        exec(${JSON.stringify(source)}, {})
    assert ast.literal_eval(output.getvalue().strip()) == [-2.0, 4.0]

check_documented_python_example()
del check_documented_python_example
gc.collect()
`;
}

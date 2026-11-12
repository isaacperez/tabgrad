/** Build downloads from the same source values used by the page, never maintained copies.
 * HTML downloads are text responses with explicit download filenames: visiting
 * a source URL cannot execute its CDN code as another website route.
 * @param {{integrationHtml:string,integrationPythonHtml:string,integrationPythonWorker:string}} data */
export function integrationFiles(data) {
  const html = `<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Tabgrad · JavaScript in your browser</title>\n${data.integrationHtml}\n</html>\n`;
  return [
    { path: "examples/javascript/index.html.txt", name: "index.html", body: html },
    { path: "examples/python/index.html.txt", name: "index.html", body: data.integrationPythonHtml },
    { path: "examples/python/python-worker.js.txt", name: "python-worker.js", body: data.integrationPythonWorker },
  ];
}

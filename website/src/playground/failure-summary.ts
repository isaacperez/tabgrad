/** Present a headline, without modifying the original diagnostic kept in details. */
export function failureSummary(text: string): string {
  const lines = text.split("\n");
  let headline = lines.find((line) => line.trim())?.trim() ?? "The run failed.";
  if (!/^PythonError:\s*Traceback/.test(headline)) return headline;
  let lastFrame = -1;
  let userLine: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s+at\s/.test(line)) break;
    if (/^\s+File ".*", line \d+/.test(line)) lastFrame = index;
    const frame = /^\s+File "<playground>", line (\d+)/.exec(line);
    if (frame) userLine = frame[1];
  }
  if (lastFrame < 0) return headline;
  const exception = lines.slice(lastFrame + 1).find((line) => /^\S/.test(line));
  if (!exception) return headline;
  headline = exception.trim();
  return userLine ? `${headline} (line ${userLine})` : headline;
}

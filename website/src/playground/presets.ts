import type { Device, Language } from "./messages";
interface Preset { python: { code: string }; javascript: { code: string } }

/** Select a preset, never rewrite an edited program. Device stays visible/editable. */
export function exampleSource(example: Preset, language: Language, device: Device): string {
  const declaration = language === "python" ? `device = "${device}"` : `const device = "${device}";`;
  return language === "python"
    ? example.python.code.replace("import torch\n\n", "import torch\n\n" + declaration + "\n\n")
    : declaration + "\n\n" + example.javascript.code;
}

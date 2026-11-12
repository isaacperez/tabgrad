import { parseFragment } from "parse5";

/** Preserve the renderer's coordinate scale instead of shrinking its labels.
 * @param {string} svg @returns {{width:number, height:number}}
 */
export function diagramSize(svg) {
  const root = parseFragment(svg).childNodes.find(node => node.tagName === "svg");
  const value = root?.attrs.find(attribute => attribute.name.toLowerCase() === "viewbox")?.value;
  const box = value?.trim().split(/[\s,]+/).map(Number);
  if (!box || box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) {
    throw new Error("A documentation diagram needs a finite, positive SVG viewBox.");
  }
  return { width: Math.ceil(box[2]), height: Math.ceil(box[3]) };
}

/** Add dimensions only to the owned generated diagram images, in one pass.
 * @param {string} markdown @param {Map<string,{width:number, height:number}>} sizes
 * @returns {string}
 */
export function sizeDiagramImages(markdown, sizes) {
  return markdown.replace(/<img src="\/diagrams\/([a-f0-9]{64})\.svg"/g, (image, id) => {
    const size = sizes.get(id);
    if (!size) throw new Error(`Missing generated diagram dimensions: ${id}`);
    return `${image} width="${size.width}" height="${size.height}"`;
  });
}

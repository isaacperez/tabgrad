import { visit, SKIP } from "unist-util-visit";

/** @param {import('hast').Nodes} node @returns {string} */
function textContent(node) {
  if (node.type === "text") return node.value;
  return "children" in node ? node.children.map(textContent).join("") : "";
}

/** Keep native table semantics inside one named, keyboard-accessible pan area. */
export function responsiveTables() {
  /** @param {import('hast').Root} tree */
  return function transform(tree) {
    visit(tree, "element", (node, index, parent) => {
      if (node.tagName !== "table" || typeof index !== "number" || !parent) return;
      if (parent.type === "element" && Array.isArray(parent.properties.className) && parent.properties.className.includes("table-viewport")) return SKIP;
      const caption = node.children.find(child => child.type === "element" && child.tagName === "caption");
      /** @type {string[]} */
      const headers = [];
      let columns = 1;
      visit(node, "element", cell => {
        if (cell.tagName === "th") headers.push(textContent(cell));
        if (cell.tagName === "tr") {
          const count = cell.children.reduce((total, child) => {
            if (child.type !== "element" || !["td", "th"].includes(child.tagName)) return total;
            const span = Number(child.properties.colSpan);
            return total + (Number.isInteger(span) && span > 0 ? span : 1);
          }, 0);
          columns = Math.max(columns, count);
        }
      });
      const title = (caption ? textContent(caption) : headers.join(" / ")).replace(/\s+/g, " ").trim();
      parent.children[index] = {
        type: "element", tagName: "div",
        properties: { className: ["table-viewport"], tabIndex: 0, role: "group", ariaLabel: title ? `Scrollable table: ${title}` : "Scrollable table", style: `--tg-table-columns: ${columns}` },
        children: [node],
      };
      return SKIP;
    });
  };
}

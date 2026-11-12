import assert from "node:assert/strict";
import { test } from "node:test";
import { responsiveTables } from "../scripts/table-layout.mjs";

test("table wrapping keeps its native headers, authored cells and attributes intact", () => {
  const table = {type:"element", tagName:"table", properties:{id:"methods"}, children:[
    {type:"element",tagName:"thead",properties:{},children:[{type:"element",tagName:"tr",properties:{},children:[
      {type:"element",tagName:"th",properties:{},children:[{type:"text",value:"Method"}]},
      {type:"element",tagName:"th",properties:{},children:[{type:"text",value:"Result and contract"}]},
    ]}]},
    {type:"element",tagName:"tbody",properties:{},children:[]},
  ]};
  const before = structuredClone(table);
  const tree = {type:"root",children:[table]};
  const transform = responsiveTables();
  transform(tree);
  const wrapper = tree.children[0];
  assert.equal(wrapper.tagName, "div");
  assert.equal(wrapper.properties.tabIndex, 0);
  assert.equal(wrapper.properties.role, "group");
  assert.equal(wrapper.properties.style, "--tg-table-columns: 2");
  assert.equal(wrapper.properties.ariaLabel, "Scrollable table: Method / Result and contract");
  assert.equal(wrapper.children[0], table);
  assert.deepEqual(table, before);
  transform(tree);
  assert.equal(tree.children[0], wrapper, "a repeated transform does not nest wrappers");
  assert.equal(wrapper.children[0], table);
});

test("an authored caption supplies the accessible name without changing it", () => {
  const table = {type:"element",tagName:"table",properties:{},children:[
    {type:"element",tagName:"caption",properties:{},children:[{type:"text",value:"Values < 1"}]},
  ]};
  const tree = {type:"root",children:[table]};
  responsiveTables()(tree);
  assert.equal(tree.children[0].properties.ariaLabel, "Scrollable table: Values < 1");
  assert.equal(tree.children[0].children[0], table);
});

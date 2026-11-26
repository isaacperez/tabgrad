const matrix = document.querySelector("[data-operation-compatibility]");
const form = matrix?.querySelector("[data-operation-filters]");
const search = form?.querySelector("[data-operation-search]");
const dtype = form?.querySelector("[data-operation-dtype]");
const status = matrix?.querySelector("[data-operation-count]");

if (matrix && form && search && dtype && status) {
  const rows = [...matrix.querySelectorAll("[data-operation-row]")];
  const modules = [...matrix.querySelectorAll("[data-operation-module]")];
  const moduleLinks = [...matrix.querySelectorAll("[data-operation-link]")];

  function update() {
    const query = search.value.trim().toLowerCase();
    const type = dtype.value;
    let matches = 0;
    for (const row of rows) {
      row.hidden = !row.dataset.names?.toLowerCase().includes(query)
        || (type !== "" && !row.dataset.dtypes?.split(" ").includes(type));
      if (!row.hidden) matches++;
    }
    for (const module of modules) module.hidden = !module.querySelector("[data-operation-row]:not([hidden])");
    for (const link of moduleLinks) link.hidden = !modules.some(module => module.id === link.dataset.operationLink && !module.hidden);
    status.textContent = matches === 0 ? "No matching operations. Try another name or dtype."
      : query || type ? `${matches} matching operation${matches === 1 ? "" : "s"}` : "";
  }

  form.addEventListener("submit", event => event.preventDefault());
  form.addEventListener("input", update);
  form.hidden = false;
  update();
}

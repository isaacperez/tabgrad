import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
import data from "../.generated/site-data.json";
import { documentationPage, documentationSidebar } from "../scripts/documentation-navigation.mjs";

export const onRequest = defineRouteMiddleware(async (context, next) => {
  const document = documentationPage(data, context.url.pathname);
  const route = context.locals.starlightRoute;
  route.head.push({ tag: "meta", attrs: { name: "tabgrad-documentation-version", content: document?.version ?? "site" } });
  if (document) route.head.push({ tag: "meta", attrs: { name: "tabgrad-search-version", content: document.version, "data-pagefind-filter": "scope[content]" } });
  if (!document || document.version === data.runtimeVersion) route.head.push({ tag: "meta", attrs: { name: "tabgrad-search-current", content: "current", "data-pagefind-filter": "scope[content]" } });
  if (document) {
    route.hasSidebar = true;
    route.sidebar = documentationSidebar(data, context.url.pathname);
    route.pagination = { prev: undefined, next: undefined };
    if (document.alias) {
      const canonical = new URL(document.canonicalRoute, context.site ?? context.url).href;
      route.head = route.head.map(entry => entry.tag === "link" && entry.attrs?.rel === "canonical"
        ? { ...entry, attrs: { ...entry.attrs, href: canonical } }
        : entry.tag === "meta" && entry.attrs?.property === "og:url"
          ? { ...entry, attrs: { ...entry.attrs, content: canonical } } : entry);
    }
  }
  await next();
});

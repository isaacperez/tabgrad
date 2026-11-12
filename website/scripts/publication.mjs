/** A production build's origin is supplied externally, never inferred from a preview URL.
 * @param {string | undefined} input @returns {string | undefined} */
export function siteOrigin(input) {
  if (input === undefined) return undefined;
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("TABGRAD_SITE_URL must be an HTTPS origin without credentials, path, query or fragment");
  }
  return url.origin + "/";
}

/** @param {string | undefined} origin @param {string} image @param {string} alt */
export function socialHead(origin, image = "/social/tabgrad.png", alt = "Tabgrad. PyTorch code in your browser. Nothing to install.") {
  if (!origin) return [];
  const url = new URL(image, origin).href;
  return [
    { tag: "meta", attrs: { property: "og:image", content: url } },
    { tag: "meta", attrs: { property: "og:image:alt", content: alt } },
    { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
    { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
    { tag: "meta", attrs: { property: "og:image:type", content: "image/png" } },
    { tag: "meta", attrs: { name: "twitter:image", content: url } },
    { tag: "meta", attrs: { name: "twitter:image:alt", content: alt } },
  ];
}

/** Public discovery uses the same explicit origin as canonical URLs.
 * @param {string | undefined} origin @returns {string} */
export function robotsTxt(origin) {
  return "User-agent: *\nAllow: /\n" + (origin ? `Sitemap: ${new URL("sitemap-index.xml", origin).href}\n` : "");
}

/** One article's structured data, from its native validated metadata.
 * Calendar dates retain their actual precision; no publication time is invented.
 * @param {string | undefined} origin @param {string} id
 * @param {{title:string,description:string,author:string,date:string}} post
 * @returns {string | undefined} */
export function articleStructuredData(origin, id, post) {
  if (!origin) return undefined;
  const url = new URL(`blog/${id}/`, origin).href;
  return JSON.stringify({
    "@context": "https://schema.org", "@type": "BlogPosting",
    "@id": url + "#article", url, mainEntityOfPage: url,
    headline: post.title, description: post.description,
    author: { "@type": "Person", name: post.author }, datePublished: post.date,
    image: new URL(`social/article-${id}.png`, origin).href,
  }).replaceAll("<", "\\u003c");
}

import type { APIRoute } from "astro";
import { robotsTxt } from "../../scripts/publication.mjs";

export const GET: APIRoute = ({ site }) =>
  new Response(robotsTxt(site?.href), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

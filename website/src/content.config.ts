import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { glob } from "astro/loaders";
import { blogSchema } from "./blog/schema";

export const collections = {
  docs: defineCollection({
    loader: docsLoader({
      generateId: ({ entry }) =>
        entry
          .replace(/\.md$/i, "")
          .replace(/(?:^|\/)index$/, "")
          .replace(/\/$/, "")
          .toLowerCase(),
    }),
    schema: docsSchema(),
  }),
  blog: defineCollection({
    loader: glob({
      base: "./.generated/blog",
      pattern: "*.md",
      generateId: ({ entry }) => entry.replace(/\.md$/, ""),
    }),
    schema: blogSchema,
  }),
};

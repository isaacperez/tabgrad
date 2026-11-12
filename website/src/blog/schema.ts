import { z } from "astro/zod";
import { illustrationNames } from "../../scripts/illustrations.mjs";

export const blogSchema = z
  .object({
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    author: z.string().trim().min(1),
    date: z.iso.date(),
    illustration: z
      .string()
      .refine((name) => illustrationNames.includes(name), "Unknown website illustration")
      .optional(),
  })
  .strict();

export type PostData = z.infer<typeof blogSchema>;

/** Most recent first; IDs give posts on the same day a stable order. */
export function sortPosts<T extends { id: string; data: PostData }>(posts: readonly T[]): T[] {
  return [...posts].sort(
    (a, b) => b.data.date.localeCompare(a.data.date) || a.id.localeCompare(b.id),
  );
}

export function formatPostDate(date: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

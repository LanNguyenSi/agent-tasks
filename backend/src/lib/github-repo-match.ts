import type { Prisma } from "@prisma/client";
import { escapeLikePattern } from "./like-pattern.js";

/**
 * `project.githubRepo` filter that matches `owner/repo` case-insensitively and
 * otherwise literally.
 *
 * GitHub repository names are case-insensitive while the stored binding keeps
 * whatever case it was written in. Prisma compiles `{ equals, mode:
 * "insensitive" }` to `ILIKE` without escaping the value, and `_` is legal in a
 * GitHub repo name (and `%` in hostile input), so an unescaped value would
 * also match other repos (`acme/my_repo` would select `acme/my-repo`). The
 * value goes through `escapeLikePattern` first, which makes `ILIKE` behave as
 * a plain case-insensitive equality. The stored value must still be exactly
 * `owner/repo`: no trimming, no clone URL.
 */
export function githubRepoEqualsInsensitive(
  repoFullName: string,
): Prisma.StringNullableFilter {
  return { equals: escapeLikePattern(repoFullName), mode: "insensitive" };
}

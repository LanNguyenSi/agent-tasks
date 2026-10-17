/**
 * Prisma passes `startsWith` and `contains` through to SQL LIKE without
 * escaping, so `_` and `%` in the value would act as wildcards. PostgreSQL's default LIKE escape
 * character is the backslash.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

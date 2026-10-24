import { z } from "zod";

/**
 * ISO date-time field with the zod 3 `.datetime()` accept set: `HH:MM` or
 * `HH:MM:SS` with any fractional-second precision, always Z-suffixed; offsets
 * (`+02:00`) and local times (no `Z`) are rejected and the value passes
 * through unchanged. zod 4's `z.iso.datetime()` alone REQUIRES seconds, so the
 * minute-precision form is restored as a second union branch (`precision: -1`
 * means minutes only, no seconds). Same helper as the backend's
 * lib/zod-formats.ts (this is a separate package; it cannot import from
 * backend/src).
 */
export function isoDatetime() {
  return z.union([z.iso.datetime(), z.iso.datetime({ precision: -1 })]);
}

/**
 * URL field with the zod 3 `.url()` accept set AND output: the value is only
 * checked for `new URL(value)` constructibility (`URL.canParse` has the same
 * WHATWG-parser semantics without throwing, available on the repo's Node
 * engines >= 22) and is returned UNCHANGED. zod 4's `z.url()` trims the input
 * and strips ASCII tab/CR/LF from the output, so it must not be used where
 * the old, unmodified value must survive validation.
 */
export function urlString() {
  return z.string().refine((value) => URL.canParse(value), { message: "Invalid url" });
}

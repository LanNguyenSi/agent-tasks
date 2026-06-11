import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  { ignores: [".next/**", "node_modules/**", "dist/**", "coverage/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // Quiet Precision convention: geometry must live in CSS classes, not inline
    // style props. Per-line eslint-disable is required for the documented
    // dynamic-value exceptions in ui/ (computed positions, size props, etc.).
    // This rule is WARN-only; existing pages have many violations that will be
    // resolved progressively in the surface PRs.
    files: ["src/**/*.tsx", "src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector: "JSXAttribute[name.name='style']",
          message:
            "Avoid inline style props; geometry belongs in CSS classes (Quiet Precision convention). For truly dynamic values add a /* dynamic: <reason> */ comment and eslint-disable-next-line on the line above.",
        },
      ],
    },
  },
];

export default eslintConfig;

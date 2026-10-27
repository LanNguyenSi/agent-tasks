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
  {
    // Tests: a tab title is written by a passive effect, so a bare
    // `expect(document.title)` read right after an await for other DOM races
    // that effect under load. It belongs in a waitFor callback, via
    // expectDocumentTitle (tests/unit/helpers/documentTitle.ts). Call counts
    // of effect-driven mocks have no reliable mechanical guard; the rule for
    // them is written at the top of tests/setup/vitest.setup.ts.
    files: ["tests/**/*.ts", "tests/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.name='expect'][arguments.0.type='MemberExpression'][arguments.0.object.name='document'][arguments.0.property.name='title']:not(:matches(CallExpression[callee.name='waitFor'], CallExpression[callee.object.name='vi'][callee.property.name='waitFor']) CallExpression)",
          message:
            "Do not read document.title bare in a test: the title is set by a passive effect and can lag the DOM a test just awaited. Use `await expectDocumentTitle(...)` from tests/unit/helpers/documentTitle.ts, or put the expect inside waitFor.",
        },
      ],
    },
  },
];

export default eslintConfig;

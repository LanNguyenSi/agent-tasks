import { defineConfig } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  { ignores: [".next/**", "node_modules/**", "dist/**", "coverage/**", "next-env.d.ts"] },
  ...nextVitals,
  ...nextTs,
  {
    // eslint-plugin-react-hooks 7 (via eslint-config-next 16) added the React
    // Compiler rules. Resets of local state on a prop change, portal mount
    // guards and derivable loading decisions were rewritten (render-time
    // adjustment, useSyncExternalStore). The effects still listed here set
    // state synchronously for one of these reasons, and each is kept because
    // the rewrite would change when or whether the state is set:
    // - reading localStorage, the system theme or other browser-only state
    //   after mount (a read during render would mismatch the server HTML),
    // - a reset or a loading/error flag that is bundled with an async load or
    //   a ref/storage side effect in the same effect, so it cannot be split
    //   off without reordering the two,
    // - resetting a form or a section when its key (project, team, task or the
    //   modal opening) changes while the same effect starts the new load.
    // The rule stays a visible warning backlog for these files only and is an
    // error everywhere else, so new code cannot add the pattern unnoticed.
    files: [
      "src/app/dev/ui/page.tsx",
      "src/app/home/page.tsx",
      "src/app/projects/*/_components/ProjectHubLayout.tsx",
      "src/app/projects/*/board/page.tsx",
      "src/app/projects/*/members/page.tsx",
      "src/app/projects/page.tsx",
      "src/app/projects/workflow/page.tsx",
      "src/app/settings/team/page.tsx",
      "src/components/ConnectAgentModal.tsx",
      "src/components/TaskArtifactsSection.tsx",
      "src/components/TaskDetail.tsx",
      "src/components/ThemePreferenceField.tsx",
      "src/components/dashboard/NewTaskModal.tsx",
      "src/components/tasks/NewTaskFlow.tsx",
      "src/lib/teamList.tsx",
    ],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  {
    // react-hooks/purity flags Date.now() inside useMemo. These three memos
    // read the clock only when their own inputs change (the done list, the
    // filters), not on every render. Moving the timestamp into the fetch state
    // instead would shift the done-task hide window on recomputes that are not
    // polls (a filter or visibility change), so the memos keep reading the
    // clock. A warning for these two files only, an error everywhere else.
    files: ["src/app/home/page.tsx", "src/app/projects/*/board/page.tsx"],
    rules: {
      "react-hooks/purity": "warn",
    },
  },
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
]);

export default eslintConfig;

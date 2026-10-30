import { defineConfig } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  { ignores: [".next/**", "node_modules/**", "dist/**", "coverage/**", "next-env.d.ts"] },
  ...nextVitals,
  ...nextTs,
  {
    // eslint-plugin-react-hooks 7 (via eslint-config-next 16) added the React
    // Compiler rules. Every effect listed here sets state synchronously on
    // purpose, and none of them can be rewritten without changing behaviour:
    // - reading localStorage, the system theme or the URL after mount (a read
    //   during render would mismatch the server HTML, so it has to wait for the
    //   first effect),
    // - toggling a loading flag or resetting dependent state before an async
    //   load starts, or when the team, project, task or modal key changes,
    // - clearing a page, search or form state when its filters change.
    // Moving them to event handlers, keys or render-time derivation is a
    // refactor of each screen, not a lint fix, so the rule stays a visible
    // warning backlog for these files only. The rule remains an error for every
    // other file, so new code cannot add the pattern unnoticed.
    files: [
      "src/app/dev/ui/page.tsx",
      "src/app/home/page.tsx",
      "src/app/projects/*/_components/ProjectHubLayout.tsx",
      "src/app/projects/*/board/page.tsx",
      "src/app/projects/*/members/page.tsx",
      "src/app/projects/page.tsx",
      "src/app/projects/workflow/page.tsx",
      "src/app/settings/team/page.tsx",
      "src/app/tasks/page.tsx",
      "src/components/AppChrome.tsx",
      "src/components/AppHeader.tsx",
      "src/components/ConnectAgentModal.tsx",
      "src/components/TaskArtifactsSection.tsx",
      "src/components/TaskDetail.tsx",
      "src/components/ThemePreferenceField.tsx",
      "src/components/dashboard/NewTaskModal.tsx",
      "src/components/task-detail/ImprovementPanel.tsx",
      "src/components/tasks/NewTaskFlow.tsx",
      "src/components/ui/Toast.tsx",
      "src/components/ui/usePopover.ts",
      "src/lib/teamList.tsx",
    ],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  {
    // react-hooks/purity flags Date.now() inside useMemo. These three memos
    // filter done tasks against the current time (the hide-older-than window)
    // and must read the clock when the list is recomputed. Freezing the time in
    // state or a ref would let the window go stale between polls, so it is a
    // warning for these two files only and an error everywhere else.
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

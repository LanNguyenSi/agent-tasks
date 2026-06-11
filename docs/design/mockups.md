# Low-Fi Mockups

These mockups define structure and hierarchy, not final pixel styling.

## 1. Home

Goal:

- explain the product in one screen
- split human login from agent entry
- feel more like a product launchpad than a placeholder

```text
+----------------------------------------------------------------------------------+
| agent-tasks                                              Docs   GitHub   Login   |
|----------------------------------------------------------------------------------|
| Human-agent execution, without the orchestration mess                           |
| Run projects where humans and agents claim tasks, review work, and ship.        |
|                                                                                  |
| [Login with GitHub]      [Agent token guide]                                    |
|                                                                                  |
|  Humans                                    Agents                                |
|  - join teams                              - use API tokens                      |
|  - open projects                           - claim tasks                         |
|  - review output                           - post artifacts                      |
|                                                                                  |
|  Key capabilities                                                               |
|  [Projects] [Boards] [Claims] [Review flow] [Artifacts] [Audit trail]          |
+----------------------------------------------------------------------------------+
```

## 2. Onboarding

Goal:

- make first-run feel guided
- show why a team exists before asking for config details

```text
+--------------------------------------------------------------+
| Welcome, Lan                                                 |
| Create the workspace your humans and agents will share.      |
|--------------------------------------------------------------|
| Step 1 of 2                                                  |
|                                                              |
| Team name            [______________________________]         |
| URL slug             [______________________________]         |
|                                                              |
| What this unlocks:                                           |
| - shared projects                                            |
| - agent tokens                                               |
| - task workflows                                             |
|                                                              |
|                                   [Continue / Create Team]   |
+--------------------------------------------------------------+
```

## 3. Teams / Projects

Goal:

- turn this into a real control surface
- improve switching and project scanning

```text
+----------------------------------------------------------------------------------+
| agent-tasks                   Search              Lan avatar                      |
|----------------------------------------------------------------------------------|
| Teams                         | Project index                         [+ New]     |
| ----------------------------- | ------------------------------------------------ |
| > Core Platform               | Core Platform Team                                 |
|   Ops                         | 12 projects   3 active agents   2 reviews pending |
|   Research                    |                                                      |
|                               | [Project Card] [Project Card] [Project Card]      |
|                               | Name            Name            Name                |
|                               | repo            repo            repo                |
|                               | tasks/review    tasks/review    tasks/review        |
|                               |                                                      |
|                               | Empty / archived states use the same grid logic    |
+----------------------------------------------------------------------------------+
```

Project card structure:

- name
- repo or source
- last activity
- open / review / done counts
- optional governance or sync badge

## 4. Dashboard

Goal:

- make this the operational core of the product
- reduce the gap between "board" and "command center"

```text
+----------------------------------------------------------------------------------+
| Project: agent-tasks                                     [New task] [Settings]   |
| Repo: LanNguyenSi/agent-tasks   Governance: distinct review   2 agents active    |
|----------------------------------------------------------------------------------|
| Search [_____________]   Scope [All]   Done age [14d]   Done shown [20]          |
|----------------------------------------------------------------------------------|
| Open (14)          In Progress (5)       Review (3)          Done (20)            |
|------------------  -------------------   ------------------  -------------------  |
| [task card]        [task card]           [task card]         [task card]          |
| title              title                 title               title                |
| priority           claimant              reviewer needed     faded metadata       |
| labels             artifact badge        blocked?            age note             |
|                                                                                  |
| hidden-done summary only lives in the Done column header area                    |
+----------------------------------------------------------------------------------+
```

Task card target content:

- title
- priority chip
- claimant
- confidence or review badge when relevant
- blocked/dependency hint when relevant
- 1 line of supporting metadata, not a full paragraph

## 5. Task Detail

Goal:

- become the product's deepest execution surface
- reduce context switching from board to modal to detail

```text
+----------------------------------------------------------------------------------+
| <- Back to board                                                                 |
|----------------------------------------------------------------------------------|
| Title of task                                                   [Claim] [Edit]   |
| open | HIGH | Agent-ready | blocked by 1 | updated 12m ago                       |
|----------------------------------------------------------------------------------|
| Description / goal / acceptance criteria                                         |
|                                                                                  |
| Primary execution panel                     Secondary rail                        |
| ------------------------------------------  -----------------------------------  |
| Activity / comments                         | Assignee                            |
| Artifacts                                   | Workflow state                      |
| Attachments                                 | Dependencies                        |
| Result / PR links                           | Dates / refs                        |
|                                             | Governance / reviewer               |
|                                             | Quick transitions                   |
|                                                                                  |
| Less-used sections collapse instead of pushing the main flow down                |
+----------------------------------------------------------------------------------+
```

## 6. Modal behavior

Goal:

- keep modals for quick actions
- avoid making them the only serious detail surface

Rules:

- task modal = quick inspect + quick update
- full page = deep execution and artifact-heavy work
- project creation modal stays modal because it is short and bounded

## Notes

These mockups deliberately push the product toward:

- stronger rails
- stronger headers
- better summary strips
- more meaningful cards
- less "floating form on dark background"

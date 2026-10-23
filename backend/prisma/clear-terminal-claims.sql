-- One-off data repair, safe to run on every deploy: clears the work claim and
-- the review claim (user and agent holders, with their timestamps) of every
-- task whose status is a terminal state of its own effective workflow.
--
-- A finished task keeps no claim: every writer that ends a task clears them.
-- Rows written before that held a claim on a finished task, and such a claim
-- counts as an active claim again as soon as the task's workflow stops
-- treating its status as terminal (a workflow switch), which blocks the
-- holder's next pickup. This statement clears those leftovers.
--
-- Idempotent: after one run no task in a terminal state holds a claim, so a
-- second run matches no row and changes nothing. Only the claim columns are
-- written (no status, no status version, no updatedAt).
--
-- The effective workflow follows resolveEffectiveDefinition: the task's pinned
-- workflow row, else the first default row of the task's project, else the
-- built-in workflow, whose terminal state is `done`. A definition whose
-- `states` is not a list is judged by the built-in workflow too (the same
-- fallback as the status filters in workflow-status-filter.ts). `backlog` is
-- not a workflow state and is never touched.
--
-- A task the Grounding hold or an active GitHub repository fence refuses to
-- write (SQLSTATE 55000 from the task triggers) is skipped with a notice, and
-- the next run picks it up; one refused row must not fail the whole deploy.
DO $$
DECLARE
  t record;
  cleared integer := 0;
  skipped integer := 0;
BEGIN
  FOR t IN
    SELECT tk.id
    FROM tasks tk
    LEFT JOIN workflows pinned ON pinned.id = tk."workflowId"
    LEFT JOIN LATERAL (
      SELECT w.definition
      FROM workflows w
      WHERE w."projectId" = tk."projectId" AND w."isDefault"
      ORDER BY w."createdAt", w.id
      LIMIT 1
    ) dflt ON true
    WHERE tk.status <> 'backlog'
      AND (
        tk."claimedByUserId" IS NOT NULL OR tk."claimedByAgentId" IS NOT NULL OR tk."claimedAt" IS NOT NULL
        OR tk."reviewClaimedByUserId" IS NOT NULL OR tk."reviewClaimedByAgentId" IS NOT NULL OR tk."reviewClaimedAt" IS NOT NULL
      )
      AND CASE
        WHEN jsonb_typeof(COALESCE(pinned.definition, dflt.definition) -> 'states') = 'array' THEN
          EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(pinned.definition, dflt.definition) -> 'states') AS s
            WHERE jsonb_typeof(s) = 'object' AND s ->> 'name' = tk.status AND s -> 'terminal' = 'true'::jsonb
          )
        ELSE tk.status = 'done'
      END
  LOOP
    BEGIN
      UPDATE tasks
      SET "claimedByUserId" = NULL, "claimedByAgentId" = NULL, "claimedAt" = NULL,
          "reviewClaimedByUserId" = NULL, "reviewClaimedByAgentId" = NULL, "reviewClaimedAt" = NULL
      WHERE id = t.id;
      cleared := cleared + 1;
    EXCEPTION WHEN SQLSTATE '55000' THEN
      skipped := skipped + 1;
      RAISE NOTICE 'clear-terminal-claims: task % skipped (%)', t.id, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE 'clear-terminal-claims: % task(s) cleared, % skipped', cleared, skipped;
END
$$;

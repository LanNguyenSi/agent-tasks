-- Canonical install source for db:push, the production one-shot, and test schemas.
-- Guard writes, including inactive writes, deliberately create serialization conflicts.
BEGIN;

-- Match JavaScript String.trim, including its Unicode whitespace set.
CREATE OR REPLACE FUNCTION grounding_github_trim(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT btrim(value, U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
$$;

CREATE OR REPLACE FUNCTION grounding_github_repo(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE WHEN repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
    AND split_part(repo, '/', 1) NOT IN ('.', '..') AND split_part(repo, '/', 2) NOT IN ('.', '..')
    THEN lower(repo) END FROM (SELECT grounding_github_trim(value) AS repo) canonical
$$;

CREATE OR REPLACE FUNCTION grounding_github_pr_repo(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT grounding_github_repo((regexp_match(grounding_github_trim(value), '^https://github[.]com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)([/?#].*)?$', 'i'))[1])
$$;

CREATE OR REPLACE FUNCTION grounding_github_check(repos text[], task_id text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE repo_key text; active_owner text;
BEGIN
  FOR repo_key IN SELECT DISTINCT r COLLATE "C" FROM unnest(repos) r WHERE r IS NOT NULL ORDER BY r COLLATE "C" LOOP
    INSERT INTO grounding_github_repository_fences (repo, version) VALUES (repo_key, 1)
    ON CONFLICT (repo) DO UPDATE SET version = grounding_github_repository_fences.version + 1
    RETURNING "ownerId" INTO active_owner;
    IF active_owner IS NOT NULL AND (
      active_owner = nullif(current_setting('grounding.github_owner', true), '')
      AND repo_key = nullif(current_setting('grounding.github_repo', true), '')
      AND task_id = nullif(current_setting('grounding.github_task', true), '')
      AND EXISTS (SELECT 1 FROM grounding_github_fence_intents i WHERE i.id = active_owner AND i.repo = repo_key AND i.state = 'ACTIVE' AND (i.kind = 'MERGE' OR (i.kind = 'PR_CREATE' AND i."taskId" = task_id)))
    ) IS NOT TRUE THEN
      RAISE EXCEPTION 'grounding_github_fence_conflict: %', repo_key USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$$;

-- PR creation can begin before the task has any repository or PR binding.
CREATE OR REPLACE FUNCTION grounding_github_intent_repos(task_id text) RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(i.repo), '{}'::text[]) FROM grounding_github_fence_intents i
    JOIN grounding_github_repository_fences f ON f.repo = i.repo AND f."ownerId" = i.id
    WHERE i."taskId" = task_id AND i.kind = 'PR_CREATE' AND i.state = 'ACTIVE'
$$;

CREATE OR REPLACE FUNCTION grounding_github_task_repos(task_row tasks) RETURNS text[]
LANGUAGE plpgsql AS $$
DECLARE project_repo text;
BEGIN
  -- FOR SHARE sees the latest committed row at ReadCommitted and rejects a
  -- changed row under an older Serializable snapshot. It also blocks repo moves.
  SELECT "githubRepo" INTO project_repo FROM projects WHERE id = task_row."projectId" FOR SHARE;
  RETURN ARRAY[coalesce(grounding_github_repo(task_row."deliverableRepo"), grounding_github_repo(project_repo)), grounding_github_pr_repo(task_row."prUrl")] || grounding_github_intent_repos(task_row.id);
END
$$;

CREATE OR REPLACE FUNCTION grounding_github_task_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE repos text[] := '{}';
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) - 'updatedAt') = (to_jsonb(NEW) - 'updatedAt') THEN RETURN NEW; END IF;
  -- Lock project identities in a consistent order before resolving either side.
  PERFORM id FROM projects WHERE id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD."projectId" END, CASE WHEN TG_OP <> 'DELETE' THEN NEW."projectId" END) ORDER BY id COLLATE "C" FOR SHARE;
  IF TG_OP <> 'INSERT' THEN repos := repos || grounding_github_task_repos(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN repos := repos || grounding_github_task_repos(NEW); END IF;
  PERFORM grounding_github_check(repos, CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION grounding_github_project_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE repos text[]; task_row tasks;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(OLD."githubRepo", OLD."teamId", OLD."taskTemplate", OLD."governanceMode", OLD."requireDistinctReviewer", OLD."soloMode", OLD."requireGroundingForDebug", OLD."confidenceThreshold", OLD."taskTypeThresholds", OLD."riskModifiers", OLD."enforcementMode") IS NOT DISTINCT FROM ROW(NEW."githubRepo", NEW."teamId", NEW."taskTemplate", NEW."governanceMode", NEW."requireDistinctReviewer", NEW."soloMode", NEW."requireGroundingForDebug", NEW."confidenceThreshold", NEW."taskTypeThresholds", NEW."riskModifiers", NEW."enforcementMode") THEN RETURN NEW; END IF;
  repos := ARRAY[grounding_github_repo(OLD."githubRepo")];
  IF TG_OP <> 'DELETE' THEN repos := repos || grounding_github_repo(NEW."githubRepo"); END IF;
  FOR task_row IN SELECT * FROM tasks WHERE "projectId" = OLD.id LOOP
    repos := repos || grounding_github_intent_repos(task_row.id);
    repos := repos || ARRAY[grounding_github_repo(coalesce(task_row."deliverableRepo", OLD."githubRepo")), grounding_github_pr_repo(task_row."prUrl")];
    IF TG_OP <> 'DELETE' THEN repos := repos || grounding_github_repo(coalesce(task_row."deliverableRepo", NEW."githubRepo")); END IF;
  END LOOP;
  -- Project-wide writes never inherit a single task's internal write authority.
  PERFORM grounding_github_check(repos);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION grounding_github_enrollment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE task_row tasks; repos text[] := '{}'; owner_task text;
BEGIN
  IF TG_OP = 'UPDATE' AND to_jsonb(OLD) = to_jsonb(NEW) THEN RETURN NEW; END IF;
  FOR task_row IN SELECT * FROM tasks WHERE id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD."taskId" END, CASE WHEN TG_OP <> 'DELETE' THEN NEW."taskId" END) ORDER BY id COLLATE "C" FOR SHARE LOOP
    repos := repos || grounding_github_task_repos(task_row);
  END LOOP;
  owner_task := CASE WHEN TG_OP = 'DELETE' THEN OLD."taskId" ELSE NEW."taskId" END;
  -- Moving enrollment must not confer authority over the old task.
  IF TG_OP = 'UPDATE' AND OLD."taskId" <> NEW."taskId" THEN owner_task := NULL; END IF;
  PERFORM grounding_github_check(repos, owner_task);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION grounding_github_operation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE task_row tasks; repos text[] := '{}'; owner_task text;
BEGIN
  IF TG_OP = 'UPDATE' AND to_jsonb(OLD) = to_jsonb(NEW) THEN RETURN NEW; END IF;
  FOR task_row IN SELECT * FROM tasks WHERE id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD."taskId" END, CASE WHEN TG_OP <> 'DELETE' THEN NEW."taskId" END) ORDER BY id COLLATE "C" FOR SHARE LOOP
    repos := repos || grounding_github_task_repos(task_row);
  END LOOP;
  IF TG_OP <> 'INSERT' THEN repos := repos || grounding_github_repo(OLD.repo); END IF;
  IF TG_OP <> 'DELETE' THEN repos := repos || grounding_github_repo(NEW.repo); END IF;
  owner_task := CASE WHEN TG_OP = 'DELETE' THEN OLD."taskId" ELSE NEW."taskId" END;
  IF TG_OP = 'UPDATE' AND OLD."taskId" <> NEW."taskId" THEN owner_task := NULL; END IF;
  PERFORM grounding_github_check(repos, owner_task);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION grounding_github_intent_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR ROW(OLD.id, OLD.repo, OLD.kind, OLD."taskId") IS DISTINCT FROM ROW(NEW.id, NEW.repo, NEW.kind, NEW."taskId") OR (OLD.state = 'RELEASED' AND NEW.state <> 'RELEASED') THEN
    RAISE EXCEPTION 'grounding_github_fence_intent_immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS grounding_github_task_fence ON tasks;
CREATE TRIGGER grounding_github_task_fence BEFORE INSERT OR UPDATE OR DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION grounding_github_task_guard();
DROP TRIGGER IF EXISTS grounding_github_project_fence ON projects;
CREATE TRIGGER grounding_github_project_fence BEFORE UPDATE OR DELETE ON projects FOR EACH ROW EXECUTE FUNCTION grounding_github_project_guard();
DROP TRIGGER IF EXISTS grounding_github_binding_fence ON grounding_bindings;
CREATE TRIGGER grounding_github_binding_fence BEFORE INSERT OR UPDATE OR DELETE ON grounding_bindings FOR EACH ROW EXECUTE FUNCTION grounding_github_enrollment_guard();
DROP TRIGGER IF EXISTS grounding_github_cohort_fence ON grounding_cohorts;
CREATE TRIGGER grounding_github_cohort_fence BEFORE INSERT OR UPDATE OR DELETE ON grounding_cohorts FOR EACH ROW EXECUTE FUNCTION grounding_github_enrollment_guard();
DROP TRIGGER IF EXISTS grounding_github_operation_fence ON grounding_operations;
CREATE TRIGGER grounding_github_operation_fence BEFORE INSERT OR UPDATE OR DELETE ON grounding_operations FOR EACH ROW EXECUTE FUNCTION grounding_github_operation_guard();
DROP TRIGGER IF EXISTS grounding_github_intent_fence ON grounding_github_fence_intents;
CREATE TRIGGER grounding_github_intent_fence BEFORE UPDATE OR DELETE ON grounding_github_fence_intents FOR EACH ROW EXECUTE FUNCTION grounding_github_intent_guard();

-- Pin all function table/function lookups to the installation's own schema.
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS identity FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = current_schema() AND p.proname IN ('grounding_github_trim', 'grounding_github_repo', 'grounding_github_pr_repo', 'grounding_github_check', 'grounding_github_intent_repos', 'grounding_github_task_repos', 'grounding_github_task_guard', 'grounding_github_project_guard', 'grounding_github_enrollment_guard', 'grounding_github_intent_guard', 'grounding_github_operation_guard') LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %I, pg_temp', f.identity, current_schema());
  END LOOP;
END
$$;
COMMIT;

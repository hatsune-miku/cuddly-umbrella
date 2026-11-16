BEGIN;

DO $migration$
BEGIN
  IF (SELECT count(*) FROM build_targets WHERE kind = 'remote') <> 13 THEN
    RAISE EXCEPTION 'Expected 13 Remote project templates';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM site_bindings WHERE id = 'main') THEN
    RAISE EXCEPTION 'Main site binding is missing';
  END IF;
END
$migration$;

UPDATE build_targets
SET repository_url = 'git@git.chuanyuapp.com:frontend/kook.git',
    enabled = true,
    configuration_source = 'database',
    updated_at = now()
WHERE kind = 'remote';

UPDATE site_bindings
SET remote_target_ids = (
      SELECT jsonb_agg(id ORDER BY created_at, id)
      FROM build_targets
      WHERE kind = 'remote' AND enabled = true
    ),
    updated_at = now()
WHERE id = 'main';

INSERT INTO audit_events (id, actor, action, subject_type, subject_id, payload)
VALUES (
  gen_random_uuid(),
  'gz',
  'deployment.remote-projects.bootstrap',
  'site_binding',
  'main',
  jsonb_build_object('remoteTargetCount', 13)
);

COMMIT;

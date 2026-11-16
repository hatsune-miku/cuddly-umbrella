\pset pager off

SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'artifacts' AND column_name = 'deletion_started_at')
    OR (table_name = 'preview_sessions' AND column_name = 'revoked_at')
  )
ORDER BY table_name, column_name;

WITH ranked_ready AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY target_id, branch
           ORDER BY built_at DESC, id DESC
         ) AS branch_rank
  FROM artifacts
  WHERE status = 'READY'
)
SELECT artifact.id,
       artifact.target_id,
       artifact.branch,
       ranked.branch_rank,
       artifact.built_at
FROM artifacts AS artifact
JOIN ranked_ready AS ranked ON ranked.id = artifact.id
WHERE artifact.status = 'READY'
  AND ranked.branch_rank > 1
  AND NOT EXISTS (
    SELECT 1
    FROM environments AS environment
    JOIN environment_revision_items AS item
      ON item.revision_id = environment.current_revision_id
    WHERE item.artifact_id = artifact.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM preview_sessions AS preview
    WHERE preview.expires_at > now()
      AND (
        preview.revoked_at IS NULL
        OR preview.revoked_at > now() - interval '35 seconds'
      )
      AND (
        preview.site_artifact_id = artifact.id
        OR preview.selections @> jsonb_build_array(
          jsonb_build_object('artifactId', artifact.id)
        )
      )
  )
ORDER BY artifact.built_at, artifact.id;

SELECT status, count(*)
FROM artifacts
GROUP BY status
ORDER BY status;

\pset pager off

SELECT status, count(*)
FROM artifacts
GROUP BY status
ORDER BY status;

SELECT target_id, branch, count(*) AS ready_count,
       max(built_at) AS newest_built_at
FROM artifacts
WHERE status = 'READY'
GROUP BY target_id, branch
ORDER BY target_id, branch;

SELECT slug, current_revision_id
FROM environments
ORDER BY slug;

SELECT environment.slug,
       item.target_id,
       item.artifact_id,
       artifact.branch,
       artifact.status
FROM environments AS environment
JOIN environment_revision_items AS item
  ON item.revision_id = environment.current_revision_id
JOIN artifacts AS artifact ON artifact.id = item.artifact_id
ORDER BY environment.slug, item.target_id;

SELECT preview.token,
       preview.expires_at,
       preview.site_artifact_id,
       selection.value ->> 'targetId' AS target_id,
       selection.value ->> 'artifactId' AS artifact_id,
       artifact.status
FROM preview_sessions AS preview
LEFT JOIN LATERAL jsonb_array_elements(preview.selections) AS selection(value) ON true
LEFT JOIN artifacts AS artifact
  ON artifact.id = COALESCE(
    preview.site_artifact_id,
    (selection.value ->> 'artifactId')::uuid
  )
WHERE preview.expires_at > now()
  AND preview.revoked_at IS NULL
ORDER BY preview.expires_at, target_id;

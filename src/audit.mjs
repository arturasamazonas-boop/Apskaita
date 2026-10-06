// Append-only audit log. Never store document content or credentials here.
export async function audit(db, {userId = null, actor = 'user', action, entityType, entityId = null, details = {}}) {
  await db.query(
    'INSERT INTO audit_log(user_id, actor, action, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,$5,$6)',
    [userId, actor, action, entityType, entityId === null ? null : String(entityId), details],
  );
}

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE TABLE IF NOT EXISTS profile_audit_events (
  id bigserial PRIMARY KEY,
  profile_id uuid NOT NULL,
  actor_subject_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('PROFILE_DELETED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS profiles_active_organization_name
  ON profiles(organization_id, name) WHERE deleted_at IS NULL;

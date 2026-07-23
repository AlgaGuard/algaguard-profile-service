ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS source_profile_id uuid REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE profile_versions
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'profile_assignments'
       AND column_name = 'device_id' AND data_type = 'uuid'
  ) AND to_regclass('profile_assignments_legacy') IS NULL THEN
    ALTER TABLE profile_assignments RENAME TO profile_assignments_legacy;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS profile_shares (
  profile_id uuid NOT NULL REFERENCES profiles(id),
  organization_id uuid NOT NULL,
  shared_by text NOT NULL,
  shared_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(profile_id, organization_id)
);

CREATE TABLE IF NOT EXISTS profile_assignments (
  id uuid PRIMARY KEY,
  device_id text NOT NULL CHECK (device_id ~ '^AG-[0-9]{6}$'),
  organization_id uuid NOT NULL,
  profile_id uuid NOT NULL REFERENCES profiles(id),
  profile_version integer NOT NULL,
  configuration_hash text NOT NULL CHECK (configuration_hash ~ '^[0-9a-f]{64}$'),
  assigned_by text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true,
  FOREIGN KEY(profile_id, profile_version) REFERENCES profile_versions(profile_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_profile_assignment
  ON profile_assignments(device_id) WHERE active;
CREATE INDEX IF NOT EXISTS profile_assignment_history
  ON profile_assignments(device_id, assigned_at DESC);

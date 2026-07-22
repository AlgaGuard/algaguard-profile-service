CREATE TABLE profiles (id uuid PRIMARY KEY, organization_id uuid NOT NULL, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE profile_versions (id uuid PRIMARY KEY, profile_id uuid NOT NULL REFERENCES profiles(id), version integer NOT NULL, configuration jsonb NOT NULL, configuration_hash text NOT NULL, UNIQUE(profile_id, version));
CREATE TABLE profile_assignments (device_id uuid PRIMARY KEY, profile_version_id uuid NOT NULL REFERENCES profile_versions(id), assigned_at timestamptz NOT NULL DEFAULT now());


import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  configurationHash,
  DomainError,
  type Assignment,
  type Configuration,
  type Profile,
  type ProfileRepository,
  type ProfileVersion,
} from "./domain.js";

const iso = (value: Date | string) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

function version(row: Record<string, unknown>): ProfileVersion {
  return {
    id: String(row.version_id ?? row.id),
    profileId: String(row.profile_id),
    version: Number(row.version),
    configuration: row.configuration as Configuration,
    configurationHash: String(row.configuration_hash),
    createdAt: iso(
      (row.version_created_at as Date) ?? (row.created_at as Date),
    ),
  };
}

function profile(row: Record<string, unknown>): Profile {
  return {
    profileId: String(row.profile_id ?? row.id),
    organizationId: String(row.organization_id),
    name: String(row.name),
    ...(row.source_profile_id
      ? { sourceProfileId: String(row.source_profile_id) }
      : {}),
    createdAt: iso(
      (row.profile_created_at as Date) ?? (row.created_at as Date),
    ),
    current: version(row),
  };
}

function assignment(row: Record<string, unknown>): Assignment {
  return {
    id: String(row.id),
    deviceId: String(row.device_id),
    organizationId: String(row.organization_id),
    profileId: String(row.profile_id),
    profileVersion: Number(row.profile_version),
    configurationHash: String(row.configuration_hash),
    assignedAt: iso(row.assigned_at as Date),
    assignedBy: String(row.assigned_by),
  };
}

const currentProfileQuery = `
  SELECT p.id AS profile_id, p.organization_id, p.name, p.source_profile_id,
         p.created_at AS profile_created_at,
         v.id AS version_id, v.version, v.configuration, v.configuration_hash,
         v.created_at AS version_created_at
    FROM profiles p
    JOIN LATERAL (
      SELECT * FROM profile_versions pv WHERE pv.profile_id = p.id
      ORDER BY pv.version DESC LIMIT 1
    ) v ON true`;

export class PostgresProfileRepository implements ProfileRepository {
  constructor(readonly pool: pg.Pool) {}

  async createProfile(input: {
    organizationId: string;
    name: string;
    configuration: Configuration;
    sourceProfileId?: string;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const profileId = randomUUID();
      await client.query(
        "INSERT INTO profiles(id,organization_id,name,source_profile_id) VALUES($1,$2,$3,$4)",
        [
          profileId,
          input.organizationId,
          input.name,
          input.sourceProfileId ?? null,
        ],
      );
      await client.query(
        `INSERT INTO profile_versions(id,profile_id,version,configuration,configuration_hash)
         VALUES($1,$2,1,$3::jsonb,$4)`,
        [
          randomUUID(),
          profileId,
          JSON.stringify(input.configuration),
          configurationHash(input.configuration),
        ],
      );
      const result = await client.query(
        `${currentProfileQuery} WHERE p.id=$1`,
        [profileId],
      );
      await client.query("COMMIT");
      return profile(result.rows[0] as Record<string, unknown>);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createVersion(profileId: string, configuration: Configuration) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(
        "SELECT 1 FROM profiles WHERE id=$1 FOR UPDATE",
        [profileId],
      );
      if (!locked.rowCount)
        throw new DomainError("PROFILE_NOT_FOUND", 404, "Profile not found");
      const inserted = await client.query(
        `INSERT INTO profile_versions(id,profile_id,version,configuration,configuration_hash)
         SELECT $2,$1,coalesce(max(version),0)+1,$3::jsonb,$4 FROM profile_versions WHERE profile_id=$1
         RETURNING *`,
        [
          profileId,
          randomUUID(),
          JSON.stringify(configuration),
          configurationHash(configuration),
        ],
      );
      await client.query("COMMIT");
      return version(inserted.rows[0] as Record<string, unknown>);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async cloneProfile(profileId: string, organizationId: string, name: string) {
    const source = await this.getProfile(profileId);
    if (!source)
      throw new DomainError("PROFILE_NOT_FOUND", 404, "Profile not found");
    return this.createProfile({
      organizationId,
      name,
      configuration: source.current.configuration,
      sourceProfileId: profileId,
    });
  }

  async listProfiles(organizationId: string) {
    const result = await this.pool.query(
      `${currentProfileQuery}
       WHERE p.organization_id=$1 OR EXISTS(
         SELECT 1 FROM profile_shares s WHERE s.profile_id=p.id AND s.organization_id=$1
       ) ORDER BY p.name,p.id`,
      [organizationId],
    );
    return result.rows.map((row) => profile(row as Record<string, unknown>));
  }
  async getProfile(profileId: string) {
    const result = await this.pool.query(
      `${currentProfileQuery} WHERE p.id=$1`,
      [profileId],
    );
    return result.rows[0]
      ? profile(result.rows[0] as Record<string, unknown>)
      : undefined;
  }
  async versions(profileId: string) {
    const result = await this.pool.query(
      "SELECT * FROM profile_versions WHERE profile_id=$1 ORDER BY version",
      [profileId],
    );
    return result.rows.map((row) => version(row as Record<string, unknown>));
  }
  async share(profileId: string, organizationId: string, sharedBy: string) {
    try {
      await this.pool.query(
        `INSERT INTO profile_shares(profile_id,organization_id,shared_by) VALUES($1,$2,$3)
         ON CONFLICT(profile_id,organization_id) DO UPDATE SET shared_by=EXCLUDED.shared_by,shared_at=now()`,
        [profileId, organizationId, sharedBy],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23503")
        throw new DomainError("PROFILE_NOT_FOUND", 404, "Profile not found");
      throw error;
    }
  }
  async assign(input: {
    deviceId: string;
    organizationId: string;
    profileId: string;
    version: number;
    assignedBy: string;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `profile-assignment:${input.deviceId}`,
      ]);
      const available = await client.query(
        `SELECT pv.configuration_hash FROM profile_versions pv JOIN profiles p ON p.id=pv.profile_id
         WHERE pv.profile_id=$1 AND pv.version=$2 AND (
           p.organization_id=$3 OR EXISTS(SELECT 1 FROM profile_shares s WHERE s.profile_id=p.id AND s.organization_id=$3)
         )`,
        [input.profileId, input.version, input.organizationId],
      );
      if (!available.rows[0])
        throw new DomainError(
          "PROFILE_VERSION_NOT_AVAILABLE",
          403,
          "Profile version is not available",
        );
      await client.query(
        "UPDATE profile_assignments SET active=false WHERE device_id=$1 AND active",
        [input.deviceId],
      );
      const inserted = await client.query(
        `INSERT INTO profile_assignments
           (id,device_id,organization_id,profile_id,profile_version,configuration_hash,assigned_by)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          randomUUID(),
          input.deviceId,
          input.organizationId,
          input.profileId,
          input.version,
          available.rows[0].configuration_hash,
          input.assignedBy,
        ],
      );
      await client.query("COMMIT");
      return assignment(inserted.rows[0] as Record<string, unknown>);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async activeAssignment(deviceId: string) {
    const result = await this.pool.query(
      "SELECT * FROM profile_assignments WHERE device_id=$1 AND active",
      [deviceId],
    );
    return result.rows[0]
      ? assignment(result.rows[0] as Record<string, unknown>)
      : undefined;
  }
  async assignmentHistory(deviceId: string) {
    const result = await this.pool.query(
      "SELECT * FROM profile_assignments WHERE device_id=$1 ORDER BY assigned_at,id",
      [deviceId],
    );
    return result.rows.map((row) => assignment(row as Record<string, unknown>));
  }
  async health() {
    await this.pool.query("SELECT 1");
  }
  async close() {
    await this.pool.end();
  }
}

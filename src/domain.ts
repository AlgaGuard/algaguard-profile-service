import { createHash, randomUUID } from "node:crypto";

export type Configuration = Record<string, unknown>;

export interface ProfileVersion {
  id: string;
  profileId: string;
  version: number;
  configuration: Configuration;
  configurationHash: string;
  createdAt: string;
}

export interface Profile {
  profileId: string;
  organizationId: string;
  name: string;
  sourceProfileId?: string;
  current: ProfileVersion;
  createdAt: string;
}

export interface Assignment {
  id: string;
  deviceId: string;
  organizationId: string;
  profileId: string;
  profileVersion: number;
  configurationHash: string;
  assignedAt: string;
  assignedBy: string;
}

export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new DomainError(
        "NON_FINITE_NUMBER",
        400,
        "Configuration numbers must be finite",
      );
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`).join(",")}}`;
  }
  throw new DomainError(
    "UNSUPPORTED_CONFIGURATION_VALUE",
    400,
    "Configuration must be JSON-compatible",
  );
}

export function canonicalConfiguration(configuration: Configuration) {
  return canonicalValue(configuration);
}

export function configurationHash(configuration: Configuration) {
  return createHash("sha256")
    .update(canonicalConfiguration(configuration))
    .digest("hex");
}

export interface ProfileRepository {
  createProfile(input: {
    organizationId: string;
    name: string;
    configuration: Configuration;
    sourceProfileId?: string;
  }): Promise<Profile>;
  createVersion(
    profileId: string,
    configuration: Configuration,
  ): Promise<ProfileVersion>;
  cloneProfile(
    profileId: string,
    organizationId: string,
    name: string,
  ): Promise<Profile>;
  listProfiles(organizationId: string): Promise<Profile[]>;
  getProfile(profileId: string): Promise<Profile | undefined>;
  versions(profileId: string): Promise<ProfileVersion[]>;
  share(
    profileId: string,
    organizationId: string,
    sharedBy: string,
  ): Promise<void>;
  assign(input: {
    deviceId: string;
    organizationId: string;
    profileId: string;
    version: number;
    assignedBy: string;
  }): Promise<Assignment>;
  activeAssignment(deviceId: string): Promise<Assignment | undefined>;
  assignmentHistory(deviceId: string): Promise<Assignment[]>;
  health(): Promise<void>;
  close(): Promise<void>;
}

export class MemoryProfileRepository implements ProfileRepository {
  private readonly profiles = new Map<string, Omit<Profile, "current">>();
  private readonly profileVersions = new Map<string, ProfileVersion[]>();
  private readonly shares = new Map<string, Set<string>>();
  private readonly assignments = new Map<string, Assignment[]>();

  async createProfile(input: {
    organizationId: string;
    name: string;
    configuration: Configuration;
    sourceProfileId?: string;
  }) {
    const profileId = randomUUID();
    const createdAt = new Date().toISOString();
    const base = {
      profileId,
      organizationId: input.organizationId,
      name: input.name,
      ...(input.sourceProfileId
        ? { sourceProfileId: input.sourceProfileId }
        : {}),
      createdAt,
    };
    this.profiles.set(profileId, base);
    const current = await this.createVersion(profileId, input.configuration);
    return { ...base, current };
  }

  async createVersion(profileId: string, configuration: Configuration) {
    if (!this.profiles.has(profileId))
      throw new DomainError("PROFILE_NOT_FOUND", 404, "Profile not found");
    const existing = this.profileVersions.get(profileId) ?? [];
    const result: ProfileVersion = {
      id: randomUUID(),
      profileId,
      version: existing.length + 1,
      configuration: structuredClone(configuration),
      configurationHash: configurationHash(configuration),
      createdAt: new Date().toISOString(),
    };
    existing.push(result);
    this.profileVersions.set(profileId, existing);
    return structuredClone(result);
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
    const values: Profile[] = [];
    for (const profile of this.profiles.values()) {
      if (
        profile.organizationId !== organizationId &&
        !this.shares.get(profile.profileId)?.has(organizationId)
      )
        continue;
      const current = this.profileVersions.get(profile.profileId)?.at(-1);
      if (current)
        values.push({
          ...structuredClone(profile),
          current: structuredClone(current),
        });
    }
    return values;
  }

  async getProfile(profileId: string) {
    const profile = this.profiles.get(profileId);
    const current = this.profileVersions.get(profileId)?.at(-1);
    return profile && current
      ? { ...structuredClone(profile), current: structuredClone(current) }
      : undefined;
  }
  async versions(profileId: string) {
    return structuredClone(this.profileVersions.get(profileId) ?? []);
  }
  async share(profileId: string, organizationId: string, _sharedBy: string) {
    if (!this.profiles.has(profileId))
      throw new DomainError("PROFILE_NOT_FOUND", 404, "Profile not found");
    const values = this.shares.get(profileId) ?? new Set<string>();
    values.add(organizationId);
    this.shares.set(profileId, values);
  }
  async assign(input: {
    deviceId: string;
    organizationId: string;
    profileId: string;
    version: number;
    assignedBy: string;
  }) {
    const version = this.profileVersions
      .get(input.profileId)
      ?.find((value) => value.version === input.version);
    const profile = this.profiles.get(input.profileId);
    if (!profile || !version)
      throw new DomainError(
        "PROFILE_VERSION_NOT_FOUND",
        404,
        "Profile version not found",
      );
    if (
      profile.organizationId !== input.organizationId &&
      !this.shares.get(input.profileId)?.has(input.organizationId)
    )
      throw new DomainError(
        "PROFILE_NOT_SHARED",
        403,
        "Profile is not available to the organization",
      );
    const assignment: Assignment = {
      id: randomUUID(),
      deviceId: input.deviceId,
      organizationId: input.organizationId,
      profileId: input.profileId,
      profileVersion: input.version,
      configurationHash: version.configurationHash,
      assignedAt: new Date().toISOString(),
      assignedBy: input.assignedBy,
    };
    const history = this.assignments.get(input.deviceId) ?? [];
    history.push(assignment);
    this.assignments.set(input.deviceId, history);
    return structuredClone(assignment);
  }
  async activeAssignment(deviceId: string) {
    return structuredClone(this.assignments.get(deviceId)?.at(-1));
  }
  async assignmentHistory(deviceId: string) {
    return structuredClone(this.assignments.get(deviceId) ?? []);
  }
  async health() {}
  async close() {}
}

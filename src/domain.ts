import { createHash, randomUUID } from "node:crypto";
export interface ProfileVersion {
  id: string;
  profileId: string;
  version: number;
  configuration: Record<string, unknown>;
  hash: string;
}
export class ProfileStore {
  private readonly versions = new Map<string, ProfileVersion[]>();
  createVersion(profileId: string, configuration: Record<string, unknown>) {
    const current = this.versions.get(profileId) ?? [];
    const canonical = JSON.stringify(
      configuration,
      Object.keys(configuration).sort(),
    );
    const result = {
      id: randomUUID(),
      profileId,
      version: current.length + 1,
      configuration: structuredClone(configuration),
      hash: createHash("sha256").update(canonical).digest("hex"),
    };
    current.push(result);
    this.versions.set(profileId, current);
    return result;
  }
  getVersion(profileId: string, version: number) {
    return this.versions
      .get(profileId)
      ?.find((item) => item.version === version);
  }
}

import assert from "node:assert/strict";
import test from "node:test";
import { configurationHash, MemoryProfileRepository } from "../src/domain.js";
const organizationId = "10000000-0000-4000-8000-000000000001";
test("canonical hash is recursive, deterministic, and order independent", () => {
  const left = {
    simulationOnly: true,
    parameters: { ph: { unit: "PH", enabled: true }, temperature: [1, 2] },
  };
  const right = {
    parameters: { temperature: [1, 2], ph: { enabled: true, unit: "PH" } },
    simulationOnly: true,
  };
  assert.equal(configurationHash(left), configurationHash(right));
  assert.match(configurationHash(left), /^[0-9a-f]{64}$/);
});
test("versions are immutable snapshots and cloning starts a new identity", async () => {
  const repository = new MemoryProfileRepository();
  const input = { simulationOnly: true, parameters: { ph: { enabled: true } } };
  const profile = await repository.createProfile({
    organizationId,
    name: "Simulation",
    configuration: input,
  });
  input.simulationOnly = false;
  const second = await repository.createVersion(profile.profileId, input);
  assert.equal(profile.current.configuration.simulationOnly, true);
  assert.equal(second.version, 2);
  const clone = await repository.cloneProfile(
    profile.profileId,
    organizationId,
    "Clone",
  );
  assert.notEqual(clone.profileId, profile.profileId);
  assert.equal(clone.sourceProfileId, profile.profileId);
  assert.equal(clone.current.version, 1);
});
test("sharing, assignments, active lookup, and history preserve exact versions", async () => {
  const repository = new MemoryProfileRepository();
  const source = await repository.createProfile({
    organizationId,
    name: "Simulation",
    configuration: { simulationOnly: true },
  });
  const otherOrganization = "20000000-0000-4000-8000-000000000002";
  await repository.share(source.profileId, otherOrganization, "owner");
  await repository.assign({
    deviceId: "AG-000001",
    organizationId: otherOrganization,
    profileId: source.profileId,
    version: 1,
    assignedBy: "operator",
  });
  const second = await repository.createVersion(source.profileId, {
    simulationOnly: true,
    revision: 2,
  });
  await repository.assign({
    deviceId: "AG-000001",
    organizationId: otherOrganization,
    profileId: source.profileId,
    version: second.version,
    assignedBy: "operator",
  });
  assert.equal(
    (await repository.activeAssignment("AG-000001"))?.profileVersion,
    2,
  );
  assert.deepEqual(
    (await repository.assignmentHistory("AG-000001")).map(
      (value) => value.profileVersion,
    ),
    [1, 2],
  );
});

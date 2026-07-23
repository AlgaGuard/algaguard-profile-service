import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresProfileRepository } from "../src/repository.js";
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
test(
  "immutable versions and assignment history survive repository restart",
  { skip: !databaseUrl },
  async () => {
    const cleanup = new pg.Pool({ connectionString: databaseUrl });
    await cleanup.query(
      "TRUNCATE profile_assignments, profile_shares, profile_versions, profiles CASCADE",
    );
    await cleanup.end();
    const organizationId = "10000000-0000-4000-8000-000000000001";
    const first = new PostgresProfileRepository(
      new pg.Pool({ connectionString: databaseUrl }),
    );
    const created = await first.createProfile({
      organizationId,
      name: "Simulation",
      configuration: { simulationOnly: true, nested: { b: 2, a: 1 } },
    });
    const second = await first.createVersion(created.profileId, {
      nested: { a: 1, b: 2 },
      simulationOnly: true,
    });
    assert.equal(created.current.configurationHash, second.configurationHash);
    await first.assign({
      deviceId: "AG-000001",
      organizationId,
      profileId: created.profileId,
      version: 1,
      assignedBy: "owner",
    });
    await first.assign({
      deviceId: "AG-000001",
      organizationId,
      profileId: created.profileId,
      version: 2,
      assignedBy: "owner",
    });
    await first.close();
    const restarted = new PostgresProfileRepository(
      new pg.Pool({ connectionString: databaseUrl }),
    );
    assert.equal((await restarted.versions(created.profileId)).length, 2);
    assert.equal(
      (await restarted.activeAssignment("AG-000001"))?.profileVersion,
      2,
    );
    assert.deepEqual(
      (await restarted.assignmentHistory("AG-000001")).map(
        (value) => value.profileVersion,
      ),
      [1, 2],
    );
    await restarted.close();
  },
);

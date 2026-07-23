import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { buildApp } from "../src/app.js";
import type { AccessAuthorizer, Authenticator } from "../src/auth.js";
import { MemoryProfileRepository } from "../src/domain.js";
const authenticate: Authenticator = async () => ({ subjectId: "owner" });
const authorize: AccessAuthorizer = {
  async authorize() {
    return true;
  },
  async registerProfile() {},
};
function app() {
  return buildApp({
    repository: new MemoryProfileRepository(),
    authenticate,
    authorize,
  });
}
test("liveness and readiness include correlation and repository state", async () => {
  const instance = app();
  const live = await request(instance)
    .get("/health/live")
    .set("x-correlation-id", "test-correlation");
  assert.equal(live.status, 200);
  assert.equal(live.headers["x-correlation-id"], "test-correlation");
  assert.equal((await request(instance).get("/health/ready")).status, 200);
});
test("profile create, version, clone, and list flows are functional", async () => {
  const instance = app();
  const organizationId = "10000000-0000-4000-8000-000000000001";
  const created = await request(instance)
    .post("/v1/profiles")
    .set("authorization", "Bearer user")
    .send({
      organizationId,
      name: "Simulation",
      configuration: { simulationOnly: true },
    });
  assert.equal(created.status, 201);
  const version = await request(instance)
    .post(`/v1/profiles/${created.body.profileId}/versions`)
    .set("authorization", "Bearer user")
    .send({ simulationOnly: true, revision: 2 });
  assert.equal(version.body.version, 2);
  const clone = await request(instance)
    .post(`/v1/profiles/${created.body.profileId}/clone`)
    .set("authorization", "Bearer user")
    .send({ organizationId, name: "Clone" });
  assert.equal(clone.status, 201);
  assert.equal(clone.body.sourceProfileId, created.body.profileId);
  const listed = await request(instance)
    .get(`/v1/profiles?organizationId=${organizationId}`)
    .set("authorization", "Bearer user");
  assert.equal(listed.body.items.length, 2);
});
test("unknown routes use problem details", async () => {
  const response = await request(app()).get("/missing");
  assert.equal(response.status, 404);
  assert.match(
    response.headers["content-type"] ?? "",
    /application\/problem\+json/,
  );
});

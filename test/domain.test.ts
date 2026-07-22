import test from "node:test";
import assert from "node:assert/strict";
import { ProfileStore } from "../src/domain.js";
test("published profile versions are immutable snapshots", () => {
  const store = new ProfileStore();
  const input = {
    simulationOnly: true,
    parameters: { ph: { enabled: true, unit: "PH" } },
  };
  const first = store.createVersion("profile", input);
  input.simulationOnly = false;
  const second = store.createVersion("profile", input);
  assert.equal(first.version, 1);
  assert.equal(first.configuration.simulationOnly, true);
  assert.equal(second.version, 2);
  assert.notEqual(first.hash, second.hash);
});

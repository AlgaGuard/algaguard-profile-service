import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { buildGrpcServer } from "../src/grpc-server.js";
import type { Authenticator } from "../src/auth.js";
import { MemoryProfileRepository } from "../src/domain.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(here, "..", "proto", "profile_service.proto");

const authenticate: Authenticator = async (authorization) => {
  const clientId = authorization?.replace("Bearer ", "");
  return { subjectId: "caller", ...(clientId ? { clientId } : {}) };
};

async function startServer(repository = new MemoryProfileRepository()) {
  const server = buildGrpcServer({ repository, authenticate });
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error, boundPort) => (error ? reject(error) : resolve(boundPort)),
    );
  });
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [path.dirname(PROTO_PATH)],
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as any;
  const client = new proto.algaguard.profile.v1.ProfileLookupService(
    `127.0.0.1:${port}`,
    grpc.credentials.createInsecure(),
  );
  return {
    repository,
    client,
    stop: () =>
      new Promise<void>((resolve) => server.tryShutdown(() => resolve())),
  };
}

function metadataFor(bearer: string) {
  const metadata = new grpc.Metadata();
  metadata.set("authorization", `Bearer ${bearer}`);
  return metadata;
}

test("GetAlertProfile requires the alert-processor client identity", async () => {
  const { client, stop } = await startServer();
  try {
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          client.getAlertProfile(
            { deviceId: "AG-000001", organizationId: randomUUID() },
            metadataFor("algaguard-web"),
            (error: grpc.ServiceError, response: unknown) =>
              error ? reject(error) : resolve(response),
          );
        }),
      (error: grpc.ServiceError) => {
        assert.equal(error.code, grpc.status.PERMISSION_DENIED);
        return true;
      },
    );
  } finally {
    await stop();
  }
});

test("GetAlertProfile returns the active assignment's configuration", async () => {
  const { repository, client, stop } = await startServer();
  try {
    const organizationId = randomUUID();
    const profile = await repository.createProfile({
      organizationId,
      name: "Default",
      configuration: {
        status: "active",
        thresholds: { ph: { min: 6, max: 8 } },
      },
    });
    await repository.assign({
      deviceId: "AG-000001",
      organizationId,
      profileId: profile.profileId,
      version: profile.current.version,
      assignedBy: "owner",
    });
    const response = await new Promise<any>((resolve, reject) => {
      client.getAlertProfile(
        { deviceId: "AG-000001", organizationId },
        metadataFor("algaguard-realtime-service"),
        (error: grpc.ServiceError, value: unknown) =>
          error ? reject(error) : resolve(value),
      );
    });
    assert.equal(response.profileId, profile.profileId);
    assert.equal(response.version, profile.current.version);
    assert.deepEqual(JSON.parse(response.configurationJson), {
      status: "active",
      thresholds: { ph: { min: 6, max: 8 } },
    });
  } finally {
    await stop();
  }
});

test("GetAlertProfile reports NOT_FOUND when no assignment exists", async () => {
  const { client, stop } = await startServer();
  try {
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          client.getAlertProfile(
            { deviceId: "AG-999999", organizationId: randomUUID() },
            metadataFor("algaguard-realtime-service"),
            (error: grpc.ServiceError, response: unknown) =>
              error ? reject(error) : resolve(response),
          );
        }),
      (error: grpc.ServiceError) => {
        assert.equal(error.code, grpc.status.NOT_FOUND);
        return true;
      },
    );
  } finally {
    await stop();
  }
});

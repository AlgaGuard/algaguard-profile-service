import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { GrpcAccessAuthorizer } from "../src/auth.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function loadProto(file: string) {
  const protoPath = path.resolve(here, "..", "proto", file);
  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: false,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [path.dirname(protoPath)],
  });
  return grpc.loadPackageDefinition(packageDefinition) as any;
}

function withFakeTokenEndpoint(
  testFn: (environment: NodeJS.ProcessEnv) => Promise<void>,
) {
  return async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      if (String(input).includes("/protocol/openid-connect/token"))
        return new Response(
          JSON.stringify({ access_token: "fake-token", expires_in: 300 }),
          { status: 200 },
        );
      return originalFetch(input);
    }) as typeof fetch;
    try {
      await testFn({
        SERVICE_CLIENT_SECRET: "test-secret",
        SERVICE_CLIENT_ID: "algaguard-profile-service",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  };
}

test(
  "GrpcAccessAuthorizer calls Decide and RegisterResource with a bearer token, mapping resourceType=profile correctly",
  withFakeTokenEndpoint(async (environment) => {
    const proto = loadProto("access_service.proto");
    const decideRequests: any[] = [];
    const registerRequests: any[] = [];
    const server = new grpc.Server();
    server.addService(proto.algaguard.access.v1.AuthorizationService.service, {
      decide(
        call: grpc.ServerUnaryCall<any, any>,
        callback: grpc.sendUnaryData<any>,
      ) {
        decideRequests.push({
          request: call.request,
          authorization: call.metadata.get("authorization")[0],
        });
        callback(null, {
          allowed: true,
          reason: "",
          decidedAt: new Date().toISOString(),
          ttlSeconds: 5,
        });
      },
    });
    server.addService(
      proto.algaguard.access.v1.ResourceRegistryService.service,
      {
        registerResource(
          call: grpc.ServerUnaryCall<any, any>,
          callback: grpc.sendUnaryData<any>,
        ) {
          registerRequests.push(call.request);
          callback(null, {});
        },
      },
    );
    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync(
        "127.0.0.1:0",
        grpc.ServerCredentials.createInsecure(),
        (error, boundPort) => (error ? reject(error) : resolve(boundPort)),
      );
    });
    try {
      const authorizer = new GrpcAccessAuthorizer(
        `127.0.0.1:${port}`,
        environment,
      );
      const profileId = randomUUID();
      const organizationId = randomUUID();
      const allowed = await authorizer.authorize({
        subjectId: "owner",
        action: "profile.manage",
        resourceType: "profile",
        resourceId: profileId,
        organizationId,
      });
      assert.equal(allowed, true);
      assert.equal(decideRequests[0]?.authorization, "Bearer fake-token");
      assert.equal(decideRequests[0]?.request.resourceType, 3); // profile

      await authorizer.registerProfile(profileId, organizationId);
      assert.equal(registerRequests[0]?.resourceType, 3); // profile
      assert.equal(registerRequests[0]?.resourceId, profileId);
    } finally {
      await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
    }
  }),
);

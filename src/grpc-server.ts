import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { z } from "zod";
import { createAuthenticator, type Authenticator } from "./auth.js";
import type { ProfileRepository } from "./domain.js";
import { alertThresholdsFrom } from "./routes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(here, "..", "proto", "profile_service.proto");

function grpcErrorFor(message: string, code: grpc.status): grpc.ServiceError {
  return Object.assign(new Error(message), {
    code,
    name: "DOMAIN_ERROR",
    details: message,
    metadata: new grpc.Metadata(),
  });
}

export interface GrpcServerDependencies {
  repository: ProfileRepository;
  authenticate?: Authenticator;
}

export function buildGrpcServer(dependencies: GrpcServerDependencies) {
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [path.dirname(PROTO_PATH)],
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as any;
  const authenticate = dependencies.authenticate ?? createAuthenticator();
  const { repository } = dependencies;
  const alertProcessorClientId =
    process.env.ALERT_PROCESSOR_CLIENT_ID ?? "algaguard-realtime-service";

  const server = new grpc.Server();

  server.addService(proto.algaguard.profile.v1.ProfileLookupService.service, {
    async getAlertProfile(
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>,
    ) {
      try {
        const [authorization] = call.metadata.get("authorization");
        const actor = await authenticate(
          typeof authorization === "string" ? authorization : undefined,
        );
        if (actor.clientId !== alertProcessorClientId) {
          callback(
            grpcErrorFor(
              "Operation is not authorized",
              grpc.status.PERMISSION_DENIED,
            ),
          );
          return;
        }
        const deviceId = z
          .string()
          .regex(/^AG-[0-9]{6}$/)
          .parse(call.request.deviceId);
        const organizationId = z
          .string()
          .uuid()
          .parse(call.request.organizationId);
        const assignment = await repository.activeAssignment(deviceId);
        if (!assignment || assignment.organizationId !== organizationId) {
          callback(grpcErrorFor("Assignment not found", grpc.status.NOT_FOUND));
          return;
        }
        const profile = await repository.getProfile(assignment.profileId);
        const version = (await repository.versions(assignment.profileId)).find(
          (candidate) => candidate.version === assignment.profileVersion,
        );
        if (!profile || !version) {
          callback(
            grpcErrorFor("Profile version not found", grpc.status.NOT_FOUND),
          );
          return;
        }
        callback(null, {
          profileId: assignment.profileId,
          version: assignment.profileVersion,
          configurationJson: JSON.stringify(
            alertThresholdsFrom(version.configuration),
          ),
        });
      } catch (error) {
        callback(
          grpcErrorFor(
            error instanceof Error ? error.message : "Internal error",
            grpc.status.INVALID_ARGUMENT,
          ),
        );
      }
    },
  });

  return server;
}

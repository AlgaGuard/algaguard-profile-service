import * as grpc from "@grpc/grpc-js";
import { createPostgresPool } from "./adapters.js";
import { buildApp } from "./app.js";
import { createAuthenticator, GrpcAccessAuthorizer } from "./auth.js";
import { loadConfig } from "./config.js";
import { PostgresProfileRepository } from "./repository.js";
import { buildGrpcServer } from "./grpc-server.js";
const config = loadConfig();
const repository = new PostgresProfileRepository(createPostgresPool(config));
const authenticate = createAuthenticator();
const server = buildApp({
  repository,
  authenticate,
  authorize: new GrpcAccessAuthorizer(config.ACCESS_SERVICE_GRPC_ADDRESS),
}).listen(config.PORT, () =>
  process.stdout.write(
    `${JSON.stringify({ level: "info", service: "algaguard-profile-service", message: "listening", port: config.PORT })}\n`,
  ),
);
const grpcServer = buildGrpcServer({ repository, authenticate });
grpcServer.bindAsync(
  `0.0.0.0:${config.GRPC_PORT}`,
  grpc.ServerCredentials.createInsecure(),
  (error, port) => {
    if (error) throw error;
    process.stdout.write(
      `${JSON.stringify({ level: "info", service: "algaguard-profile-service", message: "grpc listening", port })}\n`,
    );
  },
);
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(
    `${JSON.stringify({ level: "info", service: "algaguard-profile-service", message: "shutdown", signal })}\n`,
  );
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  grpcServer.tryShutdown(() => {});
  server.close(async (error) => {
    try {
      await repository.close();
      clearTimeout(deadline);
      process.exit(error ? 1 : 0);
    } catch {
      process.exit(1);
    }
  });
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

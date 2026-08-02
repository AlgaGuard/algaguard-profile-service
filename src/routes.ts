import { Router, type Request } from "express";
import { z } from "zod";
import {
  createAuthenticator,
  OidcAccessAuthorizer,
  type AccessAuthorizer,
  type Authenticator,
} from "./auth.js";
import { DomainError, type ProfileRepository } from "./domain.js";
export interface RouteDependencies {
  repository: ProfileRepository;
  authenticate?: Authenticator;
  authorize?: AccessAuthorizer;
}
const configuration = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => Object.keys(value).length > 0,
    "configuration must not be empty",
  );
const alertThresholds = z
  .object({
    schema: z.literal("urn:algaguard:schema:profile:algae-thresholds:v1"),
    parameters: z
      .object({
        temperatureC: z.object({ minimum: z.number(), maximum: z.number() }),
        ph: z.object({ minimum: z.number(), maximum: z.number() }),
        lightLux: z.object({ minimum: z.number(), maximum: z.number() }),
        nitrateMgL: z.object({ minimum: z.number(), maximum: z.number() }),
        phosphateMgL: z.object({ minimum: z.number(), maximum: z.number() }),
        potassiumMgL: z.object({ minimum: z.number(), maximum: z.number() }),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [parameter, bounds] of Object.entries(value.parameters)) {
      if (bounds.minimum >= bounds.maximum) {
        context.addIssue({
          code: "custom",
          path: ["parameters", parameter],
          message: "minimum must be less than maximum",
        });
      }
    }
  });
export function createRouter(dependencies: RouteDependencies) {
  const router = Router();
  const auth = dependencies.authenticate ?? createAuthenticator();
  const access = dependencies.authorize ?? new OidcAccessAuthorizer();
  const { repository } = dependencies;
  router.get(
    "/internal/devices/:deviceId/alert-profile",
    async (request, response) => {
      const actor = await auth(request.header("authorization"));
      if (
        actor.clientId !==
        (process.env.ALERT_PROCESSOR_CLIENT_ID ?? "algaguard-realtime-service")
      ) {
        throw new DomainError("FORBIDDEN", 403, "Operation is not authorized");
      }
      const organizationId = z
        .string()
        .uuid()
        .parse(request.query.organizationId);
      const assignment = await repository.activeAssignment(
        z
          .string()
          .regex(/^AG-[0-9]{6}$/)
          .parse(request.params.deviceId),
      );
      if (!assignment || assignment.organizationId !== organizationId) {
        response.status(404).json({ code: "ASSIGNMENT_NOT_FOUND" });
        return;
      }
      const profile = await repository.getProfile(assignment.profileId);
      const version = (await repository.versions(assignment.profileId)).find(
        (candidate) => candidate.version === assignment.profileVersion,
      );
      if (!profile || !version) {
        response.status(404).json({ code: "PROFILE_VERSION_NOT_FOUND" });
        return;
      }
      response.json({
        profileId: assignment.profileId,
        version: assignment.profileVersion,
        configuration: alertThresholds.parse(version.configuration),
      });
    },
  );
  async function requireAccess(
    request: Request,
    action: string,
    resourceType: "organization" | "profile" | "device",
    resourceId: string,
    organizationId?: string,
  ) {
    const actor = await auth(request.header("authorization"));
    const correlationId = request.header("x-correlation-id");
    const allowed = await access.authorize({
      subjectId: actor.subjectId,
      action,
      resourceType,
      resourceId,
      ...(organizationId ? { organizationId } : {}),
      ...(correlationId ? { correlationId } : {}),
    });
    if (!allowed)
      throw new DomainError("FORBIDDEN", 403, "Operation is not authorized");
    return actor;
  }
  router.post("/profiles", async (request, response) => {
    const input = z
      .object({
        organizationId: z.string().uuid(),
        name: z.string().min(1).max(120),
        configuration,
      })
      .parse(request.body);
    await requireAccess(
      request,
      "profile.manage",
      "organization",
      input.organizationId,
    );
    const created = await repository.createProfile(input);
    const correlationId = request.header("x-correlation-id");
    await access.registerProfile(
      created.profileId,
      created.organizationId,
      correlationId,
    );
    response.status(201).json(created);
  });
  router.get("/profiles", async (request, response) => {
    const organizationId = z
      .string()
      .uuid()
      .parse(request.query.organizationId);
    await requireAccess(
      request,
      "profile.read",
      "organization",
      organizationId,
    );
    response.json({ items: await repository.listProfiles(organizationId) });
  });
  router.get("/profiles/:id", async (request, response) => {
    await requireAccess(request, "profile.read", "profile", request.params.id);
    const value = await repository.getProfile(request.params.id);
    response
      .status(value ? 200 : 404)
      .json(value ?? { code: "PROFILE_NOT_FOUND" });
  });
  router.post("/profiles/:id/versions", async (request, response) => {
    await requireAccess(
      request,
      "profile.manage",
      "profile",
      request.params.id,
    );
    response
      .status(201)
      .json(
        await repository.createVersion(
          request.params.id,
          configuration.parse(request.body),
        ),
      );
  });
  router.get("/profiles/:id/versions", async (request, response) => {
    await requireAccess(request, "profile.read", "profile", request.params.id);
    response.json({ items: await repository.versions(request.params.id) });
  });
  router.post("/profiles/:id/clone", async (request, response) => {
    const input = z
      .object({
        organizationId: z.string().uuid(),
        name: z.string().min(1).max(120),
      })
      .parse(request.body);
    await requireAccess(request, "profile.read", "profile", request.params.id);
    await requireAccess(
      request,
      "profile.manage",
      "organization",
      input.organizationId,
    );
    const created = await repository.cloneProfile(
      request.params.id,
      input.organizationId,
      input.name,
    );
    await access.registerProfile(
      created.profileId,
      created.organizationId,
      request.header("x-correlation-id"),
    );
    response.status(201).json(created);
  });
  router.put(
    "/profiles/:id/shares/:organizationId",
    async (request, response) => {
      const actor = await requireAccess(
        request,
        "profile.manage",
        "profile",
        request.params.id,
      );
      await repository.share(
        request.params.id,
        z.string().uuid().parse(request.params.organizationId),
        actor.subjectId,
      );
      response.status(204).end();
    },
  );
  router.put(
    "/devices/:deviceId/profile-assignment",
    async (request, response) => {
      const input = z
        .object({
          organizationId: z.string().uuid(),
          profileId: z.string().uuid(),
          version: z.number().int().positive(),
        })
        .parse(request.body);
      const actor = await requireAccess(
        request,
        "profile.assign",
        "device",
        request.params.deviceId,
        input.organizationId,
      );
      response.json(
        await repository.assign({
          deviceId: request.params.deviceId,
          organizationId: input.organizationId,
          profileId: input.profileId,
          version: input.version,
          assignedBy: actor.subjectId,
        }),
      );
    },
  );
  router.get(
    "/devices/:deviceId/profile-assignment",
    async (request, response) => {
      await requireAccess(
        request,
        "profile.read",
        "device",
        request.params.deviceId,
      );
      const value = await repository.activeAssignment(request.params.deviceId);
      response
        .status(value ? 200 : 404)
        .json(value ?? { code: "ASSIGNMENT_NOT_FOUND" });
    },
  );
  router.get(
    "/devices/:deviceId/profile-assignment/history",
    async (request, response) => {
      await requireAccess(
        request,
        "profile.read",
        "device",
        request.params.deviceId,
      );
      response.json({
        items: await repository.assignmentHistory(request.params.deviceId),
      });
    },
  );
  return router;
}

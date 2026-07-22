import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProfileStore } from "./domain.js";
export const router = Router();
const store = new ProfileStore();
const profiles = new Map<
  string,
  { profileId: string; name: string; current: unknown }
>();
router.post("/profiles", (request, response) => {
  const input = z
    .object({
      name: z.string().min(1),
      configuration: z.record(z.string(), z.unknown()),
    })
    .parse(request.body);
  const profileId = randomUUID();
  const profile = {
    profileId,
    name: input.name,
    current: store.createVersion(profileId, input.configuration),
  };
  profiles.set(profileId, profile);
  response.status(201).json(profile);
});
router.post("/profiles/:id/versions", (request, response) => {
  const configuration = z.record(z.string(), z.unknown()).parse(request.body);
  const version = store.createVersion(request.params.id, configuration);
  const profile = profiles.get(request.params.id);
  if (profile) profile.current = version;
  response.status(201).json(version);
});
router.get("/profiles", (_request, response) =>
  response.json({ items: [...profiles.values()] }),
);

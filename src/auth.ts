import { createRemoteJWKSet, jwtVerify } from "jose";
export interface Principal {
  subjectId: string;
  clientId?: string;
}
export type Authenticator = (
  authorization: string | undefined,
) => Promise<Principal>;
export class AuthenticationError extends Error {}
export function createAuthenticator(
  environment: NodeJS.ProcessEnv = process.env,
): Authenticator {
  const issuer =
    environment.KEYCLOAK_ISSUER ?? "http://keycloak:8080/realms/algaguard";
  const audience = environment.KEYCLOAK_AUDIENCE ?? "algaguard-api";
  const jwksUrl =
    environment.KEYCLOAK_JWKS_URL ?? `${issuer}/protocol/openid-connect/certs`;
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  return async (authorization) => {
    const token = /^Bearer ([^ ]+)$/.exec(authorization ?? "")?.[1];
    if (!token) throw new AuthenticationError("Bearer token required");
    const result = await jwtVerify(token, jwks, { issuer, audience });
    if (!result.payload.sub)
      throw new AuthenticationError("Token subject is required");
    return {
      subjectId: result.payload.sub,
      ...(typeof result.payload.azp === "string"
        ? { clientId: result.payload.azp }
        : {}),
    };
  };
}
export interface AccessAuthorizer {
  authorize(input: {
    subjectId: string;
    action: string;
    resourceType: "organization" | "profile" | "device";
    resourceId: string;
    organizationId?: string;
    correlationId?: string;
  }): Promise<boolean>;
  registerProfile(
    profileId: string,
    organizationId: string,
    correlationId?: string,
  ): Promise<void>;
}
export class OidcAccessAuthorizer implements AccessAuthorizer {
  private cached?: { token: string; expiresAt: number };
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  private async token() {
    if (this.cached && this.cached.expiresAt > Date.now() + 10_000)
      return this.cached.token;
    const issuer =
      this.environment.KEYCLOAK_ISSUER ??
      "http://keycloak:8080/realms/algaguard";
    const tokenUrl =
      this.environment.KEYCLOAK_TOKEN_URL ??
      `${issuer}/protocol/openid-connect/token`;
    const secret = this.environment.SERVICE_CLIENT_SECRET;
    if (!secret)
      throw new AuthenticationError("SERVICE_CLIENT_SECRET is required");
    const response = await this.fetcher(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id:
          this.environment.SERVICE_CLIENT_ID ?? "algaguard-profile-service",
        client_secret: secret,
      }),
    });
    if (!response.ok)
      throw new AuthenticationError("Service authentication failed");
    const body = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!body.access_token)
      throw new AuthenticationError("Service token response was invalid");
    this.cached = {
      token: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 30) * 1000,
    };
    return this.cached.token;
  }
  async authorize(input: {
    subjectId: string;
    action: string;
    resourceType: "organization" | "profile" | "device";
    resourceId: string;
    organizationId?: string;
    correlationId?: string;
  }) {
    const response = await this.fetcher(
      `${this.environment.ACCESS_SERVICE_URL ?? "http://access-service:3000"}/v1/internal/authorizations/decide`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await this.token()}`,
          ...(input.correlationId
            ? { "x-correlation-id": input.correlationId }
            : {}),
        },
        body: JSON.stringify({
          subjectId: input.subjectId,
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          ...(input.organizationId
            ? { organizationId: input.organizationId }
            : {}),
        }),
      },
    );
    return (
      response.ok &&
      Boolean(((await response.json()) as { allowed?: boolean }).allowed)
    );
  }
  async registerProfile(
    profileId: string,
    organizationId: string,
    correlationId?: string,
  ) {
    const response = await this.fetcher(
      `${this.environment.ACCESS_SERVICE_URL ?? "http://access-service:3000"}/v1/internal/resources/profile/${encodeURIComponent(profileId)}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await this.token()}`,
          ...(correlationId ? { "x-correlation-id": correlationId } : {}),
        },
        body: JSON.stringify({ organizationId }),
      },
    );
    if (!response.ok)
      throw new Error(
        `Access resource registration failed with ${response.status}`,
      );
  }
}

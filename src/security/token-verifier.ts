import { createLocalJWKSet, createRemoteJWKSet, errors, type JSONWebKeySet, jwtVerify } from "jose";
import { HttpProblem } from "../lib/problem.js";

export interface Principal {
  subject: string;
  roles: ReadonlySet<string>;
}

type KeySet = ReturnType<typeof createRemoteJWKSet> | ReturnType<typeof createLocalJWKSet>;

/**
 * Verifies tokens from ecommerce-auth-service locally with its public keys (cached 10 min,
 * refetched on an unknown kid). Accepts user tokens (shared audience) and service tokens
 * minted for this service only.
 */
export class TokenVerifier {
  private readonly keys: KeySet;

  constructor(
    private readonly config: { jwksUrl: string; issuer: string; audiences: string[] },
    staticJwks?: JSONWebKeySet,
  ) {
    this.keys = staticJwks
      ? createLocalJWKSet(staticJwks)
      : createRemoteJWKSet(new URL(config.jwksUrl), { cacheMaxAge: 600_000, cooldownDuration: 30_000, timeoutDuration: 5_000 });
  }

  async verify(token: string): Promise<Principal> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.config.issuer,
        audience: this.config.audiences,
        algorithms: ["RS256"],
        clockTolerance: 30,
        requiredClaims: ["sub", "exp", "iat"],
      });
      if (!Array.isArray(payload.roles)) throw new Error("missing roles claim");
      return { subject: payload.sub!, roles: new Set(payload.roles.map(String)) };
    } catch (err) {
      if (err instanceof errors.JWKSTimeout || (err instanceof Error && /fetch failed|ECONNREFUSED/.test(err.message))) {
        throw new HttpProblem(503, "DEPENDENCY_UNAVAILABLE", "Token keys unavailable");
      }
      throw new HttpProblem(401, "UNAUTHENTICATED", "Invalid or expired access token");
    }
  }
}

import { HttpProblem } from "../lib/problem.js";

/**
 * Obtains service tokens from the Auth Service (client-credentials grant) and caches one
 * per target audience until shortly before it expires. Concurrent callers share a single
 * in-flight request instead of stampeding the Auth Service.
 */
export class ServiceTokenProvider {
  private readonly cache = new Map<string, { token: string; refreshAt: number }>();
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(
    private readonly config: { authUrl: string; clientId: string; clientSecret: string | undefined; timeoutMs: number },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async token(audience: string): Promise<string> {
    const cached = this.cache.get(audience);
    if (cached && Date.now() < cached.refreshAt) return cached.token;
    const pending = this.inFlight.get(audience);
    if (pending) return pending;
    const request = this.fetchToken(audience).finally(() => this.inFlight.delete(audience));
    this.inFlight.set(audience, request);
    return request;
  }

  /** Drop a cached token, e.g. after the callee rejected it with 401 (key rotation). */
  invalidate(audience: string): void {
    this.cache.delete(audience);
  }

  private async fetchToken(audience: string): Promise<string> {
    if (!this.config.clientSecret) {
      throw new HttpProblem(503, "DEPENDENCY_UNAVAILABLE", "Service credentials are not configured");
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.authUrl}/internal/v1/auth/service-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: this.config.clientId, clientSecret: this.config.clientSecret, audience }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      throw new HttpProblem(503, "DEPENDENCY_UNAVAILABLE", "Auth Service unreachable", undefined, undefined, { cause: err });
    }
    if (!res.ok) {
      throw new HttpProblem(503, "DEPENDENCY_UNAVAILABLE", `Auth Service refused service token (${res.status})`);
    }
    const body = (await res.json()) as { accessToken: string; expiresIn: number };
    // Refresh a minute early (or at half-life for very short tokens) to avoid using a token that expires mid-request.
    const marginMs = Math.min(60_000, (body.expiresIn * 1000) / 2);
    this.cache.set(audience, { token: body.accessToken, refreshAt: Date.now() + body.expiresIn * 1000 - marginMs });
    return body.accessToken;
  }
}

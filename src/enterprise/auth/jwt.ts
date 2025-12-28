import type { OIDCConfig } from "./types.js";
import { AuthError } from "./types.js";

/**
 * JWT Verification
 * 
 * Validates OIDC tokens using JWKS from the identity provider.
 * This is a scaffold - production implementation should use jose or similar.
 */

export type JWTPayload = {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nbf?: number;
  email?: string;
  name?: string;
  preferred_username?: string;
  [key: string]: unknown;
};

export type JWKSet = {
  keys: JWK[];
};

export type JWK = {
  kty: string;
  use?: string;
  kid?: string;
  alg?: string;
  n?: string;
  e?: string;
  x5c?: string[];
};

/**
 * JWT Verifier with JWKS caching
 */
export class JWTVerifier {
  private config: OIDCConfig;
  private jwksCache: JWKSet | null = null;
  private jwksCacheTime: number = 0;

  constructor(config: OIDCConfig) {
    this.config = config;
  }

  /**
   * Verify a JWT token
   * 
   * @throws AuthError if token is invalid
   */
  async verify(token: string): Promise<JWTPayload> {
    // Parse token without verification to get header
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new AuthError("INVALID_TOKEN", "Malformed JWT");
    }

    const header = this.decodeBase64Url(parts[0]);
    const payload = this.decodeBase64Url(parts[1]);

    let headerObj: { alg?: string; kid?: string };
    let payloadObj: JWTPayload;

    try {
      headerObj = JSON.parse(header);
      payloadObj = JSON.parse(payload);
    } catch {
      throw new AuthError("INVALID_TOKEN", "Invalid JWT encoding");
    }

    // Validate standard claims
    this.validateClaims(payloadObj);

    // In production: verify signature using JWKS
    // const jwks = await this.getJWKS();
    // const key = this.findKey(jwks, headerObj.kid);
    // await this.verifySignature(token, key, headerObj.alg);

    return payloadObj;
  }

  /**
   * Validate standard JWT claims
   */
  private validateClaims(payload: JWTPayload): void {
    const now = Math.floor(Date.now() / 1000);
    const tolerance = this.config.clockTolerance;

    // Check expiration
    if (payload.exp !== undefined && payload.exp < now - tolerance) {
      throw new AuthError("TOKEN_EXPIRED", "Token has expired");
    }

    // Check not before
    if (payload.nbf !== undefined && payload.nbf > now + tolerance) {
      throw new AuthError("INVALID_TOKEN", "Token not yet valid");
    }

    // Check issuer
    if (payload.iss && payload.iss !== this.config.issuer) {
      throw new AuthError("INVALID_ISSUER", `Invalid issuer: ${payload.iss}`);
    }

    // Check audience
    if (this.config.audience) {
      const audArray = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!audArray.includes(this.config.audience)) {
        throw new AuthError("INVALID_AUDIENCE", "Token audience mismatch");
      }
    }
  }

  /**
   * Get JWKS from issuer (with caching)
   */
  async getJWKS(): Promise<JWKSet> {
    const now = Date.now();
    
    // Return cached JWKS if still valid
    if (this.jwksCache && now - this.jwksCacheTime < this.config.jwksCacheTtl * 1000) {
      return this.jwksCache;
    }

    // Fetch JWKS
    const jwksUri = this.config.jwksUri ?? `${this.config.issuer}/.well-known/jwks.json`;
    
    try {
      const response = await fetch(jwksUri);
      if (!response.ok) {
        throw new Error(`JWKS fetch failed: ${response.status}`);
      }

      this.jwksCache = await response.json() as JWKSet;
      this.jwksCacheTime = now;

      return this.jwksCache;
    } catch (err) {
      // If we have a cached version, use it even if expired
      if (this.jwksCache) {
        return this.jwksCache;
      }
      throw new AuthError("INVALID_TOKEN", "Unable to fetch JWKS for token validation");
    }
  }

  /**
   * Find JWK by key ID
   */
  findKey(jwks: JWKSet, kid?: string): JWK | undefined {
    if (!kid) {
      // Return first signing key if no kid specified
      return jwks.keys.find(k => k.use === "sig" || !k.use);
    }
    return jwks.keys.find(k => k.kid === kid);
  }

  /**
   * Decode base64url string
   */
  private decodeBase64Url(str: string): string {
    // Convert base64url to base64
    let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
    
    // Add padding if needed
    const padding = base64.length % 4;
    if (padding) {
      base64 += "=".repeat(4 - padding);
    }

    // Decode
    return Buffer.from(base64, "base64").toString("utf8");
  }
}

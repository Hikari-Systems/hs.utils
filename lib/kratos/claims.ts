// Helpers for reading namespaced custom claims that hs-login-controller's
// consent app injects into Hydra-issued JWTs / userinfo responses.
//
// The consent app emits four namespaced claims off Kratos identity traits +
// metadata_public:
//   ${ns}email      ← traits.email
//   ${ns}name       ← traits.name
//   ${ns}pictureId  ← traits.pictureId  (image-service UUID)
//   ${ns}terms      ← metadata_public.terms  ({version, accepted_at})
//
// Both the cookie-session authorizeKratosMiddleware and the MCP
// createKratosUserResolver use this to derive a user profile.

export const DEFAULT_CLAIMS_NAMESPACE = 'https://hikari-systems.com/';

export type KratosTermsClaim = {
  version?: string;
  accepted_at?: string;
} | null;

export type KratosClaimProfile = {
  email?: string;
  name?: string;
  pictureImageServiceId?: string;
  termsVersion?: string;
  termsAcceptedAt?: string;
};

const stringClaim = (
  payload: Record<string, unknown>,
  key: string,
): string | undefined => {
  const v = payload[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
};

const termsClaim = (
  payload: Record<string, unknown>,
  key: string,
): KratosTermsClaim => {
  const v = payload[key];
  if (!v || typeof v !== 'object') return null;
  const obj = v as Record<string, unknown>;
  const version = typeof obj.version === 'string' ? obj.version : undefined;
  const acceptedAt =
    typeof obj.accepted_at === 'string' ? obj.accepted_at : undefined;
  if (!version && !acceptedAt) return null;
  return { version, accepted_at: acceptedAt };
};

// Pull namespaced Kratos claims off any payload-shaped object (a JWT
// payload, a userinfo response, etc.). Returns undefined fields when
// the corresponding claim is absent or empty — callers can then decide
// whether to fall back to a Kratos admin lookup.
export const readKratosClaims = (
  payload: Record<string, unknown> | undefined | null,
  claimsNamespace: string = DEFAULT_CLAIMS_NAMESPACE,
): KratosClaimProfile => {
  if (!payload) return {};
  const ns = claimsNamespace;
  const terms = termsClaim(payload, `${ns}terms`);
  return {
    email: stringClaim(payload, `${ns}email`),
    name: stringClaim(payload, `${ns}name`),
    pictureImageServiceId: stringClaim(payload, `${ns}pictureId`),
    termsVersion: terms?.version,
    termsAcceptedAt: terms?.accepted_at,
  };
};

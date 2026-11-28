/**
 * The one issuer normalisation of the OIDC client and the SSO identity
 * binding: the exact string after removing trailing slashes. No case folding
 * and no URL parsing; a query or fragment is kept as is.
 */
export function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, "");
}

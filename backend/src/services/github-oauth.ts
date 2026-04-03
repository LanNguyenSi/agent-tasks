/**
 * GitHub OAuth service
 *
 * Handles the GitHub OAuth2 flow:
 * 1. Build the authorization URL
 * 2. Exchange authorization code for access token
 * 3. Fetch the authenticated GitHub user
 */

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  email: string | null;
}

export interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}

/** Build the GitHub OAuth authorization URL */
export function buildAuthorizationUrl(config: OAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    scope: "read:user user:email read:org",
    state,
    ...(config.redirectUri ? { redirect_uri: config.redirectUri } : {}),
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/** Exchange OAuth authorization code for access token */
export async function exchangeCodeForToken(
  config: OAuthConfig,
  code: string,
): Promise<GitHubTokenResponse> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      ...(config.redirectUri ? { redirect_uri: config.redirectUri } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub token exchange failed: ${response.statusText}`);
  }

  const data = (await response.json()) as GitHubTokenResponse & { error?: string };
  if (data.error) {
    throw new Error(`GitHub OAuth error: ${data.error}`);
  }

  return data;
}

/** Fetch the authenticated GitHub user's profile */
export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub user fetch failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<GitHubUser>;
}

/** Generate a cryptographically random OAuth state token */
export function generateState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

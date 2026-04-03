import { config } from "../config/index.js";

export function buildGitHubAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.GITHUB_CLIENT_ID,
    scope: "read:user user:email",
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

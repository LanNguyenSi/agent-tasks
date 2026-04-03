export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  archived: boolean;
  disabled: boolean;
}

export async function listUserRepos(accessToken: string): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = [];

  for (let page = 1; page <= 5; page += 1) {
    const response = await fetch(
      `https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated&direction=desc`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch GitHub repositories (${response.status})`);
    }

    const pageRepos = (await response.json()) as GitHubRepo[];
    repos.push(...pageRepos.filter((repo) => !repo.archived && !repo.disabled));

    if (pageRepos.length < 100) {
      break;
    }
  }

  return repos;
}

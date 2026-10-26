// Hub root for /projects/[id]: the Overview tab is gone, so every link that
// named the hub root (e.g. projectHubHref(id) without a tab) lands on the
// board. The query is forwarded unchanged (e.g. ?taskId= opens the task
// modal on the board); repeated parameters keep their order and values.
// Authorisation is not this page's concern: the hub layout handles a missing
// or inaccessible project exactly as it does on the board.

import { redirect } from "next/navigation";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ProjectHubRootPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) query.append(key, v);
  }
  const qs = query.toString();
  redirect(`/projects/${id}/board${qs ? `?${qs}` : ""}`);
}

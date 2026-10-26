import { redirect } from "next/navigation";
import { teamSettingsHref } from "../../../lib/routes";

export default function TeamsTokensRedirectPage() {
  redirect(teamSettingsHref());
}

import { redirect } from "next/navigation";

export function GET() {
  const apiUrl = process.env.API_URL ?? "http://localhost:3001";
  redirect(`${apiUrl}/api/auth/github/connect`);
}

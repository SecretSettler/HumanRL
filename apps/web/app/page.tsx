import { redirect } from "next/navigation";

/** The trace list is the entry surface; there is no separate landing page. */
export default function HomePage() {
  redirect("/traces");
}

import { redirect } from "next/navigation";

/**
 * Profit Intelligence became Profit Opportunities on 2026-09-25. Kept so old
 * links, bookmarks and emails still land somewhere.
 */
export default function IntelligencePage() {
  redirect("/dashboard/opportunities");
}

"use client";

import { useRouter } from "next/navigation";

/** There was previously no way to log out from the UI at all - added here as
 * part of the new persistent dashboard nav. */
export default function LogoutButton() {
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <button onClick={logout} className="text-sm text-gray-500 hover:text-navy">
      Log out
    </button>
  );
}

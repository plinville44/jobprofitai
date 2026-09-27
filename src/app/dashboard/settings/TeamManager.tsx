"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Row {
  id: string;
  email: string;
  name: string | null;
  status: "active" | "invited" | "expired";
  invitedAt: string;
  /** Client logins: the company they see, and its name. */
  connectionId?: string | null;
  companyName?: string | null;
}

const STATUS_LABEL: Record<Row["status"], string> = {
  active: "Active",
  invited: "Invited",
  expired: "Invitation expired",
};

export default function TeamManager({
  rows,
  canInvite,
  companies,
}: {
  rows: Row[];
  canInvite: boolean;
  /** Set for client logins: the companies a client login can be for. */
  companies?: { id: string; name: string }[];
}) {
  const router = useRouter();
  const clientMode = companies != null;
  const [email, setEmail] = useState("");
  const [companyId, setCompanyId] = useState(companies?.[0]?.id ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  async function invite(address: string, forCompany?: string | null) {
    setBusy(address);
    setStatus(null);
    try {
      const res = await fetch("/api/team/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(clientMode ? { email: address, clientConnectionId: forCompany ?? companyId } : { email: address }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Server returned status ${res.status}.`);
      setStatus({ ok: true, message: `Invitation sent to ${address}.` });
      setEmail("");
      router.refresh();
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Couldn't send the invitation." });
    } finally {
      setBusy(null);
    }
  }

  async function remove(row: Row) {
    const question =
      row.status === "active"
        ? `Remove ${row.email}? They'll be signed out and lose access straight away.`
        : `Cancel the invitation to ${row.email}?`;
    if (!window.confirm(question)) return;
    setBusy(row.id);
    setStatus(null);
    try {
      const res = await fetch("/api/team/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Server returned status ${res.status}.`);
      router.refresh();
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Couldn't remove them." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-4">
      {rows.length > 0 && (
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <div>
                <p className="font-medium text-navy">{row.name ?? row.email}</p>
                {row.name && <p className="text-xs text-gray-500">{row.email}</p>}
                {clientMode && <p className="text-xs text-gray-500">Sees {row.companyName ?? "a company no longer connected"}</p>}
                <p className={`text-xs ${row.status === "active" ? "text-green-700" : "text-gray-500"}`}>
                  {STATUS_LABEL[row.status]}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {row.status !== "active" && canInvite && (
                  <button
                    onClick={() => invite(row.email, row.connectionId)}
                    disabled={busy !== null}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                  >
                    Resend
                  </button>
                )}
                <button
                  onClick={() => remove(row)}
                  disabled={busy !== null}
                  className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-60"
                >
                  {row.status === "active" ? "Remove" : "Cancel"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {canInvite ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) invite(email.trim());
          }}
          className="mt-4 flex flex-wrap items-end gap-2"
        >
          {clientMode && (
            <label>
              <span className="block text-sm font-medium text-navy">Company</span>
              <select
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
                className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
              >
                {companies!.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex-1">
            <span className="block text-sm font-medium text-navy">{clientMode ? "Client's email" : "Invite by email"}</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={clientMode ? "owner@clientcompany.com" : "office@yourcompany.com"}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={busy !== null}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {busy === email.trim() ? "Sending…" : "Send invitation"}
          </button>
        </form>
      ) : (
        clientMode ? null : <p className="mt-4 text-sm text-gray-500">Choose a plan to add team members.</p>
      )}
      {status && <p className={`mt-3 text-sm ${status.ok ? "text-green-700" : "text-red-600"}`}>{status.message}</p>}
    </div>
  );
}

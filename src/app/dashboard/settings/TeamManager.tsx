"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  COMPANY_FILTER_THRESHOLD,
  defaultInviteCompanyId,
  filterCompanies,
  sortCompaniesByName,
} from "@/lib/companyPicker";

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
  activeCompanyId = null,
}: {
  rows: Row[];
  canInvite: boolean;
  /** Set for client logins: the companies a client login can be for. */
  companies?: { id: string; name: string }[];
  /** Client logins: the company on screen, which the form starts on. */
  activeCompanyId?: string | null;
}) {
  const router = useRouter();
  const clientMode = companies != null;
  const sortedCompanies = useMemo(() => sortCompaniesByName(companies ?? []), [companies]);
  const [email, setEmail] = useState("");
  // The company on screen, never simply the first one connected: sending a
  // client a login to the wrong company shows them another client's books.
  const [companyId, setCompanyId] = useState(() => defaultInviteCompanyId(companies ?? [], activeCompanyId));
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const companyName = sortedCompanies.find((c) => c.id === companyId)?.name ?? "this company";
  const shownCompanies = filterCompanies(sortedCompanies, filter, companyId);

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
        ? `Remove ${row.email}? They'll be signed out, lose access straight away, and come off every company's Weekly Profit Brief and alert emails.`
        : `Cancel the invitation to ${row.email}? The address also comes off every company's Weekly Profit Brief and alert emails.`;
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
                {/* A client invitation is only re-sent to its own company, never
                    to whichever one the form below has selected. */}
                {row.status !== "active" && canInvite && (!clientMode || row.connectionId) && (
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
            const address = email.trim();
            if (!address) return;
            // A client login shows that company's books, so say which one
            // before anything is sent.
            if (
              clientMode &&
              !window.confirm(
                `Send ${address} a view-only login to ${companyName}? They'll see ${companyName}'s jobs and figures, and nothing else on your account.`
              )
            ) {
              return;
            }
            invite(address);
          }}
          className="mt-4 flex flex-wrap items-end gap-2"
        >
          {clientMode && sortedCompanies.length > COMPANY_FILTER_THRESHOLD && (
            <label>
              <span className="block text-sm font-medium text-navy">Find a company</span>
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Type part of a name"
                className="mt-1 w-44 rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
          )}
          {clientMode && (
            <label>
              <span className="block text-sm font-medium text-navy">Company</span>
              <select
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
                className="mt-1 max-w-[16rem] rounded-lg border border-gray-300 px-3 py-2 text-sm"
              >
                {shownCompanies.map((c) => (
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
            {busy === email.trim() ? "Sending…" : clientMode ? `Invite to ${companyName}` : "Send invitation"}
          </button>
        </form>
      ) : (
        clientMode ? null : <p className="mt-4 text-sm text-gray-500">Choose a plan to add team members.</p>
      )}
      {status && <p className={`mt-3 text-sm ${status.ok ? "text-green-700" : "text-red-600"}`}>{status.message}</p>}
    </div>
  );
}

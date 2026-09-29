import { describe, expect, it, vi, beforeEach } from "vitest";

// The route's collaborators, stood in for: who is signed in, which
// companies they may see, and the bits of next/server the route uses.
const state: { account: { ownerId: string; role: string; connectionId: string | null } | null; visible: string[] } = {
  account: null,
  visible: [],
};
vi.mock("@/lib/account", () => ({
  ACTIVE_COMPANY_COOKIE: "jpai_company",
  getAccount: async () => state.account,
  connectionForAccount: async (_account: unknown, id: unknown) =>
    typeof id === "string" && state.visible.includes(id) ? { id, userId: "owner" } : null,
}));
vi.mock("next/server", () => ({
  NextResponse: {
    redirect: (url: URL, status: number) => {
      const cookies: Record<string, string> = {};
      const headers = new Map<string, string>();
      return {
        status,
        location: url.toString(),
        headers: { set: (k: string, v: string) => headers.set(k, v), get: (k: string) => headers.get(k) },
        cookies: { set: (name: string, value: string) => (cookies[name] = value), all: cookies },
      };
    },
  },
}));

import { companyOpenPath, safeDashboardPath } from "../companyLinks";
import { GET } from "../../app/api/company/open/route";

describe("safeDashboardPath", () => {
  it("keeps a page under /dashboard, with its query and anchor", () => {
    expect(safeDashboardPath("/dashboard")).toBe("/dashboard");
    expect(safeDashboardPath("/dashboard/settings")).toBe("/dashboard/settings");
    expect(safeDashboardPath("/dashboard/jobs/abc?tab=costs#history")).toBe("/dashboard/jobs/abc?tab=costs#history");
    expect(safeDashboardPath("/dashboard/opportunities#job_type_pricing%3Aremodel")).toBe("/dashboard/opportunities#job_type_pricing%3Aremodel");
  });

  it("turns anything else into the dashboard, so the link can't send anyone to another site", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "dashboard",
      "https://evil.example/dashboard",
      "//evil.example/dashboard",
      "/\\evil.example",
      "\\\\evil.example",
      "/\t/evil.example",
      "/dashboard/../api/brief/unsubscribe",
      "/dashboardx",
      "/login",
      "javascript:alert(1)",
      "/.//evil.example",
    ]) {
      expect(safeDashboardPath(bad)).toBe("/dashboard");
    }
  });

  it("gets back exactly the page it was given, through the email link", () => {
    const next = "/dashboard/opportunities#job_type_pricing%3Aremodel";
    const url = new URL(companyOpenPath("c 1", next), "https://jobprofitai.com");
    expect(url.pathname).toBe("/api/company/open");
    expect(url.searchParams.get("company")).toBe("c 1");
    expect(safeDashboardPath(url.searchParams.get("next"))).toBe(next);
  });
});

describe("GET /api/company/open", () => {
  const call = async (query: string) => {
    const res = (await GET({ nextUrl: new URL(`https://jobprofitai.com/api/company/open${query}`) } as never)) as unknown as {
      status: number;
      location: string;
      cookies: { all: Record<string, string> };
    };
    return { status: res.status, to: res.location, cookie: res.cookies.all.jpai_company };
  };

  beforeEach(() => {
    state.account = { ownerId: "owner", role: "owner", connectionId: null };
    state.visible = ["c1", "c2"];
  });

  it("switches to the email's company, then opens the page", async () => {
    const r = await call(`?company=c2&next=${encodeURIComponent("/dashboard/settings")}`);
    expect(r.to).toBe("https://jobprofitai.com/dashboard/settings");
    expect(r.cookie).toBe("c2");
  });

  it("never redirects off the dashboard, whatever next says", async () => {
    for (const next of ["https://evil.example/", "//evil.example", "/api/account/delete", "/dashboard/../login"]) {
      const r = await call(`?company=c1&next=${encodeURIComponent(next)}`);
      expect(r.to).toBe("https://jobprofitai.com/dashboard");
    }
  });

  it("switches nothing for a company this login can't see", async () => {
    const r = await call(`?company=someone-elses&next=${encodeURIComponent("/dashboard/settings")}`);
    expect(r.to).toBe("https://jobprofitai.com/dashboard");
    expect(r.cookie).toBeUndefined();
  });

  it("sends someone not signed in to log in, and back here afterwards", async () => {
    state.account = null;
    const r = await call(`?company=c2&next=${encodeURIComponent("/dashboard/settings")}`);
    const url = new URL(r.to);
    expect(url.origin + url.pathname).toBe("https://jobprofitai.com/login");
    expect(url.searchParams.get("next")).toBe(companyOpenPath("c2", "/dashboard/settings"));
    expect(r.cookie).toBeUndefined();
  });
});

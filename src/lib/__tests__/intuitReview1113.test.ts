import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { createFakePrisma, type FakePrisma } from "./support/fakePrisma";

// Intuit's technical review call, Nov 13, 2026:
//  a) only Intuit's current Connect to QuickBooks button starts an OAuth
//     connection, hidden behind "Add company" once a company is connected
//     (requirement 6.2);
//  c) Intuit's current Sign in with Intuit button, on the login page only;
//  d) disconnecting from the QuickBooks App Store lands back in the app
//     signed in, with no password or consent screen (requirement 4.4).

const fake: { client: FakePrisma } = { client: createFakePrisma() };
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));

const intuit = { userinfo: null as unknown, fail: false, scopes: [] as string[] };
vi.mock("@/lib/quickbooks", () => ({
  CONNECT_WITH_OPENID_SCOPES: "com.intuit.quickbooks.accounting openid profile email",
  buildAuthorizeUrl: async (state: string, scope = "com.intuit.quickbooks.accounting") => {
    intuit.scopes.push(scope);
    return `https://intuit.example/authorize?scope=${encodeURIComponent(scope)}&state=${state}`;
  },
  fetchIntuitUserInfo: async () => {
    if (intuit.fail) throw new Error("Intuit userinfo failed with status 500 (intuit_tid: t-1)");
    return intuit.userinfo;
  },
}));

const mail: { to: string; subject: string; text: string }[] = [];
vi.mock("@/lib/email/client", () => ({
  SUPPORT_EMAIL: "support@jobprofitai.com",
  sendEmail: async (m: { to: string; subject: string; text: string }) => {
    mail.push(m);
    return { ok: true };
  },
}));

const session = { account: null as null | { userId: string; ownerId: string; role: string; connectionId?: string | null } };
const companies = { list: [] as { id: string; realmIdHash: string; companyName: string | null }[] };
vi.mock("@/lib/account", () => ({
  getAccount: async () => session.account,
  listCompanies: async () => companies.list,
}));
// What Intuit says about each company when the Disconnect URL's page checks it.
const probes: Record<string, "ok" | "revoked" | "unknown"> = {};
vi.mock("@/lib/quickbooksSync", () => ({ probeConnection: async (id: string) => probes[id] ?? "unknown" }));
vi.mock("@/lib/crypto", () => ({ hashRealmId: (r: string) => `h:${r}`, legacyHashRealmId: (r: string) => `l:${r}` }));
vi.mock("@/components/marketing/Logo", () => ({ LogoLink: () => null }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  },
}));
vi.mock("@/lib/entitlements", () => ({
  canConnectAnotherCompany: async () => ({ allowed: true }),
  getEntitlements: async () => ({ plan: "profit_intelligence" }),
}));
vi.mock("@/lib/connectCompany", () => ({ connectNeedsOwner: () => false, OWNER_ONLY_CONNECT_NOTICE: "owner_only_connect" }));
vi.mock("next/server", () => ({
  NextResponse: { redirect: (url: URL | string) => ({ kind: "redirect", url: String(url) }) },
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AddCompanyButton, ConnectToQuickBooksButton, SignInWithIntuitButton } from "@/components/IntuitButtons";
import { intuitLinkedEmail } from "../email/templates";
import { linkIntuitOnConnect } from "../intuitConnectLink";
import { ACCEPTANCE_VERSION, LEGAL_UPDATED, legalDateKey } from "../legalVersion";
import { GET as connect } from "../../app/api/quickbooks/connect/route";
import DisconnectedPage from "../../app/quickbooks/disconnected/page";

const SRC = join(__dirname, "..", "..");
const ROOT = join(SRC, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const flat = (rel: string) => read(rel).replace(/\s+/g, " ");
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Every source file outside the tests, relative to src/, with forward slashes on Windows too. */
function sourceFiles(dir = SRC, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "__tests__" && name !== "node_modules") sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full.slice(SRC.length + 1).replace(/\\/g, "/"));
    }
  }
  return out;
}

describe("a and c. Intuit's current button files, unchanged", () => {
  // SHA-256 of the files in Intuit's Connect_to_QuickBooks_buttons.zip and
  // Sign_in_with_Intuit_buttons.zip (Connect_to_QuickBooks_English/..._SVG
  // and Sign_in_with_Intuit_SVG), as sent by Intuit's reviewer.
  const INTUIT_FILES: Record<string, string> = {
    "C2QB_green_btn_tall_default.svg": "7feb6af9992966c8ab6bf8369b076aaec4ad9f55413a066d840c3073ec845ab8",
    "C2QB_green_btn_tall_hover.svg": "0b7fd52dd2287ca94d791e419670a8fb3458e038f8373b31c7e3b3820a236784",
    "Sign_in_blue_btn_tall_default.svg": "2415eb8fbb655d77f64c4e00599640979d20f7d53917e4f79f9b1b73785f8ab6",
    "Sign_in_blue_btn_tall_hover.svg": "4c77775d1f82c1b547db5eb3d6235f431998aaf6945c146f51daa46091d13214",
  };

  it("serves Intuit's own files byte for byte, and nothing else in public/intuit", () => {
    const dir = join(ROOT, "public", "intuit");
    expect(readdirSync(dir).sort()).toEqual(Object.keys(INTUIT_FILES).sort());
    for (const [name, hash] of Object.entries(INTUIT_FILES)) {
      expect({ name, hash: sha256(join(dir, name)) }).toEqual({ name, hash });
    }
    // The images turned down in review are gone.
    expect(existsSync(join(dir, "connect-to-quickbooks.png"))).toBe(false);
    expect(existsSync(join(dir, "sign-in-with-intuit.png"))).toBe(false);
    // Kept as Intuit supplies them on a Windows checkout too.
    expect(readFileSync(join(ROOT, ".gitattributes"), "utf8")).toContain("public/intuit/* -text");
  });

  it("draws Connect to QuickBooks as Intuit's green button, with its hover file, and the whole of it is the link", () => {
    const html = renderToStaticMarkup(createElement(ConnectToQuickBooksButton));
    expect(html).toContain('href="/api/quickbooks/connect"');
    expect(html).toContain('src="/intuit/C2QB_green_btn_tall_default.svg" alt="Connect to QuickBooks" width="274" height="48"');
    expect(html).toContain('src="/intuit/C2QB_green_btn_tall_hover.svg" alt="" aria-hidden="true" width="274" height="48"');
    expect(html).not.toContain(".png");
    const reconnect = renderToStaticMarkup(createElement(ConnectToQuickBooksButton, { href: "/api/quickbooks/connect?reconnect=c1" }));
    expect(reconnect).toContain('href="/api/quickbooks/connect?reconnect=c1"');
  });

  it("draws Sign in with Intuit as Intuit's blue button, opening Intuit's OpenID sign-in", () => {
    const html = renderToStaticMarkup(createElement(SignInWithIntuitButton));
    expect(html).toContain('href="/api/auth/intuit?intent=signin"');
    expect(html).toContain('src="/intuit/Sign_in_blue_btn_tall_default.svg" alt="Sign in with Intuit" width="201" height="48"');
    expect(html).toContain('src="/intuit/Sign_in_blue_btn_tall_hover.svg"');
  });
});

describe("a. only the Connect to QuickBooks button starts a connection", () => {
  it("links to /api/quickbooks/connect nowhere else (the reconnect link goes into the same button)", () => {
    const found: string[] = [];
    for (const f of sourceFiles()) {
      if (f === "components/IntuitButtons.tsx" || f === "app/api/quickbooks/connect/route.ts") continue;
      read(f)
        .split("\n")
        .forEach((line, i) => {
          if (!line.includes("/api/quickbooks/connect")) return;
          if (/^\s*(\*|\/\/)/.test(line)) return; // a comment
          found.push(`${f}:${i + 1}: ${line.trim()}`);
        });
    }
    for (const line of found) {
      expect({ line, viaButton: line.includes("<ConnectToQuickBooksButton href={`/api/quickbooks/connect?reconnect=") }).toEqual({
        line,
        viaButton: true,
      });
    }
    // The App Store flow starts only from Intuit's App Store (the portal's Connect/Reconnect URL).
    for (const f of sourceFiles()) {
      if (f.startsWith("app/api/") || f.startsWith("lib/")) continue;
      expect({ f, appstoreLink: read(f).includes("intent=appstore") }).toEqual({ f, appstoreLink: false });
    }
  });

  it("6.2: with a company connected, Settings shows Add company, and Connect only once it's clicked", () => {
    const settings = flat("app/dashboard/settings/page.tsx");
    expect(settings).toContain("<AddCompanyButton />");
    expect(settings).not.toContain("Add another company");
    // Before the click: a plain button, no Connect image or connect link.
    const closed = renderToStaticMarkup(createElement(AddCompanyButton));
    expect(closed).toContain(">Add company</button>");
    expect(closed).not.toContain("/api/quickbooks/connect");
    expect(closed).not.toContain("C2QB_");
    // The click opens Connect to QuickBooks with a way to cancel.
    const component = flat("components/IntuitButtons.tsx");
    expect(component).toContain("const [open, setOpen] = useState(false);");
    expect(component).toContain("onClick={() => setOpen(true)}");
    expect(component).toContain("<ConnectToQuickBooksButton /> <button type=\"button\" onClick={() => setOpen(false)}");
    // With nothing connected, Settings and the dashboard show Connect as is.
    expect(settings).toContain("Connect your QuickBooks Online company to configure settings.");
    expect(flat("app/dashboard/page.tsx")).toContain("<ConnectToQuickBooksButton />");
  });
});

describe("c. Sign in with Intuit is on the login page only", () => {
  it("is used by app/login/page.tsx and nothing else", () => {
    const users = sourceFiles().filter((f) => f !== "components/IntuitButtons.tsx" && read(f).includes("<SignInWithIntuitButton"));
    expect(users).toEqual(["app/login/page.tsx"]);
    expect(flat("app/signup/SignupForm.tsx")).not.toContain("IntuitButtons");
  });

  it("isn't linked by hand anywhere: the only other Intuit sign-in start is the Disconnect page's redirect", () => {
    const starts = sourceFiles().filter(
      (f) => !f.startsWith("app/api/") && !f.startsWith("lib/") && f !== "components/IntuitButtons.tsx" && /\/api\/auth\/intuit\?/.test(read(f))
    );
    expect(starts).toEqual(["app/quickbooks/disconnected/page.tsx"]);
    const page = flat("app/quickbooks/disconnected/page.tsx");
    expect(page).toContain("redirect(`/api/auth/intuit?${query.toString()}`);");
    // Signed out after Intuit's sign-in didn't take: a link to the login page, not a second Intuit button.
    expect(page).toContain('href="/login"');
    expect(page).toContain("Log in to JobProfitAI");
  });
});

describe("d. connecting QuickBooks makes the Disconnect URL's Intuit sign-in ask nothing", () => {
  beforeEach(() => {
    fake.client = createFakePrisma();
    intuit.userinfo = null;
    intuit.fail = false;
    intuit.scopes = [];
    mail.length = 0;
    process.env.AUTH_SECRET = "test-secret-intuit-1113";
    process.env.APP_URL = "https://app.example.com";
  });

  it("asks Intuit for QuickBooks access and the OpenID scopes, on the one consent screen", async () => {
    session.account = { userId: "u1", ownerId: "u1", role: "owner" };
    const res: any = await connect({ url: "https://app.example.com/api/quickbooks/connect" } as never);
    expect(intuit.scopes).toEqual(["com.intuit.quickbooks.accounting openid profile email"]);
    expect(new URL(res.url).searchParams.get("scope")).toBe("com.intuit.quickbooks.accounting openid profile email");
  });

  it("links the Intuit account to the login when Intuit verified the same email, and says so by email", async () => {
    await fake.client.user.create({ data: { id: "u1", email: "pat@builder.com", intuitSub: null } });
    intuit.userinfo = { sub: "intuit-1", email: "pat@builder.com", emailVerified: true, givenName: "Pat", familyName: null };
    expect(await linkIntuitOnConnect("u1", "at")).toBe("linked");
    expect((await fake.client.user.findUnique({ where: { id: "u1" } }))?.intuitSub).toBe("intuit-1");
    expect(mail).toHaveLength(1);
    expect(mail[0].to).toBe("pat@builder.com");
    expect(mail[0].subject).toBe("Sign in with Intuit was turned on for your JobProfitAI login");
    expect(mail[0].text).toContain("You just connected QuickBooks with an Intuit account that has the same email address");
  });

  it("matches the address ignoring case", async () => {
    await fake.client.user.create({ data: { id: "u1", email: "Pat@Builder.com", intuitSub: null } });
    intuit.userinfo = { sub: "intuit-1", email: "pat@builder.com", emailVerified: true, givenName: null, familyName: null };
    expect(await linkIntuitOnConnect("u1", "at")).toBe("linked");
  });

  it("links nothing for someone else's Intuit login, an unverified address, a login already linked, or an Intuit account another login has", async () => {
    await fake.client.user.create({ data: { id: "u1", email: "bookkeeper@firm.com", intuitSub: null } });
    intuit.userinfo = { sub: "client-owner", email: "owner@client.com", emailVerified: true, givenName: null, familyName: null };
    expect(await linkIntuitOnConnect("u1", "at")).toBe("skipped");

    intuit.userinfo = { sub: "intuit-2", email: "bookkeeper@firm.com", emailVerified: false, givenName: null, familyName: null };
    expect(await linkIntuitOnConnect("u1", "at")).toBe("skipped");

    await fake.client.user.create({ data: { id: "u2", email: "sam@builder.com", intuitSub: "intuit-old" } });
    intuit.userinfo = { sub: "intuit-new", email: "sam@builder.com", emailVerified: true, givenName: null, familyName: null };
    expect(await linkIntuitOnConnect("u2", "at")).toBe("skipped");
    expect((await fake.client.user.findUnique({ where: { id: "u2" } }))?.intuitSub).toBe("intuit-old");

    await fake.client.user.create({ data: { id: "u3", email: "lee@builder.com", intuitSub: null } });
    intuit.userinfo = { sub: "intuit-old", email: "lee@builder.com", emailVerified: true, givenName: null, familyName: null };
    expect(await linkIntuitOnConnect("u3", "at")).toBe("skipped");

    expect((await fake.client.user.findUnique({ where: { id: "u1" } }))?.intuitSub ?? null).toBeNull();
    expect((await fake.client.user.findUnique({ where: { id: "u3" } }))?.intuitSub ?? null).toBeNull();
    expect(mail).toHaveLength(0);
  });

  it("never throws or holds up the connection when Intuit's userinfo fails", async () => {
    await fake.client.user.create({ data: { id: "u1", email: "pat@builder.com", intuitSub: null } });
    intuit.fail = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await linkIntuitOnConnect("u1", "at")).toBe("skipped");
    errors.mockRestore();
    expect(await linkIntuitOnConnect("nobody", "at")).toBe("skipped");
  });

  it("runs in the callback once the company is saved, before the redirect back", () => {
    const route = flat("app/api/quickbooks/callback/route.ts");
    const attach = route.indexOf("const result = await attachCompany(");
    const link = route.indexOf("await linkIntuitOnConnect(actorId, tokens.access_token);");
    const back = route.indexOf('const res = found("/dashboard?qbo_connected=1");');
    expect(attach).toBeGreaterThan(-1);
    expect(link).toBeGreaterThan(attach);
    expect(back).toBeGreaterThan(link);
  });

  it("keeps the usual Intuit-linked email for the other ways of linking", () => {
    expect(intuitLinkedEmail().text).toContain("An Intuit account was just linked to your JobProfitAI login");
    expect(flat("app/api/auth/intuit/link/route.ts")).toContain("...intuitLinkedEmail() })");
  });
});

describe("d. the Disconnect URL lands inside the app, with Connect to QuickBooks showing", () => {
  const open = (params: Record<string, string>) => DisconnectedPage({ searchParams: Promise.resolve(params) } as never);
  beforeEach(() => {
    for (const k of Object.keys(probes)) delete probes[k];
    companies.list = [{ id: "c1", realmIdHash: "h:9130354", companyName: "JobProfitAI Test Co." }];
  });

  it("signed in: checks the company with Intuit, then opens the dashboard and its disconnect notice", async () => {
    session.account = { userId: "u1", ownerId: "u1", role: "owner", connectionId: null };
    probes.c1 = "revoked";
    await expect(open({ realmId: "9130354", sso: "1" })).rejects.toMatchObject({ url: "/dashboard?qbo_disconnected=1" });
    // Intuit slow to answer: still into the app, where Connect to QuickBooks shows.
    probes.c1 = "unknown";
    await expect(open({ realmId: "9130354" })).rejects.toMatchObject({ url: "/dashboard?qbo_disconnected=1" });
    // Nothing connected any more: the same.
    companies.list = [];
    await expect(open({})).rejects.toMatchObject({ url: "/dashboard?qbo_disconnected=1" });
  });

  it("an old link while everything is still connected opens the dashboard without the notice", async () => {
    session.account = { userId: "u1", ownerId: "u1", role: "owner", connectionId: null };
    probes.c1 = "ok";
    await expect(open({})).rejects.toMatchObject({ url: "/dashboard" });
  });

  it("signed out: Intuit's sign-in first, and only after one that didn't take, a page with a login link", async () => {
    session.account = null;
    await expect(open({ realmId: "9130354" })).rejects.toMatchObject({ url: "/api/auth/intuit?intent=disconnected&realmId=9130354" });
    const html = renderToStaticMarkup((await open({ sso: "1" })) as never);
    expect(html).toContain("JobProfitAI is disconnected from QuickBooks");
    expect(html).toContain('href="/login"');
    expect(html).not.toContain("C2QB_");
  });

  it("the dashboard says what was disconnected and shows Connect to QuickBooks", () => {
    const page = flat("app/dashboard/page.tsx");
    expect(page).toContain("qbo_disconnected?: string;");
    expect(page).toContain("{searchParams.qbo_disconnected && (");
    // Names only from this account's own rows disconnected in the last hour, never from the address.
    expect(page).toContain("where: { userId: account.ownerId, disconnectedAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) } },");
    // Other companies still connected: Add company, which reveals Connect (1.1 and 6.2). None left: the box below has Connect.
    expect(page).toContain("{!viewOnly && connections.length > 0 ? ( <div className=\"mt-3\"> <AddCompanyButton /> </div> ) : null}");
    expect(page).toContain("Connect your QuickBooks Online company to see your job profitability.");
  });
});

describe("1.4. QuickBooks and Intuit keep their own capitalization", () => {
  it("are never inside an element set in capitals", () => {
    const found: string[] = [];
    for (const f of sourceFiles().filter((f) => f.endsWith(".tsx"))) {
      const s = read(f);
      for (const m of s.matchAll(/className="[^"]*\buppercase\b[^"]*"/g)) {
        const open = s.lastIndexOf("<", m.index!);
        const tag = /^<(\w+)/.exec(s.slice(open))?.[1];
        if (!tag) continue;
        const close = s.indexOf(`</${tag}>`, m.index!);
        const body = s.slice(m.index!, close > 0 ? close : m.index! + 800);
        if (/QuickBooks|Intuit/.test(body)) found.push(`${f}: ${body.replace(/\s+/g, " ").slice(0, 100)}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("an eyebrow naming QuickBooks or Intuit isn't set in capitals; others still are", async () => {
    const { Eyebrow } = await import("@/components/marketing/ui");
    const qb = renderToStaticMarkup(createElement(Eyebrow, null, "Works with QuickBooks"));
    expect(qb).not.toContain("uppercase");
    expect(qb).toContain(">Works with QuickBooks</p>");
    expect(renderToStaticMarkup(createElement(Eyebrow, null, "What to change"))).toContain("uppercase");
  });

  it("no misspelling or abbreviation in the text people see", () => {
    for (const f of sourceFiles()) {
      const text = read(f)
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|import )/.test(l))
        .join("\n");
      expect({ f, misspelled: /Quickbooks|Quick Books|QuickBook\b/.test(text) }).toEqual({ f, misspelled: false });
      // "QBO" and "QB" only as parts of code names (QBO_SCOPE, qboCompanyInfo), never as words in quotes or text.
      expect({ f, abbreviated: /["'`>][^"'`<\n]*\bQBO?\b[^"'`<\n]*["'`<]/.test(text) }).toEqual({ f, abbreviated: false });
    }
  });
});

describe("what the pages say about it", () => {
  const privacySentence =
    "Intuit tells us the same when you connect a QuickBooks company. If Intuit has verified that the Intuit account&rsquo;s email address is your login&rsquo;s, we store its ID so that Intuit account can sign you in from then on, and we email you to say so; otherwise we don&rsquo;t keep it.";

  it("Privacy: on the page and in its archived copy, dated November 13, 2026, not a material change", () => {
    expect(flat("app/(marketing)/privacy/page.tsx")).toContain(privacySentence);
    expect(LEGAL_UPDATED.privacy).toBe("November 13, 2026");
    expect(ACCEPTANCE_VERSION).toBe("2026-10-14");
    // Line endings as git gives them on Windows (CRLF) or elsewhere (LF).
    const archived = readFileSync(join(ROOT, "legal-archive", legalDateKey(LEGAL_UPDATED.privacy), "privacy.md"), "utf8").replace(/\r\n/g, "\n");
    expect(archived).toContain(privacySentence.replace(/&rsquo;/g, "’"));
    expect(archived).toContain("\nLast updated: November 13, 2026\n");
  });

  it("Security and Settings say when connecting turns Sign in with Intuit on", () => {
    expect(flat("app/(marketing)/security/page.tsx")).toContain(
      "or when you connect QuickBooks while signed in to that login, with an Intuit account whose verified email address is the login&rsquo;s own. We email you whenever one is linked."
    );
    expect(flat("app/dashboard/settings/page.tsx")).toContain(
      "Off. It turns on when you connect QuickBooks with an Intuit account that has this login&apos;s email address."
    );
  });
});

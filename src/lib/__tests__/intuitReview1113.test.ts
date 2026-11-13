import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { createFakePrisma, type FakePrisma } from "./support/fakePrisma";

// Intuit's technical review call, Nov 13, 2026:
//  a) only Intuit's current Connect to QuickBooks button starts an OAuth
//     connection, hidden behind "Add company" once a company is connected
//     (requirement 6.2);
//  b) Intuit's approved QuickBooks logo (the stacked "light" logo from the
//     link in Intuit's review, sent by Preston), beside Connect to QuickBooks;
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

const session = { account: null as null | { userId: string; ownerId: string; role: string } };
vi.mock("@/lib/account", () => ({ getAccount: async () => session.account }));
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
import { AddCompanyButton, ConnectToQuickBooksButton, QuickBooksLogo, SignInWithIntuitButton } from "@/components/IntuitButtons";
import { TRADEMARK_NOTICE } from "@/components/marketing/trademark";
import { intuitLinkedEmail } from "../email/templates";
import { linkIntuitOnConnect } from "../intuitConnectLink";
import { ACCEPTANCE_VERSION, LEGAL_UPDATED, legalDateKey } from "../legalVersion";
import { GET as connect } from "../../app/api/quickbooks/connect/route";

const SRC = join(__dirname, "..", "..");
const ROOT = join(SRC, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const flat = (rel: string) => read(rel).replace(/\s+/g, " ");
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Every source file outside the tests, relative to src/. */
function sourceFiles(dir = SRC, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "__tests__" && name !== "node_modules") sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full.slice(SRC.length + 1));
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
    // intuit-quickbooks-stacked-signature-light-tally-logo-icom.png, 777x205, from
    // the link in Intuit's review (www.intuit.com/oidam/intuit/ic/en_us/logos/), as Preston sent it.
    "intuit-quickbooks-stacked-signature-light-tally-logo-icom.png": "0376f153891d8ee88e28ef6b6e9b86f6d489ff0e695df76805d1c0df3b421d5d",
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

describe("b. Intuit's approved QuickBooks logo beside Connect to QuickBooks", () => {
  it("draws Intuit's file at its own proportions, and isn't a link", () => {
    const html = renderToStaticMarkup(createElement(QuickBooksLogo));
    // (React may add a <link rel="preload"> for the image ahead of it.)
    expect(html).toContain(
      '<img src="/intuit/intuit-quickbooks-stacked-signature-light-tally-logo-icom.png" alt="Intuit QuickBooks" width="777" height="205" style="height:40px;width:auto;max-width:100%" class="block"/>'
    );
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=\"/api/");
    expect(renderToStaticMarkup(createElement(QuickBooksLogo, { height: 32 }))).toContain("height:32px;width:auto");
  });

  it("sits where connections are managed: the dashboard and Settings with nothing connected, Settings' company list, the disconnect page", () => {
    const dashboard = flat("app/dashboard/page.tsx");
    expect(dashboard).toContain('<QuickBooksLogo /> </div> <p className="text-gray-600"> Connect your QuickBooks Online company to see your job profitability.');
    const settings = flat("app/dashboard/settings/page.tsx");
    expect(settings).toContain('<QuickBooksLogo /> </div> <p className="text-gray-600">Connect your QuickBooks Online company to configure settings.</p>');
    expect(settings).toContain('QuickBooks {companies.length > 1 ? "companies" : "company"} </h2> <QuickBooksLogo height={32} />');
    expect(flat("app/quickbooks/disconnected/page.tsx")).toContain(
      '<QuickBooksLogo height={32} /> </div> <h1 className="text-xl font-bold text-navy">JobProfitAI is disconnected from QuickBooks</h1>'
    );
    // Never inside a link.
    for (const f of sourceFiles().filter((f) => f !== "components/IntuitButtons.tsx" && read(f).includes("<QuickBooksLogo"))) {
      expect({ f, inLink: /<(a|Link)\b[^>]*>\s*<QuickBooksLogo/.test(read(f)) }).toEqual({ f, inLink: false });
    }
  });

  it("carries Intuit's trademark notice on every app page, now that the app shows the logo", () => {
    const layout = flat("app/dashboard/layout.tsx");
    expect(layout).toContain('import { TRADEMARK_NOTICE } from "@/components/marketing/trademark";');
    expect(layout).toContain("{TRADEMARK_NOTICE}</p> </footer>");
    expect(TRADEMARK_NOTICE).toContain("Intuit and QuickBooks are registered trademarks of Intuit Inc. Used with permission.");
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

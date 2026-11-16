import { describe, it, expect, afterEach } from "vitest";

// The staging site (staging.jobprofitai.com) sets SITE_NOINDEX=1 so search
// engines never list it. Production leaves it unset, and must send exactly
// the headers it sent before.

type Rule = { source: string; headers: { key: string; value: string }[] };

async function rules(): Promise<Rule[]> {
  const config = (await import("../../../next.config.mjs")).default as {
    headers: () => Promise<Rule[]>;
  };
  return config.headers();
}

const robotsTag = (list: Rule[]) =>
  list.flatMap((r) => r.headers).find((h) => h.key === "X-Robots-Tag")?.value;

describe("staging noindex (SITE_NOINDEX)", () => {
  const before = process.env.SITE_NOINDEX;
  afterEach(() => {
    if (before === undefined) delete process.env.SITE_NOINDEX;
    else process.env.SITE_NOINDEX = before;
  });

  it("sends no X-Robots-Tag when SITE_NOINDEX is unset (production)", async () => {
    delete process.env.SITE_NOINDEX;
    expect(robotsTag(await rules())).toBeUndefined();
  });

  it("only turns on for the exact value 1", async () => {
    for (const v of ["", "0", "false"]) {
      process.env.SITE_NOINDEX = v;
      expect({ v, tag: robotsTag(await rules()) }).toEqual({ v, tag: undefined });
    }
  });

  it("tells search engines to skip every path on staging and keeps the security headers", async () => {
    process.env.SITE_NOINDEX = "1";
    const list = await rules();
    const all = list.find((r) => r.source === "/:path*")!;
    const value = (key: string) => all.headers.find((h) => h.key === key)?.value;
    expect(value("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(value("X-Frame-Options")).toBe("DENY");
    expect(value("X-Content-Type-Options")).toBe("nosniff");
    expect(list.filter((r) => r.headers.some((h) => h.key === "X-Robots-Tag")).length).toBe(1);
  });
});

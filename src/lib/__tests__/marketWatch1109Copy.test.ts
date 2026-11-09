import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { ADVANCED_AI_FAQ } from "@/components/marketing/QuickBooksComparison";

// Copy change from the market watch of 2026-11-09. QuickBooks Online
// Advanced's fall 2026 release added an AI chat that answers "how a job's
// margin compares to similar ones". The site now credits that and names
// what JobProfitAI adds: every job set against the contractor's own target
// margin, each estimate checked before it's sent, without having to ask,
// on Plus as well as Advanced.

const SRC = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
/** Source with line breaks and indentation collapsed, so wrapped text can be matched. */
const flat = (rel: string) => read(rel).replace(/\s+/g, " ");

const HOME = "app/(marketing)/page.tsx";
const PRICING = "app/(marketing)/pricing/page.tsx";
const LANDING = "components/marketing/LandingPage.tsx";
const COMPARISON = "components/marketing/QuickBooksComparison.tsx";

describe("the QuickBooks comparison", () => {
  const c = flat(COMPARISON);

  it("credits Advanced with its AI chat, and keeps the construction reports", () => {
    expect(c).toContain('"On Advanced, an AI chat you can ask how a job\'s margin compares with similar jobs"');
    expect(c).toContain("On Advanced, construction reports too: budget against actual, change orders, WIP, and flags when a project's costs run over");
  });

  it("names the contractor's own target margin, the estimate before it's sent, and not having to ask", () => {
    for (const line of [
      '"Which job types, customers and job sizes fall short of your own target margin, and by how much"',
      '"Whether each pending estimate hits your target margin, before you send it"',
      '"A weekly email of what changed and which estimates to fix, without having to ask"',
    ]) {
      expect({ line, found: c.includes(line) }).toEqual({ line, found: true });
    }
    expect(c).not.toContain("don't hit your margin");
  });
});

describe("the Advanced AI question", () => {
  /** Curly apostrophes read as straight ones, so the checks below match either. */
  const plain = (s: string) => s.replace(/\u2019/g, "'");
  const answer = plain(ADVANCED_AI_FAQ.a);
  const text = `${plain(ADVANCED_AI_FAQ.q)} ${answer}`;

  it("is answered on the homepage, the pricing page and every ad landing page", () => {
    for (const f of [HOME, PRICING, LANDING]) {
      const page = flat(f);
      expect({ f, imported: /import [^;]*\{ ADVANCED_AI_FAQ \} from "[^"]*QuickBooksComparison"/.test(page) }).toEqual({ f, imported: true });
      // In the FAQ list, right after the question it follows.
      expect({ f, listed: /\}, ADVANCED_AI_FAQ, \{/.test(page) }).toEqual({ f, listed: true });
    }
  });

  it("says what JobProfitAI adds, and that it works on Plus", () => {
    for (const piece of [
      "without being asked",
      "against the target margin you choose, by job type, customer and part of the job",
      "ranks what to change by what it's worth in dollars",
      "checks each pending estimate against that target before you send it",
      "works on QuickBooks Online Plus as well as Advanced, so there's no plan upgrade to get it",
    ]) {
      expect({ piece, found: answer.includes(piece) }).toEqual({ piece, found: true });
    }
  });

  it("says what Intuit's AI does, never what it lacks, and leaves Intuit's beta and plan terms off the page", () => {
    expect(text).toMatch(/^QuickBooks Online Advanced has AI/);
    expect(text).not.toMatch(/doesn't|does not|can't|cannot|won't|only|lacks|has no|beta|admin|\$\d/i);
  });

  it("follows the house style: no en or em dashes", () => {
    expect(text).not.toMatch(/[–—]/);
  });
});

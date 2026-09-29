import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  decideJobSourceAnswer,
  jobSetupChangeData,
  jobSourceQuestionPending,
  JOB_SOURCE_QUESTION,
  parseJobSourceAnswer,
  syncMayPickJobSource,
} from "../jobSetup";
import { analysisReadyEmail } from "../email/templates";

describe("the 'Is each job a Class?' answer (C5)", () => {
  it("reads 'keep', and treats an old page's setting value as 'keep'", () => {
    expect(parseJobSourceAnswer("classes")).toBe("classes");
    expect(parseJobSourceAnswer("keep")).toBe("keep");
    expect(parseJobSourceAnswer("projects")).toBe("keep");
    expect(parseJobSourceAnswer("customers")).toBe("keep");
    expect(parseJobSourceAnswer("anything")).toBeNull();
    expect(parseJobSourceAnswer(undefined)).toBeNull();
  });

  it("keeps what is stored now, including a first sync's switch to one customer per job", () => {
    // The page loaded while the company was on Projects; the sync then moved it.
    expect(decideJobSourceAnswer("customers", "keep")).toEqual({ ok: true, jobSource: "customers", rebuild: false });
    expect(decideJobSourceAnswer("projects", "keep")).toEqual({ ok: true, jobSource: "projects", rebuild: false });
  });

  it("rebuilds only when classes is new", () => {
    expect(decideJobSourceAnswer("customers", "classes")).toEqual({ ok: true, jobSource: "classes", rebuild: true });
    expect(decideJobSourceAnswer("classes", "classes")).toEqual({ ok: true, jobSource: "classes", rebuild: false });
  });

  it("won't guess where to go back to when Classes was chosen elsewhere meanwhile", () => {
    const d = decideJobSourceAnswer("classes", "keep");
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.status).toBe(409);
  });

  it("lets only a first sync with nothing confirmed choose the setup", () => {
    const at = new Date("2026-09-28T12:00:00Z");
    expect(syncMayPickJobSource({ lastSyncedAt: null, jobSourceConfirmedAt: null })).toBe(true);
    expect(syncMayPickJobSource({ lastSyncedAt: null, jobSourceConfirmedAt: at })).toBe(false);
    expect(syncMayPickJobSource({ lastSyncedAt: at, jobSourceConfirmedAt: null })).toBe(false);
  });
});

describe("a change of job setup (C9)", () => {
  it("asks for a full rebuild, resets the alert baseline and marks the basis change", () => {
    const now = new Date("2026-09-28T12:00:00Z");
    expect(jobSetupChangeData(now)).toEqual({ lastFullSyncAt: null, rebuildRequestedAt: now, alertsBaselinedAt: null, basisChangedAt: now });
  });
});

describe("the dashboard question", () => {
  const root = join(__dirname, "..", "..");
  const page = readFileSync(join(root, "app", "dashboard", "page.tsx"), "utf8");
  const prompt = readFileSync(join(root, "components", "dashboard", "JobSourcePrompt.tsx"), "utf8");
  const route = readFileSync(join(root, "app", "api", "settings", "job-source", "route.ts"), "utf8");

  it("is shown only after the first sync has finished", () => {
    const at = page.indexOf("<JobSourcePrompt");
    expect(at).toBeGreaterThan(0);
    // The same rule the emails use to point to the question.
    expect(page.slice(Math.max(0, at - 400), at)).toContain("jobSourceQuestionPending(connection)");
    expect(prompt).toContain("{JOB_SOURCE_QUESTION}");
  });

  it("sends 'keep' for No, starts a sync after Yes, and carries the Settings warning", () => {
    expect(prompt).toContain('answer("keep")');
    expect(prompt).not.toContain("answer(current)");
    expect(prompt).toContain('"/api/quickbooks/sync"');
    expect(prompt).toContain("contract value typed in for them");
  });

  it("writes the job setup change fields on a change", () => {
    expect(route).toContain("jobSetupChangeData(now)");
    expect(route).toContain("refuseClient(account)");
  });
});

describe("pointing to the question before it's answered (C5)", () => {
  const at = new Date("2026-09-28T12:00:00Z");
  const waiting = { lastSyncedAt: at, costTrackingMode: "classes", jobSource: "projects", jobSourceConfirmedAt: null };

  it("is pending only for a synced company that uses Classes, isn't on them, and hasn't answered", () => {
    expect(jobSourceQuestionPending(waiting)).toBe(true);
    expect(jobSourceQuestionPending({ ...waiting, jobSource: "customers" })).toBe(true);
    expect(jobSourceQuestionPending({ ...waiting, lastSyncedAt: null })).toBe(false);
    expect(jobSourceQuestionPending({ ...waiting, costTrackingMode: "projects" })).toBe(false);
    expect(jobSourceQuestionPending({ ...waiting, jobSource: "classes" })).toBe(false);
    expect(jobSourceQuestionPending({ ...waiting, jobSourceConfirmedAt: at })).toBe(false);
  });

  it("adds one line to the 'numbers are in' email while it's pending, and none after", () => {
    const pending = analysisReadyEmail("Acme Builders", { jobSourceQuestionPending: true });
    const answered = analysisReadyEmail("Acme Builders");
    expect(pending.text).toContain(JOB_SOURCE_QUESTION);
    expect(pending.html).toContain("Is each job a Class in your QuickBooks?");
    expect(answered.text).not.toContain(JOB_SOURCE_QUESTION);
    expect(pending.text.split("\n").filter((l) => l.includes(JOB_SOURCE_QUESTION))).toHaveLength(1);
  });
});

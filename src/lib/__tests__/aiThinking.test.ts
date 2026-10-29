import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { inUs, thinkingOff } from "@/lib/ai";

const SRC = join(__dirname, "..", "..");

// Sentry, Oct 29, 2026: a weekly brief went out without its summary because
// the reply "came back cut off at the length limit twice". Claude Sonnet 5
// thinks before answering unless told not to, and the thinking counts toward
// max_tokens, so it used up the 1,200 and then 2,400 tokens the summary gets.

const ask = (model: string, extra: Record<string, unknown> = {}) =>
  inUs({ model, max_tokens: 1200, messages: [{ role: "user", content: "Write the brief." }], ...extra } as unknown as Parameters<typeof inUs>[0]) as unknown as Record<string, unknown>;

describe("up-front thinking is turned off where the model allows it", () => {
  it("uses the setting Anthropic's table gives for each model", () => {
    const cases: [string, unknown][] = [
      ["claude-sonnet-5", { type: "disabled" }],
      ["claude-sonnet-5-20260415", { type: "disabled" }],
      ["claude-opus-5", { type: "disabled" }],
      ["claude-haiku-5-5", { type: "disabled" }],
      ["claude-sonnet-5-5", { type: "between_tools" }],
      ["claude-sonnet-4-6", { type: "disabled" }],
      ["claude-sonnet-4-5", { type: "disabled" }],
      ["claude-haiku-4-5-20251001", { type: "disabled" }],
      ["claude-opus-4-8", { type: "disabled" }],
      ["claude-sonnet-4-20250514", { type: "disabled" }],
      [" Claude-Sonnet-5 ", { type: "disabled" }],
    ];
    for (const [model, want] of cases) expect({ model, got: thinkingOff(model) }).toEqual({ model, got: want });
  });

  it("sends no setting to a model that refuses both, or one it doesn't know", () => {
    // A wrong setting is a 400, which would cost every brief its summary.
    for (const model of ["claude-opus-5-5", "claude-fable-5-1", "claude-mythos-5-1", "claude-fable-5", "claude-mythos-5", "claude-sonnet-6", "claude-sonnet-5-6", "claude-opus-5-5-fast", "gpt-5"]) {
      expect({ model, got: thinkingOff(model) }).toEqual({ model, got: null });
    }
  });

  it("puts the setting on the request, next to inference_geo", () => {
    expect(ask("claude-sonnet-5")).toMatchObject({ model: "claude-sonnet-5", max_tokens: 1200, thinking: { type: "disabled" }, inference_geo: "us" });
    expect(ask("claude-sonnet-5-5")).toMatchObject({ thinking: { type: "between_tools" }, inference_geo: "us" });
    const opus55 = ask("claude-opus-5-5");
    expect("thinking" in opus55).toBe(false);
    expect(opus55.inference_geo).toBe("us");
  });

  it("keeps a thinking setting the caller chose", () => {
    expect(ask("claude-sonnet-5", { thinking: { type: "adaptive" } }).thinking).toEqual({ type: "adaptive" });
  });

  it("covers every request the app makes, since all of them go through inUs()", () => {
    for (const f of ["lib/intelligence.ts", "lib/jobTypeSuggestions.ts", "lib/digest.ts"]) {
      const src = readFileSync(join(SRC, f), "utf8");
      expect({ f, calls: src.split("messages.create(").length - 1, wrapped: src.split("messages.create(inUs(").length - 1 }).toEqual({ f, calls: 1, wrapped: 1 });
    }
  });
});

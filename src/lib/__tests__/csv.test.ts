import { describe, expect, it } from "vitest";
import { findColumn, parseCsv, parseMoneyCell, toCsv } from "../csv";

describe("csv", () => {
  it("reads quoted fields, commas and Excel's line endings", () => {
    const rows = parseCsv('﻿Job,Estimated cost\r\n"Smith, Kitchen","$12,500.00"\r\nLee Bath,8000\r\n');
    expect(rows).toEqual([
      ["Job", "Estimated cost"],
      ["Smith, Kitchen", "$12,500.00"],
      ["Lee Bath", "8000"],
    ]);
  });

  it("round-trips and neutralises formula cells", () => {
    const text = toCsv([["Job", "Value"], ['He said "hi"', 5], ["=HYPERLINK()", null]]);
    expect(text).toBe('Job,Value\r\n"He said ""hi""",5\r\n\'=HYPERLINK(),');
    expect(parseCsv(text)[1]).toEqual(['He said "hi"', "5"]);
  });

  it("parses money the way people type it", () => {
    expect(parseMoneyCell("$12,500.00")).toBe(12500);
    expect(parseMoneyCell("(1,200)")).toBe(-1200);
    expect(parseMoneyCell("")).toBeNull();
    expect(parseMoneyCell("abc")).toBeNull();
  });

  it("finds columns by loose header names", () => {
    expect(findColumn(["Job Name", "Est. Cost"], ["estimated cost", "est cost"])).toBe(1);
    expect(findColumn(["Job Name"], ["job", "job name"])).toBe(0);
  });
});

describe("formula guard round trip", () => {
  it("neutralises formulas on export and restores them on import", async () => {
    const { unescapeCell } = await import("../csv");
    const out = toCsv([["=SUM(A1)", "\t=1", "Plain"]]);
    const back = parseCsv(out)[0].map(unescapeCell);
    expect(out.startsWith("'=SUM")).toBe(true);
    expect(back).toEqual(["=SUM(A1)", "\t=1", "Plain"]);
  });
});

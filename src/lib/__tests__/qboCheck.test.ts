import { describe, it, expect } from "vitest";
import { compareWithQuickBooks, parseProfitAndLoss } from "../qboCheck";

const section = (group: string, label: string, value: string) => ({
  group,
  type: "Section",
  Summary: { ColData: [{ value: label }, { value }] },
});

describe("parseProfitAndLoss", () => {
  it("adds cost of goods sold and expenses, and reads income", () => {
    const report = {
      Header: { Option: [{ Name: "NoReportData", Value: "false" }] },
      Rows: {
        Row: [
          section("Income", "Total Income", "12,500.00"),
          section("COGS", "Total Cost of Goods Sold", "6000.50"),
          section("GrossProfit", "Gross Profit", "6499.50"),
          section("Expenses", "Total Expenses", "1200.00"),
          section("OtherExpenses", "Total Other Expenses", "-50.00"),
          section("NetIncome", "Net Income", "5349.50"),
        ],
      },
    };
    expect(parseProfitAndLoss(report)).toEqual({ income: 12500, costs: 7150.5 });
  });

  it("treats an empty report as zero and a malformed one as missing", () => {
    expect(parseProfitAndLoss({ Header: { Option: [{ Name: "NoReportData", Value: "true" }] }, Rows: { Row: [] } })).toEqual({
      income: 0,
      costs: 0,
    });
    expect(parseProfitAndLoss({})).toBeNull();
  });

  it("reads a blank total as zero", () => {
    const report = { Rows: { Row: [section("Income", "Total Income", "325.00"), section("Expenses", "Total Expenses", "")] } };
    expect(parseProfitAndLoss(report)).toEqual({ income: 325, costs: 0 });
  });
});

describe("compareWithQuickBooks", () => {
  it("matches within a dollar and explains timesheet labor", () => {
    const result = compareWithQuickBooks(
      { revenue: 10000.4, postedCosts: 6200, timesheetLabor: 1800, parentCustomerCosts: 0 },
      { income: 10000, costs: 6200 }
    );
    expect(result.allMatch).toBe(true);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("$1,800.00");
  });

  it("flags a real difference with its size", () => {
    const result = compareWithQuickBooks(
      { revenue: 10000, postedCosts: 7400, timesheetLabor: 0, parentCustomerCosts: 300 },
      { income: 10000, costs: 6200 }
    );
    expect(result.allMatch).toBe(false);
    expect(result.lines[1]).toMatchObject({ difference: 1200, matches: false });
    expect(result.notes.some((n) => n.includes("parent customer"))).toBe(true);
  });
});

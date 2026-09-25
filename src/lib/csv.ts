/**
 * Small CSV reader and writer for the budget import/export and the WIP
 * export. RFC 4180 quoting; tolerant of Excel's BOM and CRLF line endings.
 * Dependency-free so it runs in the browser and on the server alike.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

const needsQuotes = /[",\r\n]/;

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows
    .map((r) =>
      r
        .map((v) => {
          if (v == null) return "";
          let s = String(v);
          // Spreadsheet formula injection: a cell starting with = + - @ (or a
          // tab or carriage return before one) runs as a formula in Excel.
          // Job names come from QuickBooks, so they are neutralised with a
          // leading apostrophe; unescapeCell takes it off again on import.
          if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
          return needsQuotes.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(",")
    )
    .join("\r\n");
}

/** Reverses toCsv's formula guard, so an exported sheet imports back unchanged. */
export function unescapeCell(v: string): string {
  return /^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v;
}

/** A money cell as a plain number, or null. Accepts "$12,500.00" and "(1,200)". */
export function parseMoneyCell(v: string | undefined): number | null {
  if (v == null) return null;
  const t = v.trim();
  if (t === "") return null;
  const negative = /^\(.*\)$/.test(t) || t.startsWith("-");
  const n = Number(t.replace(/[()$,\s-]/g, ""));
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Column index by any of these header names (case- and spacing-insensitive). */
export function findColumn(header: string[], names: string[]): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%]/g, "");
  const wanted = names.map(norm);
  return header.findIndex((h) => wanted.includes(norm(h)));
}

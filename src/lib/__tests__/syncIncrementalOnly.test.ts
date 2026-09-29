import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakePrisma, FakeModel, type FakePrisma } from "./support/fakePrisma";

// The weekly brief job's sync (runSyncForConnection with incrementalOnly)
// must never turn into a full read of the company's history: one can
// outlast the whole run and take other companies' briefs down with it.

const fake: { client: FakePrisma } = { client: createFakePrisma() };
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));
vi.mock("@/lib/crypto", () => ({
  encryptToken: (s: string) => s,
  decryptToken: (s: string) => s,
}));
const qbo = { cdcCalls: 0, queryAllCalls: 0 };
vi.mock("@/lib/quickbooks", () => ({
  qboCdc: async () => {
    qbo.cdcCalls++;
    throw new Error("QuickBooks returned 500");
  },
  qboQueryAll: async () => {
    qbo.queryAllCalls++;
    return [];
  },
  qboQuery: async () => ({}),
  qboCompanyInfo: async () => ({}),
  refreshTokens: async () => {
    throw new Error("not expected");
  },
}));

import { FullSyncNotAllowedError, runSyncForConnection, SYNC_VERSION } from "../quickbooksSync";

const DAY = 86_400_000;

function addConnection(p: { syncVersion?: number; lastFullSyncAt?: Date | null } = {}) {
  const lastAttempt = new Date(Date.now() - 2 * DAY);
  return fake.client.quickBooksConnection.create({
    data: {
      id: "c1",
      userId: "u1",
      realmId: "realm",
      realmIdHash: "h1",
      accessToken: "token",
      refreshToken: "refresh",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      jobSource: "customers",
      laborFromTimeEntries: true,
      syncVersion: p.syncVersion ?? SYNC_VERSION,
      lastFullSyncAt: p.lastFullSyncAt === undefined ? new Date(Date.now() - 3 * DAY) : p.lastFullSyncAt,
      lastSyncedAt: lastAttempt,
      lastSyncAttemptAt: lastAttempt,
      lastSyncStatus: "success",
      jobSourceConfirmedAt: new Date(Date.now() - 30 * DAY),
    },
  });
}

describe("incremental-only sync for the weekly brief", () => {
  beforeEach(() => {
    fake.client = createFakePrisma();
    (fake.client as any).syncRun = new FakeModel("syncRun", [], () => ({ startedAt: new Date() }));
    qbo.cdcCalls = 0;
    qbo.queryAllCalls = 0;
  });

  it("throws instead of reading everything when the change feed fails", async () => {
    await addConnection();
    await expect(runSyncForConnection("c1", { incrementalOnly: true })).rejects.toBeInstanceOf(FullSyncNotAllowedError);
    expect(qbo.cdcCalls).toBe(1);
    // No full read: the chart of accounts is the first thing a full sync reads.
    expect(qbo.queryAllCalls).toBe(0);
    const runs = await (fake.client as any).syncRun.findMany({ where: { connectionId: "c1" } });
    expect(runs.map((r: any) => [r.mode, r.status])).toEqual([["incremental", "error"]]);
    const c = await fake.client.quickBooksConnection.findUnique({ where: { id: "c1" } });
    expect(c!.lastSyncStatus).toBe("error");
  });

  it("doesn't start when a full sync is due, and hands the claim back untouched", async () => {
    // Settings asked for a rebuild after the brief job checked: lastFullSyncAt was cleared.
    await addConnection({ lastFullSyncAt: null });
    const before = await fake.client.quickBooksConnection.findUnique({ where: { id: "c1" } });
    await expect(runSyncForConnection("c1", { incrementalOnly: true })).rejects.toBeInstanceOf(FullSyncNotAllowedError);
    expect(qbo.cdcCalls + qbo.queryAllCalls).toBe(0);
    expect(await (fake.client as any).syncRun.count({ where: { connectionId: "c1" } })).toBe(0);
    const after = await fake.client.quickBooksConnection.findUnique({ where: { id: "c1" } });
    expect(after!.lastSyncStatus).toBe("success");
    expect(after!.lastSyncAttemptAt).toEqual(before!.lastSyncAttemptAt);
  });

  it("refuses a connection stored under an older sync version too", async () => {
    await addConnection({ syncVersion: SYNC_VERSION - 1 });
    await expect(runSyncForConnection("c1", { incrementalOnly: true })).rejects.toBeInstanceOf(FullSyncNotAllowedError);
    expect(qbo.queryAllCalls).toBe(0);
  });
});

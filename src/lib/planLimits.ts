import { prisma } from "./prisma";
import { getEntitlements } from "./entitlements";

/**
 * Companies beyond what the account's plan covers.
 *
 * Connecting a company is refused up front when the plan is full
 * (canConnectAnotherCompany), but an account can still end up over its limit:
 * a Pro customer with 3 companies moves to the 1-company plan in Stripe's
 * portal, or a trial connects more companies after opening a checkout.
 *
 * The plan covers the OLDEST connected companies, up to its limit. Any newer
 * ones are "paused": they stay visible with the data they already have (we
 * never hide a customer's figures), but they stop syncing and get no weekly
 * brief or alert emails until the owner disconnects some or moves to a plan
 * that covers them. The dashboard and Billing say which ones and why.
 */

export interface CompanyForLimit {
  id: string;
  connectedAt: Date;
}

/** Ids of the companies past the limit, newest first to go. Pure, for tests. */
export function pausedConnectionIds(companies: CompanyForLimit[], maxConnections: number): Set<string> {
  const sorted = [...companies].sort(
    (a, b) => a.connectedAt.getTime() - b.connectedAt.getTime() || a.id.localeCompare(b.id)
  );
  return new Set(sorted.slice(Math.max(0, maxConnections)).map((c) => c.id));
}

/** Connected companies on this account that are paused because the plan doesn't cover them. */
export async function overLimitConnectionIds(ownerId: string): Promise<Set<string>> {
  const [entitlements, companies] = await Promise.all([
    getEntitlements(ownerId),
    prisma.quickBooksConnection.findMany({
      where: { userId: ownerId, disconnectedAt: null },
      select: { id: true, connectedAt: true },
    }),
  ]);
  return pausedConnectionIds(companies, entitlements.limits.maxConnections);
}

/** Whether one company is paused for being past the plan's limit. */
export async function isOverPlanLimit(connection: { id: string; userId: string }): Promise<boolean> {
  return (await overLimitConnectionIds(connection.userId)).has(connection.id);
}

export interface PausedCompanySummary {
  /** Companies the plan covers. */
  maxConnections: number;
  /** Connected companies, paused ones included. */
  connected: number;
  /** The paused companies, oldest connected first. */
  paused: { id: string; name: string }[];
}

/** Which companies are paused, with names, for Billing and the dashboard strip. */
export async function pausedCompanySummary(ownerId: string): Promise<PausedCompanySummary> {
  const [entitlements, companies] = await Promise.all([
    getEntitlements(ownerId),
    prisma.quickBooksConnection.findMany({
      where: { userId: ownerId, disconnectedAt: null },
      select: { id: true, connectedAt: true, companyName: true },
      orderBy: { connectedAt: "asc" },
    }),
  ]);
  const maxConnections = entitlements.limits.maxConnections;
  const pausedIds = pausedConnectionIds(companies, maxConnections);
  return {
    maxConnections,
    connected: companies.length,
    paused: companies
      .filter((c) => pausedIds.has(c.id))
      .map((c) => ({ id: c.id, name: c.companyName?.trim() || "Unnamed company" })),
  };
}

/** "A", "A and B", "A, B and C". Pure. */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function companies(n: number): string {
  return `${n} QuickBooks ${n === 1 ? "company" : "companies"}`;
}

/**
 * The sentence Billing shows (and the dashboard strip can reuse) when some
 * companies are paused. Says what the plan covers, which ones are paused and
 * the two ways out, in the owner's words rather than ours. Pure, for tests.
 */
export function pausedCompaniesMessage(pausedNames: string[], maxConnections: number): string {
  if (pausedNames.length === 0) return "";
  const verb = pausedNames.length === 1 ? "is" : "are";
  return `Your plan covers ${companies(maxConnections)}. ${joinNames(pausedNames)} ${verb} paused until you disconnect some companies or choose a plan that covers them all.`;
}

// ---------------------------------------------------------------------------
// The plan chooser
// ---------------------------------------------------------------------------

export interface PlanForFit {
  name: string;
  limits: { maxConnections: number; maxActiveJobs: number | null };
}

export interface PlanFit {
  /** False when the plan can't cover the companies already connected; the button is disabled. */
  fits: boolean;
  /** Why it doesn't fit, shown under the disabled button. */
  reason: string | null;
  /** Fits, but something is worth knowing first (more open jobs than the plan is for). */
  warning: string | null;
}

/**
 * Whether a plan covers what the account already uses, for the plan cards
 * on Billing. Companies are a hard limit (checkout refuses a plan that can't
 * cover them, see api/billing/checkout), so the card is disabled with the
 * reason. The open-job limit on the $149 plan isn't enforced anywhere, so it
 * only warns. Pure, for tests.
 */
export function planFit(plan: PlanForFit, usage: { connections: number; activeJobs: number }): PlanFit {
  const maxCompanies = plan.limits.maxConnections;
  if (usage.connections > maxCompanies) {
    const extra = usage.connections - maxCompanies;
    return {
      fits: false,
      reason: `${plan.name} covers ${companies(maxCompanies)} and you have ${usage.connections} connected. Disconnect ${extra} in Settings first, or choose a plan that covers them all.`,
      warning: null,
    };
  }
  const maxJobs = plan.limits.maxActiveJobs;
  if (maxJobs != null && usage.activeJobs > maxJobs) {
    return {
      fits: true,
      reason: null,
      warning: `${plan.name} is for up to ${maxJobs} open jobs and you have ${usage.activeJobs}. Nothing is cut off, but a plan with unlimited jobs fits better.`,
    };
  }
  return { fits: true, reason: null, warning: null };
}

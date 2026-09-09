/**
 * A small in-memory stand-in for the Prisma client.
 *
 * Why this exists rather than a mocked-out function per test: the behaviour
 * worth testing in the billing, trial, referral and partner systems is
 * mostly about DATABASE CONSTRAINTS - "a unique index makes this
 * unrepeatable", "a retry inserts nothing the second time". A hand-stubbed
 * `findUnique` that returns whatever the test wants can't demonstrate any of
 * that, because it has no notion of a constraint to violate.
 *
 * So this fake enforces unique constraints for real and throws a Prisma-shaped
 * `{ code: "P2002" }` when one is breached, which is exactly what the
 * application code catches. It supports only the query shapes this codebase
 * actually uses - it is a test double, not a database.
 *
 * Not itself included in the test run (it lives under support/ and doesn't
 * match the *.test.ts include pattern).
 */

export interface UniqueSpec {
  /** Field names that must be unique across rows, ignoring null/undefined. */
  fields: string[];
}

type Row = Record<string, any>;

class PrismaError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "PrismaClientKnownRequestError";
  }
}

/** Supports the operators used in this codebase's queries. */
function matchValue(rowValue: any, condition: any): boolean {
  if (condition === undefined) return true;

  if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
    if ("equals" in condition) {
      if (condition.mode === "insensitive" && typeof rowValue === "string") {
        if (String(rowValue).toLowerCase() !== String(condition.equals).toLowerCase()) return false;
      } else if (!valuesEqual(rowValue, condition.equals)) {
        return false;
      }
    }
    if ("in" in condition && !condition.in.some((v: any) => valuesEqual(rowValue, v))) return false;
    if ("notIn" in condition && condition.notIn.some((v: any) => valuesEqual(rowValue, v))) return false;
    if ("not" in condition) {
      // `{ not: null }` means "is set"; `{ not: X }` means "differs from X".
      if (condition.not === null) {
        if (rowValue === null || rowValue === undefined) return false;
      } else if (valuesEqual(rowValue, condition.not)) {
        return false;
      }
    }
    if ("lt" in condition && !(toTime(rowValue) < toTime(condition.lt))) return false;
    if ("lte" in condition && !(toTime(rowValue) <= toTime(condition.lte))) return false;
    if ("gt" in condition && !(toTime(rowValue) > toTime(condition.gt))) return false;
    if ("gte" in condition && !(toTime(rowValue) >= toTime(condition.gte))) return false;
    return true;
  }

  return valuesEqual(rowValue, condition);
}

function valuesEqual(a: any, b: any): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === null || a === undefined) return b === null || b === undefined;
  return a === b;
}

function toTime(v: any): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return NaN;
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    if (key === "AND") {
      if (!(condition as Row[]).every((c) => matches(row, c))) return false;
      continue;
    }
    if (key === "OR") {
      if (!(condition as Row[]).some((c) => matches(row, c))) return false;
      continue;
    }
    if (!matchValue(row[key], condition)) return false;
  }
  return true;
}

export class FakeModel {
  rows: Row[] = [];
  private seq = 0;

  constructor(
    private readonly name: string,
    private readonly uniques: UniqueSpec[] = [],
    private readonly defaults: () => Row = () => ({})
  ) {}

  private nextId(): string {
    this.seq += 1;
    return `${this.name}_${this.seq}`;
  }

  private assertUnique(candidate: Row, ignoreRow?: Row) {
    for (const spec of this.uniques) {
      const values = spec.fields.map((f) => candidate[f]);
      // A null in any component means the constraint doesn't apply, matching
      // Postgres' treatment of NULLs under a unique index.
      if (values.some((v) => v === null || v === undefined)) continue;

      const clash = this.rows.some(
        (row) =>
          row !== ignoreRow && spec.fields.every((f, i) => valuesEqual(row[f], values[i]))
      );
      if (clash) {
        throw new PrismaError(
          "P2002",
          `Unique constraint failed on the fields: (${spec.fields.join(",")})`
        );
      }
    }
  }

  async create({ data }: { data: Row }): Promise<Row> {
    const row: Row = { id: data.id ?? this.nextId(), ...this.defaults(), ...data };
    this.assertUnique(row);
    this.rows.push(row);
    return { ...row };
  }

  async createMany({ data }: { data: Row[] }): Promise<{ count: number }> {
    for (const item of data) await this.create({ data: item });
    return { count: data.length };
  }

  async findUnique({ where, select }: { where: Row; select?: Row }): Promise<Row | null> {
    return this.findFirst({ where, select });
  }

  async findFirst({
    where,
    orderBy,
    select,
  }: { where?: Row; orderBy?: any; select?: Row } = {}): Promise<Row | null> {
    const found = await this.findMany({ where, orderBy, select });
    return found[0] ?? null;
  }

  async findMany({
    where,
    orderBy,
    take,
    select,
  }: { where?: Row; orderBy?: any; take?: number; select?: Row } = {}): Promise<Row[]> {
    let found = this.rows.filter((row) => matches(row, where));

    if (orderBy) {
      const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
      found = [...found].sort((a, b) => {
        for (const clause of clauses) {
          const [field, dir] = Object.entries(clause)[0] as [string, string];
          const av = a[field];
          const bv = b[field];
          const cmp =
            av instanceof Date || bv instanceof Date
              ? toTime(av) - toTime(bv)
              : av === bv
                ? 0
                : av > bv
                  ? 1
                  : -1;
          if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
        }
        return 0;
      });
    }

    const sliced = take != null ? found.slice(0, take) : found;

    // Project through `select` exactly as Prisma does. Without this the
    // double returned whole rows for a narrowed query, which is the wrong
    // direction for a test double to be wrong in: it lets a query that
    // over-fetches in production still look correct in tests. It also made
    // the partner data-isolation test unable to fail for the right reason.
    if (select) {
      const keys = Object.keys(select).filter((k) => select[k] === true);
      return sliced.map((row) => {
        const projected: Row = {};
        for (const key of keys) projected[key] = row[key];
        return projected;
      });
    }

    return sliced.map((row) => ({ ...row }));
  }

  async count({ where }: { where?: Row } = {}): Promise<number> {
    return this.rows.filter((row) => matches(row, where)).length;
  }

  async update({ where, data }: { where: Row; data: Row }): Promise<Row> {
    const row = this.rows.find((r) => matches(r, where));
    if (!row) throw new PrismaError("P2025", "Record to update not found.");
    const candidate = { ...row, ...unwrap(data) };
    this.assertUnique(candidate, row);
    Object.assign(row, unwrap(data));
    return { ...row };
  }

  async updateMany({ where, data }: { where?: Row; data: Row }): Promise<{ count: number }> {
    const targets = this.rows.filter((row) => matches(row, where));
    for (const row of targets) Object.assign(row, unwrap(data));
    return { count: targets.length };
  }

  async upsert({ where, create, update }: { where: Row; create: Row; update: Row }): Promise<Row> {
    const existing = this.rows.find((r) => matches(r, where));
    if (existing) return this.update({ where, data: update });
    return this.create({ data: create });
  }

  async delete({ where }: { where: Row }): Promise<Row> {
    const index = this.rows.findIndex((r) => matches(r, where));
    if (index === -1) throw new PrismaError("P2025", "Record to delete not found.");
    const [removed] = this.rows.splice(index, 1);
    return { ...removed };
  }

  async deleteMany({ where }: { where?: Row } = {}): Promise<{ count: number }> {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => !matches(row, where));
    return { count: before - this.rows.length };
  }
}

/** Prisma's `{ increment: n }` style update helpers aren't used here; this
 *  just strips undefined so a patch doesn't blank a field unintentionally. */
function unwrap(data: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export interface FakePrisma {
  [model: string]: any;
  $transaction: (arg: any) => Promise<any>;
}

/**
 * Builds a fake Prisma client with the unique constraints that actually
 * matter to the growth systems, mirroring prisma/schema.prisma.
 */
export function createFakePrisma(): FakePrisma {
  const models: Record<string, FakeModel> = {
    user: new FakeModel("user", [{ fields: ["email"] }], () => ({ createdAt: new Date() })),
    subscription: new FakeModel(
      "subscription",
      [{ fields: ["userId"] }, { fields: ["stripeCustomerId"] }, { fields: ["stripeSubscriptionId"] }],
      () => ({
        status: "trialing",
        plan: "profit_intelligence",
        cancelAtPeriodEnd: false,
        createdAt: new Date(),
        trialStartedAt: new Date(),
        trialEndsAt: null,
        trialExtendedAt: null,
        activatedAt: null,
        quickbooksConnectedAt: null,
        firstAnalysisAt: null,
        firstPaidAt: null,
        currentPeriodEnd: null,
        canceledAt: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        stripePriceId: null,
      })
    ),
    // tokenHash unique = a reset token identifies exactly one row, ever.
    passwordResetToken: new FakeModel(
      "passwordResetToken",
      [{ fields: ["tokenHash"] }],
      () => ({ createdAt: new Date(), usedAt: null })
    ),
    // userId unique is THE constraint that makes the trial extension
    // unrepeatable - see extendTrialWithFeedback.
    trialFeedback: new FakeModel("trialFeedback", [{ fields: ["userId"] }], () => ({
      createdAt: new Date(),
      daysGranted: 14,
    })),
    referralCode: new FakeModel(
      "referralCode",
      [{ fields: ["code"] }, { fields: ["userId"] }, { fields: ["partnerId"] }],
      () => ({ createdAt: new Date(), userId: null, partnerId: null })
    ),
    // referredUserId unique = an account can only ever be referred once.
    referral: new FakeModel("referral", [{ fields: ["referredUserId"] }], () => ({
      status: "signed_up",
      signedUpAt: new Date(),
      firstPaidAt: null,
      qualifiedAt: null,
      disqualifiedAt: null,
      disqualifiedReason: null,
      referrerUserId: null,
      partnerId: null,
    })),
    // referralId unique = one reward per qualifying referral, ever.
    referralReward: new FakeModel(
      "referralReward",
      [{ fields: ["referralId"] }, { fields: ["stripeBalanceTxnId"] }],
      () => ({
        status: "pending",
        earnedAt: new Date(),
        appliedAt: null,
        voidedAt: null,
        stripeBalanceTxnId: null,
      })
    ),
    partner: new FakeModel("partner", [{ fields: ["userId"] }], () => ({
      status: "pending",
      createdAt: new Date(),
      freeAccountGrantedAt: null,
    })),
    // stripeInvoiceId unique = a webhook retry can't double-commission.
    partnerCommission: new FakeModel(
      "partnerCommission",
      [{ fields: ["stripeInvoiceId"] }],
      () => ({ status: "earned", earnedAt: new Date(), paidAt: null, voidedAt: null })
    ),
    // The event id is the primary key, so a redelivery collides.
    stripeEvent: new FakeModel("stripeEvent", [{ fields: ["id"] }], () => ({
      processedAt: new Date(),
    })),
    // dedupeKey unique = send-once for lifecycle email.
    emailEvent: new FakeModel("emailEvent", [{ fields: ["dedupeKey"] }], () => ({
      status: "sent",
      sentAt: new Date(),
    })),
    contactSubmission: new FakeModel("contactSubmission", [], () => ({ createdAt: new Date() })),
    quickBooksConnection: new FakeModel("quickBooksConnection", [{ fields: ["realmIdHash"] }], () => ({
      disconnectedAt: null,
    })),
    job: new FakeModel("job", [], () => ({})),
    feedback: new FakeModel("feedback", [], () => ({ createdAt: new Date() })),
  };

  const client: FakePrisma = {
    ...models,
    /**
     * Runs interactive transactions by simply invoking the callback, and
     * array transactions by awaiting each promise. There is no rollback -
     * which is worth being explicit about: these tests verify constraint
     * behaviour and idempotency, not atomicity.
     */
    $transaction: async (arg: any) => {
      if (typeof arg === "function") return arg(client);
      return Promise.all(arg);
    },
  };

  return client;
}

import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { sendContactConfirmation, sendContactNotification } from "@/lib/email/lifecycle";
import { CONTACT_REASONS } from "@/lib/contact";

/**
 * POST /api/contact
 *
 * Marketing-site contact form. Every legitimate submission is stored AND
 * emailed to CONTACT_TO_EMAIL (support@jobprofitai.com in production).
 *
 * Storing first is deliberate: if Resend is down or the sending domain has a
 * problem, a sales lead still lands in the database with the delivery
 * failure recorded on the row, rather than vanishing. Email alone is not a
 * durable inbox.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ContactSchema = z.object({
  name: z.string().trim().min(1, "Please enter your name.").max(120),
  company: z.string().trim().max(160).optional().or(z.literal("")),
  email: z.string().trim().email("Please enter a valid email address.").max(320),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  reason: z.enum(CONTACT_REASONS, { errorMap: () => ({ message: "Choose a reason for contacting us." }) }),
  message: z.string().trim().min(10, "Please tell us a little more.").max(5000),
  /**
   * Honeypot. A real person never sees or fills this field; most naive bots
   * fill every input they find. Non-empty means silently accept and discard -
   * responding with an error just tells the bot how to get past it.
   */
  website: z.string().max(200).optional(),
});

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 5;

/**
 * IPs are hashed with AUTH_SECRET as a salt and never stored raw - the only
 * thing we need is "is this the same sender as a minute ago", which a hash
 * answers without keeping personal data about people who haven't signed up
 * for anything.
 */
function hashIp(ip: string): string {
  const salt = process.env.AUTH_SECRET ?? "jobprofitai";
  return crypto.createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const parsed = ContactSchema.safeParse(body);

    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return NextResponse.json(
        { error: first?.message ?? "Please check the form and try again." },
        { status: 400 }
      );
    }

    const data = parsed.data;

    // Honeypot tripped - look like a success, do nothing.
    if (data.website && data.website.trim().length > 0) {
      return NextResponse.json({ ok: true });
    }

    const ipHash = hashIp(clientIp(req));

    // Rate limit against the submissions table itself. No Redis, no extra
    // infrastructure, and it survives a redeploy - which an in-memory
    // counter on serverless functions would not, since each cold start would
    // reset it.
    const recent = await prisma.contactSubmission.count({
      where: { ipHash, createdAt: { gte: new Date(Date.now() - RATE_LIMIT_WINDOW_MS) } },
    });
    if (recent >= RATE_LIMIT_MAX) {
      return NextResponse.json(
        {
          error:
            "You've sent several messages recently. Please email support@jobprofitai.com directly and we'll pick it up there.",
        },
        { status: 429 }
      );
    }

    const submission = await prisma.contactSubmission.create({
      data: {
        name: data.name,
        company: data.company?.trim() || null,
        email: data.email.toLowerCase(),
        phone: data.phone?.trim() || null,
        reason: data.reason,
        message: data.message,
        ipHash,
        userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null,
      },
    });

    // Notify support. Reply-To is set to the sender, so replying from the
    // support inbox goes straight back to them.
    const notification = await sendContactNotification({
      name: data.name,
      company: data.company || null,
      email: data.email,
      phone: data.phone || null,
      reason: data.reason,
      message: data.message,
    });

    await prisma.contactSubmission.update({
      where: { id: submission.id },
      data: notification.ok
        ? { emailDeliveredAt: new Date(), emailError: null }
        : { emailError: notification.error?.slice(0, 500) ?? "Unknown delivery failure" },
    });

    if (!notification.ok) {
      // Logged loudly: the message is safely stored, but nobody has been
      // told about it, which is an operational problem worth surfacing.
      console.error(
        `contact: submission ${submission.id} stored but NOT delivered: ${notification.error}`
      );
    }

    // Confirmation to the sender. Best-effort - never fails their submission.
    try {
      await sendContactConfirmation({ name: data.name, email: data.email });
    } catch (err) {
      console.error(
        "contact: confirmation email failed:",
        err instanceof Error ? err.message : "Unknown error"
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("contact failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json(
      {
        error:
          "Something went wrong sending your message. Please email support@jobprofitai.com directly.",
      },
      { status: 500 }
    );
  }
}

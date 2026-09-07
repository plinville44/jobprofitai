import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe/client";
import { processStripeEvent } from "@/lib/stripe/webhookHandlers";

/**
 * POST /api/stripe/webhook
 *
 * Stripe's signature is computed over the EXACT raw request body, so this
 * route reads req.text() and never req.json() - parsing and re-serializing
 * would change the bytes and every signature check would fail.
 *
 * Node runtime is required: the Stripe SDK's signature verification uses
 * Node crypto, which the edge runtime doesn't provide.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A single event can trigger a Stripe fetch, several database writes and an
// email; the default 10s is tight for the invoice.paid path.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("stripe/webhook: STRIPE_WEBHOOK_SECRET is not set - rejecting.");
    // 500 (not 400) so Stripe retries once the secret is configured, rather
    // than treating a misconfiguration as a permanently bad event.
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    // An unverified payload is either an attack or a misconfigured endpoint.
    // 400 tells Stripe not to retry, and nothing from the body is logged.
    console.error(
      "stripe/webhook: signature verification failed:",
      err instanceof Error ? err.message : "Unknown error"
    );
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    const result = await processStripeEvent(event);
    // Always 200 for a verified, successfully-processed (or duplicate) event.
    return NextResponse.json({ received: true, ...result });
  } catch (err) {
    // 500 makes Stripe retry with backoff. processStripeEvent has already
    // released its event claim, so the retry genuinely re-runs the work.
    console.error(
      `stripe/webhook: processing ${event.type} (${event.id}) failed:`,
      err instanceof Error ? err.message : "Unknown error"
    );
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}

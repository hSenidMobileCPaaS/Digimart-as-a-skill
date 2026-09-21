/**
 * The endpoints YOU build for Digimart, on Express.
 *
 *   POST /digimart/checkout               start a one-time charge   (your users call this)
 *   POST /digimart/subscribe              start a subscription      (your users call this)
 *   GET  /digimart/return                 the redirectUrl           (the customer's browser lands here)
 *   POST /api/digimart/charging/notify    Async charging resp URL   (Digimart's server calls this)
 *   POST /api/digimart/subscription/notify Subscription Notification URL (Digimart's server calls this)
 *   POST /digimart/unsubscribe            your cancel button        (your users call this)
 *
 * The logic ports unchanged to Fastify, Hono, NestJS or Next.js route handlers.
 *
 * Three rules shape everything below:
 *   - the browser redirect is UNTRUSTED: it picks a screen and grants nothing;
 *   - the notification is the record: acknowledge 200 first, verify, dedupe, settle once;
 *   - the secret, the price and the requestId never come from — or go to — a client.
 */

import express, { type Request, type Response } from "express";
import { config } from "./digimart-config";
import {
  buildOneTimeUrl,
  buildSubscriptionUrl,
  classifySdkCode,
  fromTel,
  maskId,
  newRequestId,
  unsubscribe,
} from "./digimart-client";

/* ── State ───────────────────────────────────────────────────────────────── */
/*
 * In-process maps so the file runs as-is. In production these are database
 * tables (orders keyed by requestId, subscribers keyed by your user id) and a
 * unique constraint or Redis SET NX for the dedupe keys — shared by every
 * instance.
 */

type OrderState = "PENDING" | "PAID" | "FULFILLED" | "FAILED";
interface Order { requestId: string; userId: string; itemId: string; amount: string; state: OrderState; internalTrxId?: string }
interface Subscriber { userId: string; requestId: string; subscriberId?: string; status?: string; frequency?: string; provisional?: boolean }

const orders = new Map<string, Order>();
const subscriptionsByRequestId = new Map<string, Subscriber>();
const subscribersByUser = new Map<string, Subscriber>();
const seen = new Set<string>();

/** Your price list. The amount is signed — it must never come from the request. */
const PRICE_LIST: Record<string, string> = { "premium-article": "10", "credits-100": "50" };

function currentUserId(req: Request): string {
  // Replace with your authentication. Every start/cancel route is YOUR user's action.
  const id = req.header("x-user-id");
  if (!id) throw Object.assign(new Error("unauthenticated"), { status: 401 });
  return id;
}

const wantsJson = (req: Request) => (req.header("accept") ?? "").includes("application/json");

export const router = express.Router();
router.use(express.json({ limit: "32kb" }));

/* ── Start endpoints ─────────────────────────────────────────────────────── */

router.post("/digimart/checkout", (req: Request, res: Response) => {
  const userId = currentUserId(req);
  const itemId = String(req.body?.itemId ?? "");
  const amount = PRICE_LIST[itemId];
  if (!amount) return res.status(404).json({ error: "unknown item" });

  const requestId = newRequestId();
  // Persist BEFORE redirecting: the notification is matched on requestId.
  orders.set(requestId, { requestId, userId, itemId, amount, state: "PENDING" });
  const { url } = buildOneTimeUrl({ amount, requestId });

  console.info("[digimart] checkout", { requestId, itemId, amount });
  // Server-rendered web: 302. SPA or mobile web view: hand back the URL to open.
  return wantsJson(req) ? res.json({ url, requestId }) : res.redirect(302, url);
});

router.post("/digimart/subscribe", (req: Request, res: Response) => {
  const userId = currentUserId(req);
  const requestId = newRequestId();
  const record: Subscriber = { userId, requestId };
  subscriptionsByRequestId.set(requestId, record);
  subscribersByUser.set(userId, record);
  const { url } = buildSubscriptionUrl({ requestId });

  console.info("[digimart] subscribe", { requestId });
  return wantsJson(req) ? res.json({ url, requestId }) : res.redirect(302, url);
});

/* ── The redirect page — picks a screen, grants nothing ──────────────────── */

const SCREENS: Record<string, string> = {
  success: "Payment received — confirming…",
  "user-state": "",
  transient: "Something went wrong on our side. Please try again.",
  client: "Sorry, we couldn't start the payment. Please try again later.",
  configuration: "Payments are temporarily unavailable.",
};

router.get("/digimart/return", (req: Request, res: Response) => {
  const status = String(req.query.subscriptionStatus ?? "");
  const requestId = String(req.query.requestId ?? "");
  const subscriberId = String(req.query.subscriberId ?? "");

  const order = orders.get(requestId);
  const sub = subscriptionsByRequestId.get(requestId);
  if (!order && !sub) return res.status(200).send("We couldn't find that payment.");

  // Provisional only — anyone can type this URL. The notification confirms it.
  if (sub && subscriberId && !sub.subscriberId) {
    sub.subscriberId = subscriberId;
    sub.provisional = true;
  }

  const outcome = classifySdkCode(status);
  if (outcome === "configuration" || outcome === "client") {
    console.error("[digimart] redirect failure — our bug or configuration", { requestId, status });
  }

  let message = SCREENS[outcome] ?? SCREENS.client;
  if (status === "E3009") message = "Your balance is too low. Please recharge and try again.";
  else if (status === "E3001") message = "You're already subscribed.";
  else if (status === "E4001") message = "That code wasn't right. Please try again.";
  else if (outcome === "user-state") message = "This number can't complete the payment right now. Please try again later.";

  // Never show the raw code. On success, the page polls YOUR order status.
  return res.status(200).json({ requestId, message, pending: status === "S1000" });
});

/* ── Notifications — 200 first, then verify, dedupe, settle ──────────────── */

const settledAmount = (v: unknown) => (v === undefined || v === null ? NaN : Number(v));

function handleChargingNotification(body: Record<string, unknown>) {
  if (body.applicationId !== undefined && body.applicationId !== config.applicationId) {
    return console.warn("[digimart] charging notification for another application — ignored");
  }
  const requestId = String(body.requestId ?? "");
  const statusCode = String(body.statusCode ?? "");
  const key = `charge:${body.internalTrxId ?? requestId}:${statusCode}`;
  if (seen.has(key)) return; // replay — already handled
  seen.add(key);

  console.info("[digimart] charging notification", {
    requestId, statusCode, internalTrxId: body.internalTrxId, subscriberId: maskId(String(body.subscriberId ?? "")),
  });

  const order = orders.get(requestId);
  if (!order) {
    // Could be a header-enrichment subscription charge.
    const sub = subscriptionsByRequestId.get(requestId);
    if (sub && statusCode === "S1000") {
      if (body.subscriberId) sub.subscriberId = String(body.subscriberId);
      sub.provisional = false;
      sub.status = "REGISTERED";
    }
    return;
  }
  if (order.state === "PAID" || order.state === "FULFILLED") return;

  if (statusCode !== "S1000") {
    order.state = "FAILED";
    return;
  }
  // Compare as decimals; paidAmount is a string in the sample, balanceDue a number.
  const paid = settledAmount(body.paidAmount);
  const due = settledAmount(body.balanceDue ?? 0);
  if (paid !== Number(order.amount) || due !== 0) {
    console.error("[digimart] amount mismatch — held for review", { requestId, paid, expected: order.amount, due });
    return;
  }
  order.state = "PAID";
  order.internalTrxId = body.internalTrxId ? String(body.internalTrxId) : undefined;
  fulfil(order);
}

function fulfil(order: Order) {
  // Deliver exactly once, then mark it.
  order.state = "FULFILLED";
}

function handleSubscriptionNotification(body: Record<string, unknown>) {
  if (body.applicationId !== undefined && body.applicationId !== config.applicationId) {
    return console.warn("[digimart] subscription notification for another application — ignored");
  }
  const subscriberId = String(body.subscriberId ?? "");
  const status = String(body.status ?? "");
  if (!subscriberId || !status) return console.warn("[digimart] subscription notification missing fields");

  const key = `sub:${subscriberId}:${status}:${body.timeStamp ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);

  const sub = subscriptionsByRequestId.get(String(body.subscriberRequestId ?? ""));
  if (!sub) return console.warn("[digimart] subscription notification for an unknown requestId", { subscriberId: maskId(subscriberId) });

  // The authoritative mapping.
  sub.subscriberId = subscriberId;
  sub.provisional = false;
  sub.status = status; // REGISTERED → grant, REG_PENDING → hold, TEMPORARY_BLOCKED → suspend
  sub.frequency = body.frequency ? String(body.frequency) : sub.frequency;
}

/** Acknowledge immediately; do the work after the response is sent. */
function acknowledgeThen(work: (body: Record<string, unknown>) => void) {
  return (req: Request, res: Response) => {
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    res.status(200).json({ received: true }); // no response body is published; do not rely on it
    // In production: enqueue (BullMQ, SQS, …) instead of setImmediate.
    setImmediate(() => {
      try {
        work(body);
      } catch (err) {
        console.error("[digimart] notification processing failed", err);
      }
    });
  };
}

router.post("/api/digimart/charging/notify", acknowledgeThen(handleChargingNotification));
router.post("/api/digimart/subscription/notify", acknowledgeThen(handleSubscriptionNotification));

/* ── Cancel — the id comes from YOUR store, never the client ─────────────── */

router.post("/digimart/unsubscribe", async (req: Request, res: Response) => {
  const userId = currentUserId(req);
  const sub = subscribersByUser.get(userId);
  if (!sub?.subscriberId) return res.status(404).json({ error: "no active subscription" });

  try {
    const status = await unsubscribe(fromTel(sub.subscriberId));
    if (status === "UNREGISTERED") sub.status = "UNREGISTERED"; // end access now — no notification is documented
    return res.json({ status });
  } catch (err) {
    console.error("[digimart] unsubscribe failed — keep the request and retry", err);
    return res.status(502).json({ error: "could not cancel right now" });
  }
});

/* Malformed JSON on a notification route must still get a 200. */
router.use((err: unknown, req: Request, res: Response, _next: unknown) => {
  if (req.path.startsWith("/api/digimart/")) return res.status(200).json({ received: true });
  const status = (err as { status?: number })?.status ?? 500;
  return res.status(status).json({ error: status === 401 ? "unauthenticated" : "error" });
});

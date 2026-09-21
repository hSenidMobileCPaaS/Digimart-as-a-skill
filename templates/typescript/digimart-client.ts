/**
 * Digimart client — the URL signer and the REST client.
 *
 * Two halves, because Digimart has two surfaces:
 *
 *   1. Charging (subscription and one-time) is a SIGNED URL that the customer's
 *      browser opens. Nothing is POSTed. `buildSubscriptionUrl()` and
 *      `buildOneTimeUrl()` return the URL; your start endpoint redirects to it.
 *
 *   2. Subscriber management is REST on a different host with a different
 *      credential. One `post()` injects applicationId + password, times out, and
 *      decides success on `statusCode` in the body.
 *
 * Every rule here comes from https://digimart.store/docs. Where the published
 * sources disagree, see references/12-source-discrepancies.md.
 *
 * SERVER-SIDE ONLY.
 */

import { createHash, randomInt } from "node:crypto";
import { config, requireEndpoint } from "./digimart-config";

/** A single REST call should never hang. Protocol constant, not config. */
const TIMEOUT_MS = 15_000;

/** The published one-time band, in BDT. Outside it: E1330 (low) / E1329 (high). */
export const ONE_TIME_MIN = 1;
export const ONE_TIME_MAX = 600;

/*
 * TLS: Node verifies certificates by default. If a host ever serves an
 * incomplete chain, supply the intermediate CA to the agent — never disable
 * verification, which would expose the App Password on the wire.
 */

/* ── Signing ─────────────────────────────────────────────────────────────── */

/**
 * The current instant as Digimart's requestTime: 2024-07-08T10:33:54.929Z.
 *
 * Digimart says "generate it in Asia/Dhaka"; every published sample produces
 * the true UTC instant, which is what toISOString() gives. Never write Dhaka
 * wall-clock time with a Z — that is six hours wrong (E1004).
 */
export function requestTimeNow(): string {
  return new Date().toISOString();
}

/**
 * A fresh 15-digit requestId, first digit non-zero. Random rather than derived
 * from the clock, which collides under load (E1005). Persist it BEFORE the
 * redirect — the redirect and the notification are matched on it.
 */
export function newRequestId(): string {
  const head = randomInt(1_000_000, 10_000_000); // 7 digits
  const tail = randomInt(0, 100_000_000); // 8 digits
  return `${head}${String(tail).padStart(8, "0")}`;
}

/**
 * SHA-512 over the pipe-joined fields, lowercase hex.
 *
 *   subscription: apiKey|requestTime|apiSecret
 *   one-time:     apiKey|requestTime|apiSecret|amount
 *
 * The secret sits in the MIDDLE. Hash the raw values; the query-string encoder
 * runs afterwards.
 *
 * Known answer (put it in your test suite):
 *   sign(["myApiKey123", "2024-08-08T12:00:00Z", "mySecretKey456", "50"])
 *   === "3badf638ceca499000fd07b899e5fc0cec348d9762886b8430104291126683892845a208caef8e99b53432571e46c5f04162a1a25646443f7935239ea0901b38"
 */
export function sign(fields: string[]): string {
  return createHash("sha512").update(fields.join("|"), "utf8").digest("hex");
}

/** Format an amount ONCE; the same string goes into the hash and the URL. */
export function formatAmount(amount: number | string): string {
  const text = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`[digimart] amount must be a plain number, got "${text}"`);
  const n = Number(text);
  if (n < ONE_TIME_MIN || n > ONE_TIME_MAX) {
    throw new Error(`[digimart] amount ${text} is outside ${ONE_TIME_MIN}-${ONE_TIME_MAX} BDT (E1330/E1329)`);
  }
  return text;
}

export interface AuthorizeUrl {
  url: string;
  requestId: string;
  requestTime: string;
}

function authorizeUrl(base: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) query.set(k, v);
  return `${base}?${query.toString()}`;
}

/**
 * The subscription flow. `amount` is only for the header-enrichment variant,
 * which lists it as a parameter — it is NOT signed on a subscription.
 */
export function buildSubscriptionUrl(opts: { msisdn?: string; heAmount?: string; requestId?: string } = {}): AuthorizeUrl {
  const base = requireEndpoint("subscriptionAuthorize");
  const requestId = opts.requestId ?? newRequestId();
  const requestTime = requestTimeNow();
  const signature = sign([config.apiKey, requestTime, config.apiSecret]);
  return {
    url: authorizeUrl(base, {
      apiKey: config.apiKey,
      requestId,
      requestTime,
      signature,
      redirectUrl: config.redirectUrl,
      msisdn: opts.msisdn,
      amount: opts.heAmount,
    }),
    requestId,
    requestTime,
  };
}

/**
 * The one-time (CaaS) flow. The amount is signed AND sent — as one string.
 * Take it from your own price list, never from the client.
 */
export function buildOneTimeUrl(opts: { amount: number | string; msisdn?: string; requestId?: string }): AuthorizeUrl {
  const base = requireEndpoint("caasAuthorize");
  const amount = formatAmount(opts.amount);
  const requestId = opts.requestId ?? newRequestId();
  const requestTime = requestTimeNow();
  const signature = sign([config.apiKey, requestTime, config.apiSecret, amount]);
  return {
    url: authorizeUrl(base, {
      apiKey: config.apiKey,
      requestId,
      requestTime,
      signature,
      redirectUrl: config.redirectUrl,
      msisdn: opts.msisdn,
      amount,
    }),
    requestId,
    requestTime,
  };
}

/* ── Status codes ────────────────────────────────────────────────────────── */

/** SDK codes, as they arrive on the redirect and the charging notification. */
export const SDK_CONFIGURATION = new Set(["E1006", "E1007", "E1008", "E1010", "E1011"]);
export const SDK_TRANSIENT = new Set(["E1001", "E1013", "E2001", "E2003", "E2004"]);
export const SDK_USER_STATE = new Set([
  "E1014", "E2002", "E3001", "E3002", "E3003", "E3004", "E3005", "E3006", "E3007", "E3009", "E4001",
]);

export type SdkOutcome = "success" | "configuration" | "transient" | "user-state" | "client";

export function classifySdkCode(code: string): SdkOutcome {
  if (code === "S1000") return "success";
  if (SDK_CONFIGURATION.has(code)) return "configuration";
  if (SDK_TRANSIENT.has(code)) return "transient";
  if (SDK_USER_STATE.has(code)) return "user-state";
  return "client";
}

/**
 * REST success is per call. Subscriber List also permits S1001, which Digimart
 * does not describe; it is S-prefixed, so it is not raised as an error.
 * E1100-E1107 have no published meaning — statusDetail is the only explanation.
 */
export const REST_SUCCESS = {
  default: ["S1000"] as const,
  getSubscribers: ["S1000", "S1001"] as const,
};

export class DigimartError extends Error {
  readonly statusCode: string;
  readonly statusDetail: string;
  readonly requestId: string | undefined;
  readonly service: string;

  constructor(statusCode: string, statusDetail: string, requestId: string | undefined, service: string) {
    super(`[${statusCode}] ${statusDetail} (${service}${requestId ? `, requestId ${requestId}` : ""})`);
    this.name = "DigimartError";
    this.statusCode = statusCode;
    this.statusDetail = statusDetail;
    this.requestId = requestId;
    this.service = service;
  }
}

/* ── Addressing ──────────────────────────────────────────────────────────── */

/**
 * The redirect and the notifications hand you a bare masked subscriberId; the
 * REST calls want tel:<value>, with no space. The ONLY place tel: is added.
 */
export function toTel(subscriberId: string): string {
  const bare = fromTel(subscriberId);
  if (!bare) throw new Error("[digimart] empty subscriberId");
  return `tel:${bare}`;
}

/** Strip tel: (and the space some published examples put after it). */
export function fromTel(value: string): string {
  return String(value ?? "").trim().replace(/^tel:\s*/i, "");
}

/** For logs. Never log the raw value. */
export function maskId(value: string): string {
  const s = fromTel(value);
  return s.length <= 8 ? "***" : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/* ── REST ────────────────────────────────────────────────────────────────── */

interface RestEnvelope {
  version?: string;
  statusCode?: string;
  statusDetail?: string;
  requestId?: string;
}

async function post<T extends RestEnvelope>(
  service: "getSubscribers" | "chargingInfo" | "unregistration",
  body: Record<string, unknown>,
  success: readonly string[] = REST_SUCCESS.default
): Promise<T> {
  const url = requireEndpoint(service);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=utf-8" },
    // Credentials are injected here and nowhere else.
    body: JSON.stringify({ applicationId: config.applicationId, password: config.password, ...body }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  let json: T;
  try {
    json = (await res.json()) as T;
  } catch {
    throw new DigimartError(`HTTP${res.status}`, "Response was not JSON", undefined, service);
  }
  // The body decides, not the HTTP status.
  const code = json.statusCode ?? "";
  if (!success.includes(code)) {
    throw new DigimartError(code || `HTTP${res.status}`, json.statusDetail ?? "no statusDetail", json.requestId, service);
  }
  return json;
}

export interface SubscriberEntry {
  subscriberId: string;
  subscriberRequestId?: string;
  subscriptionStatus?: string;
  lastChargedDate?: string;
  lastChargedAmount?: string;
}

/**
 * One page of subscribers. requestPage is the ONLY integer in any Digimart body.
 * `subscribers` is typed as one object in the spec and an array in the example:
 * normalised here.
 */
export async function getSubscribers(
  requestPage: number,
  filter: { status?: "REGISTERED" | "TEMPORARY_BLOCKED" | "REG_PENDING"; subscriberRequestId?: string } = {}
) {
  const res = await post<RestEnvelope & {
    nextPageNumber?: number;
    moreDataAvailable?: boolean;
    subscribers?: SubscriberEntry | SubscriberEntry[];
  }>("getSubscribers", { version: "2.0", requestPage, ...filter }, REST_SUCCESS.getSubscribers);

  const subscribers = res.subscribers === undefined ? [] : Array.isArray(res.subscribers) ? res.subscribers : [res.subscribers];
  const hasMore = res.moreDataAvailable === true && res.nextPageNumber !== -1;
  return { subscribers, nextPage: hasMore ? res.nextPageNumber ?? null : null, statusCode: res.statusCode, requestId: res.requestId };
}

/** Walk every page. Use from a scheduled reconciliation job. */
export async function* allSubscribers(filter?: Parameters<typeof getSubscribers>[1]) {
  let page: number | null = 1;
  while (page !== null) {
    const result = await getSubscribers(page, filter);
    yield* result.subscribers;
    page = result.nextPage;
  }
}

/**
 * Current state and last charge for up to a list of subscribers. subscriberId
 * is an ARRAY. Read every entry's statusCode: one can fail under a top-level S1000.
 */
export async function getChargingInfo(subscriberIds: string[]) {
  const res = await post<RestEnvelope & {
    destinationResponses?: Array<SubscriberEntry & { numberType?: string; statusCode?: string; statusDetail?: string }>;
  }>("chargingInfo", { subscriberId: subscriberIds.map(toTel) });
  return (res.destinationResponses ?? []).map((d) => ({ ...d, ok: d.statusCode === "S1000" }));
}

/**
 * End a subscription. ONE subscriber, a string; action is the string "0".
 * Take the id from your own store — never from the client.
 */
export async function unsubscribe(subscriberId: string): Promise<string> {
  const res = await post<RestEnvelope & { subscriptionStatus?: string }>("unregistration", {
    subscriberId: toTel(subscriberId),
    action: "0",
  });
  // The published schema example writes "UNREGISTERED." — trim punctuation.
  return String(res.subscriptionStatus ?? "").replace(/[\s.]+$/, "");
}

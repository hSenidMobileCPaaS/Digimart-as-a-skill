"""
The endpoints YOU build for Digimart, on FastAPI.

  POST /digimart/checkout                 start a one-time charge   (your users call this)
  POST /digimart/subscribe                start a subscription      (your users call this)
  GET  /digimart/return                   the redirectUrl           (the customer's browser)
  POST /api/digimart/charging/notify      Async charging resp URL   (Digimart's server)
  POST /api/digimart/subscription/notify  Subscription Notification URL (Digimart's server)
  POST /digimart/unsubscribe              your cancel button        (your users call this)

Rules that shape everything below:
  - the redirect is UNTRUSTED — it picks a screen and grants nothing;
  - the notification is the record — acknowledge 200 first (BackgroundTasks),
    verify, dedupe, settle once;
  - the secret, the price and the requestId never come from a client.

Django / Flask: the same handlers; use a Celery or RQ task for the background
work and exempt the notification views from CSRF (@csrf_exempt).
"""

from __future__ import annotations

import json
import logging
from decimal import Decimal, InvalidOperation

from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse

from digimart_client import (
    build_one_time_url,
    build_subscription_url,
    classify_sdk_code,
    from_tel,
    mask_id,
    new_request_id,
    unsubscribe,
)
from digimart_config import config

log = logging.getLogger("digimart")
app = FastAPI()

# ── State ────────────────────────────────────────────────────────────────────
# In-process so the file runs as-is. In production: database tables (orders by
# requestId, subscribers by your user id) and a unique constraint or Redis
# SET NX for the dedupe keys, shared by every worker.

ORDERS: dict[str, dict] = {}
SUBS_BY_REQUEST_ID: dict[str, dict] = {}
SUBS_BY_USER: dict[str, dict] = {}
SEEN: set[str] = set()

# The amount is signed — it must come from here, never from the request.
PRICE_LIST = {"premium-article": "10", "credits-100": "50"}


def current_user(x_user_id: str | None) -> str:
    # Replace with your authentication.
    if not x_user_id:
        raise HTTPException(401, "unauthenticated")
    return x_user_id


def _respond(request: Request, url: str, request_id: str):
    if "application/json" in request.headers.get("accept", ""):
        return {"url": url, "requestId": request_id}  # SPA / mobile web view opens it
    return RedirectResponse(url, status_code=302)


# ── Start endpoints ──────────────────────────────────────────────────────────


@app.post("/digimart/checkout")
async def checkout(request: Request, x_user_id: str | None = Header(default=None)):
    user_id = current_user(x_user_id)
    body = await request.json()
    amount = PRICE_LIST.get(str(body.get("itemId", "")))
    if not amount:
        raise HTTPException(404, "unknown item")

    request_id = new_request_id()
    # Persist BEFORE redirecting — the notification is matched on requestId.
    ORDERS[request_id] = {"user_id": user_id, "item_id": body["itemId"], "amount": amount, "state": "PENDING"}
    built = build_one_time_url(amount=amount, request_id=request_id)
    log.info("digimart checkout requestId=%s amount=%s", request_id, amount)
    return _respond(request, built.url, request_id)


@app.post("/digimart/subscribe")
async def subscribe(request: Request, x_user_id: str | None = Header(default=None)):
    user_id = current_user(x_user_id)
    request_id = new_request_id()
    record = {"user_id": user_id, "request_id": request_id}
    SUBS_BY_REQUEST_ID[request_id] = record
    SUBS_BY_USER[user_id] = record
    built = build_subscription_url(request_id=request_id)
    return _respond(request, built.url, request_id)


# ── Redirect page — picks a screen, grants nothing ──────────────────────────


@app.get("/digimart/return")
async def redirect_return(subscriptionStatus: str = "", subscriberId: str = "", requestId: str = ""):
    order = ORDERS.get(requestId)
    sub = SUBS_BY_REQUEST_ID.get(requestId)
    if not order and not sub:
        return {"message": "We couldn't find that payment."}

    if sub and subscriberId and not sub.get("subscriber_id"):
        sub.update(subscriber_id=subscriberId, provisional=True)  # confirmed by the notification

    outcome = classify_sdk_code(subscriptionStatus)
    if outcome in ("client", "configuration"):
        log.error("digimart redirect failure requestId=%s code=%s", requestId, subscriptionStatus)

    messages = {
        "S1000": "Payment received — confirming…",
        "E3009": "Your balance is too low. Please recharge and try again.",
        "E3001": "You're already subscribed.",
        "E4001": "That code wasn't right. Please try again.",
    }
    fallback = {
        "user-state": "This number can't complete the payment right now. Please try again later.",
        "transient": "Something went wrong on our side. Please try again.",
    }.get(outcome, "Sorry, we couldn't start the payment. Please try again later.")
    # Never the raw code. On S1000 the page polls YOUR order status.
    return {"requestId": requestId, "message": messages.get(subscriptionStatus, fallback),
            "pending": subscriptionStatus == "S1000"}


# ── Notifications — 200 first, then verify, dedupe, settle ──────────────────


def _decimal(value) -> Decimal | None:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError):
        return None


def process_charging(body: dict) -> None:
    if body.get("applicationId") not in (None, config.application_id):
        return log.warning("digimart charging notification for another application — ignored")
    request_id = str(body.get("requestId", ""))
    status_code = str(body.get("statusCode", ""))
    key = f"charge:{body.get('internalTrxId') or request_id}:{status_code}"
    if key in SEEN:
        return
    SEEN.add(key)
    log.info("digimart charging requestId=%s statusCode=%s internalTrxId=%s subscriber=%s",
             request_id, status_code, body.get("internalTrxId"), mask_id(str(body.get("subscriberId", ""))))

    order = ORDERS.get(request_id)
    if order is None:
        sub = SUBS_BY_REQUEST_ID.get(request_id)  # a header-enrichment subscription charge
        if sub and status_code == "S1000":
            sub.update(subscriber_id=body.get("subscriberId") or sub.get("subscriber_id"),
                       provisional=False, status="REGISTERED")
        return
    if order["state"] in ("PAID", "FULFILLED"):
        return
    if status_code != "S1000":
        order["state"] = "FAILED"
        return

    paid, due = _decimal(body.get("paidAmount")), _decimal(body.get("balanceDue", 0))
    if paid != Decimal(order["amount"]) or due != 0:
        return log.error("digimart amount mismatch requestId=%s paid=%s expected=%s due=%s",
                         request_id, paid, order["amount"], due)
    order.update(state="PAID", internal_trx_id=body.get("internalTrxId"))
    order["state"] = "FULFILLED"  # deliver exactly once here


def process_subscription(body: dict) -> None:
    if body.get("applicationId") not in (None, config.application_id):
        return log.warning("digimart subscription notification for another application — ignored")
    subscriber_id, status = str(body.get("subscriberId", "")), str(body.get("status", ""))
    if not subscriber_id or not status:
        return log.warning("digimart subscription notification missing fields")
    key = f"sub:{subscriber_id}:{status}:{body.get('timeStamp', '')}"
    if key in SEEN:
        return
    SEEN.add(key)

    sub = SUBS_BY_REQUEST_ID.get(str(body.get("subscriberRequestId", "")))
    if not sub:
        return log.warning("digimart subscription notification for unknown requestId, subscriber=%s", mask_id(subscriber_id))
    # REGISTERED → grant, REG_PENDING → hold, TEMPORARY_BLOCKED → suspend
    sub.update(subscriber_id=subscriber_id, provisional=False, status=status,
               frequency=body.get("frequency", sub.get("frequency")))


async def _body(request: Request) -> dict:
    try:
        data = json.loads(await request.body() or b"{}")
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


@app.post("/api/digimart/charging/notify")
async def charging_notify(request: Request, background: BackgroundTasks):
    background.add_task(process_charging, await _body(request))
    return JSONResponse({"received": True})  # no response body is published; always 200


@app.post("/api/digimart/subscription/notify")
async def subscription_notify(request: Request, background: BackgroundTasks):
    background.add_task(process_subscription, await _body(request))
    return JSONResponse({"received": True})


# ── Cancel — the id comes from YOUR store, never the client ─────────────────


@app.post("/digimart/unsubscribe")
async def cancel(x_user_id: str | None = Header(default=None)):
    user_id = current_user(x_user_id)
    sub = SUBS_BY_USER.get(user_id)
    if not sub or not sub.get("subscriber_id"):
        raise HTTPException(404, "no active subscription")
    try:
        status = unsubscribe(from_tel(sub["subscriber_id"]))
    except Exception:
        log.exception("digimart unsubscribe failed — keep the request and retry")
        raise HTTPException(502, "could not cancel right now")
    if status == "UNREGISTERED":
        sub["status"] = "UNREGISTERED"  # end access now — no notification is documented
    return {"status": status}

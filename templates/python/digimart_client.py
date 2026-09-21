"""
Digimart client — the URL signer and the REST client. Standard library only.

Two halves, because Digimart has two surfaces:

  1. Charging (subscription and one-time) is a SIGNED URL that the customer's
     browser opens. Nothing is POSTed. build_subscription_url() and
     build_one_time_url() return the URL; your start endpoint redirects to it.

  2. Subscriber management is REST on a different host with a different
     credential. One _post() injects applicationId + password, times out, and
     decides success on statusCode in the body.

Using httpx or requests instead of urllib is a two-line change in _post();
keep TLS verification on — never turn certificate verification off.

SERVER-SIDE ONLY.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import secrets
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

from digimart_config import config

log = logging.getLogger("digimart")

TIMEOUT_SECONDS = 15
ONE_TIME_MIN = Decimal("1")
ONE_TIME_MAX = Decimal("600")

# ── Signing ──────────────────────────────────────────────────────────────────


def request_time_now() -> str:
    """The current instant as 2024-07-08T10:33:54.929Z — true UTC, never Dhaka wall-clock with a Z."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_request_id() -> str:
    """15 digits, first non-zero, random — never the millisecond clock (collides: E1005)."""
    return str(secrets.randbelow(9 * 10**14) + 10**14)


def sign(fields: list[str]) -> str:
    """
    SHA-512 over the pipe-joined fields, lowercase hex.

      subscription: apiKey|requestTime|apiSecret
      one-time:     apiKey|requestTime|apiSecret|amount

    Known answer (keep it in your tests):
      sign(["myApiKey123", "2024-08-08T12:00:00Z", "mySecretKey456", "50"]) ==
      "3badf638ceca499000fd07b899e5fc0cec348d9762886b8430104291126683892845a208caef8e99b53432571e46c5f04162a1a25646443f7935239ea0901b38"
    """
    return hashlib.sha512("|".join(fields).encode("utf-8")).hexdigest()


def format_amount(amount: str | int | Decimal) -> str:
    """Format ONCE; the same string goes into the hash and the URL."""
    text = str(amount).strip()
    if not re.fullmatch(r"\d+(\.\d+)?", text):
        raise ValueError(f"[digimart] amount must be a plain number, got {text!r}")
    try:
        value = Decimal(text)
    except InvalidOperation as exc:  # pragma: no cover
        raise ValueError(text) from exc
    if not ONE_TIME_MIN <= value <= ONE_TIME_MAX:
        raise ValueError(f"[digimart] amount {text} is outside 1-600 BDT (E1330/E1329)")
    return text


@dataclass(frozen=True)
class AuthorizeUrl:
    url: str
    request_id: str
    request_time: str


def _authorize_url(base: str, params: dict[str, str | None]) -> str:
    return base + "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})


def build_subscription_url(*, msisdn: str | None = None, he_amount: str | None = None,
                           request_id: str | None = None) -> AuthorizeUrl:
    """Subscription flow. he_amount only for the header-enrichment variant — it is NOT signed."""
    base = config.require_endpoint("subscription_authorize")
    request_id = request_id or new_request_id()
    request_time = request_time_now()
    signature = sign([config.api_key, request_time, config.api_secret])
    url = _authorize_url(base, {
        "apiKey": config.api_key,
        "requestId": request_id,
        "requestTime": request_time,
        "signature": signature,
        "redirectUrl": config.redirect_url,
        "msisdn": msisdn,
        "amount": he_amount,
    })
    return AuthorizeUrl(url, request_id, request_time)


def build_one_time_url(*, amount: str | int | Decimal, msisdn: str | None = None,
                       request_id: str | None = None) -> AuthorizeUrl:
    """One-time (CaaS) flow. The amount is signed AND sent. Take it from your price list."""
    base = config.require_endpoint("caas_authorize")
    amount_text = format_amount(amount)
    request_id = request_id or new_request_id()
    request_time = request_time_now()
    signature = sign([config.api_key, request_time, config.api_secret, amount_text])
    url = _authorize_url(base, {
        "apiKey": config.api_key,
        "requestId": request_id,
        "requestTime": request_time,
        "signature": signature,
        "redirectUrl": config.redirect_url,
        "msisdn": msisdn,
        "amount": amount_text,
    })
    return AuthorizeUrl(url, request_id, request_time)


# ── Status codes ─────────────────────────────────────────────────────────────

SDK_CONFIGURATION = {"E1006", "E1007", "E1008", "E1010", "E1011"}
SDK_TRANSIENT = {"E1001", "E1013", "E2001", "E2003", "E2004"}
SDK_USER_STATE = {"E1014", "E2002", "E3001", "E3002", "E3003", "E3004", "E3005", "E3006", "E3007", "E3009", "E4001"}


def classify_sdk_code(code: str) -> str:
    """success | configuration | transient | user-state | client"""
    if code == "S1000":
        return "success"
    if code in SDK_CONFIGURATION:
        return "configuration"
    if code in SDK_TRANSIENT:
        return "transient"
    if code in SDK_USER_STATE:
        return "user-state"
    return "client"


# REST success is per call. Subscriber List also permits S1001 (no published
# meaning; S-prefixed, so not an error). E1100-E1107 have no published meaning.
REST_SUCCESS_DEFAULT = frozenset({"S1000"})
REST_SUCCESS_GET_SUBSCRIBERS = frozenset({"S1000", "S1001"})


class DigimartError(Exception):
    def __init__(self, status_code: str, status_detail: str, request_id: str | None, service: str):
        super().__init__(f"[{status_code}] {status_detail} ({service}, requestId {request_id})")
        self.status_code = status_code
        self.status_detail = status_detail
        self.request_id = request_id
        self.service = service


# ── Addressing ───────────────────────────────────────────────────────────────


def from_tel(value: str) -> str:
    """Strip tel: and the space some published examples put after it."""
    return re.sub(r"^tel:\s*", "", str(value or "").strip(), flags=re.IGNORECASE)


def to_tel(subscriber_id: str) -> str:
    """The ONLY place tel: is added. No space after the colon."""
    bare = from_tel(subscriber_id)
    if not bare:
        raise ValueError("[digimart] empty subscriberId")
    return f"tel:{bare}"


def mask_id(value: str) -> str:
    s = from_tel(value)
    return "***" if len(s) <= 8 else f"{s[:4]}…{s[-4:]}"


# ── REST ─────────────────────────────────────────────────────────────────────


def _post(service: str, body: dict, success: frozenset[str] = REST_SUCCESS_DEFAULT) -> dict:
    url = config.require_endpoint(service)
    payload = {"applicationId": config.application_id, "password": config.password, **body}
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json;charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        raw = exc.read()
    try:
        data = json.loads(raw or b"{}")
    except json.JSONDecodeError:
        raise DigimartError("NOT_JSON", "Response was not JSON", None, service)

    code = data.get("statusCode", "")
    if code not in success:  # the body decides, not the HTTP status
        raise DigimartError(code or "NO_CODE", data.get("statusDetail", "no statusDetail"), data.get("requestId"), service)
    return data


def get_subscribers(request_page: int, *, status: str | None = None,
                    subscriber_request_id: str | None = None) -> dict:
    """One page. request_page is the ONLY integer in any Digimart body."""
    body: dict = {"version": "2.0", "requestPage": int(request_page)}
    if status:
        body["status"] = status  # REGISTERED | TEMPORARY_BLOCKED | REG_PENDING
    if subscriber_request_id:
        body["subscriberRequestId"] = subscriber_request_id
    data = _post("get_subscribers", body, REST_SUCCESS_GET_SUBSCRIBERS)

    subs = data.get("subscribers") or []
    if isinstance(subs, dict):  # typed as one object in the spec, an array in the example
        subs = [subs]
    has_more = data.get("moreDataAvailable") is True and data.get("nextPageNumber") != -1
    return {"subscribers": subs, "next_page": data.get("nextPageNumber") if has_more else None,
            "status_code": data.get("statusCode"), "request_id": data.get("requestId")}


def all_subscribers(**filters):
    """Walk every page — for a scheduled reconciliation job."""
    page = 1
    while page is not None:
        result = get_subscribers(page, **filters)
        yield from result["subscribers"]
        page = result["next_page"]


def get_charging_info(subscriber_ids: list[str]) -> list[dict]:
    """subscriberId is an ARRAY. Read each entry's statusCode — one can fail under a top-level S1000."""
    data = _post("charging_info", {"subscriberId": [to_tel(s) for s in subscriber_ids]})
    return [{**d, "ok": d.get("statusCode") == "S1000"} for d in data.get("destinationResponses") or []]


def unsubscribe(subscriber_id: str) -> str:
    """ONE subscriber, a string; action is the string "0". The id comes from YOUR store."""
    data = _post("unregistration", {"subscriberId": to_tel(subscriber_id), "action": "0"})
    return str(data.get("subscriptionStatus", "")).rstrip(" .")

"""
Digimart configuration — the ONLY module that reads os.environ.

Two surfaces, two credentials:
  - the charging SDK (signed URLs on user.digimart.store): API Key + API Secret
  - the REST APIs (JSON on api.digimart.store): applicationId + App Password
plus one URL per flow or call you actually use.

An endpoint that is not set means you do not use that service; the client
refuses to use it with a message naming the variable.

Validation runs at import, so a misconfigured deployment fails at boot.

SERVER-SIDE ONLY. The API Secret can charge your customers.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _optional(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None


def _required(name: str, why: str) -> str:
    value = _optional(name)
    if not value:
        raise RuntimeError(
            f"[digimart] Missing required environment variable {name} ({why}). "
            "Copy templates/.env.example to .env, or set it in your host's secret manager."
        )
    return value


ENDPOINT_VARIABLES = {
    "subscription_authorize": "DIGIMART_SUBSCRIPTION_AUTHORIZE_URL",
    "caas_authorize": "DIGIMART_CAAS_AUTHORIZE_URL",
    "get_subscribers": "DIGIMART_GET_SUBSCRIBERS_URL",
    "charging_info": "DIGIMART_CHARGING_INFO_URL",
    "unregistration": "DIGIMART_UNREGISTRATION_URL",
}


@dataclass(frozen=True)
class DigimartConfig:
    application_id: str
    api_key: str
    api_secret: str = field(repr=False)
    redirect_url: str
    password: str = field(repr=False)
    endpoints: dict[str, str | None]

    def require_endpoint(self, service: str) -> str:
        url = self.endpoints.get(service)
        if not url:
            raise RuntimeError(
                f"[digimart] {service} is not configured. Set {ENDPOINT_VARIABLES[service]}; see .env.example."
            )
        return url

    def describe(self) -> dict:
        """Redacted view, safe to log at startup."""
        return {
            "application_id": self.application_id,
            "api_key": (self.api_key[:4] + "…") if self.api_key else "(unset)",
            "api_secret": "***redacted***" if self.api_secret else "(unset)",
            "password": "***redacted***" if self.password else "(unset)",
            "enabled": [k for k, v in self.endpoints.items() if v],
        }


def load_config() -> DigimartConfig:
    endpoints = {key: _optional(var) for key, var in ENDPOINT_VARIABLES.items()}
    uses_sdk = bool(endpoints["subscription_authorize"] or endpoints["caas_authorize"])
    uses_rest = bool(endpoints["get_subscribers"] or endpoints["charging_info"] or endpoints["unregistration"])

    redirect_url = _required("DIGIMART_REDIRECT_URL", "an authorize URL is configured") if uses_sdk else ""
    if uses_sdk and not redirect_url.startswith("https://"):
        raise RuntimeError("[digimart] DIGIMART_REDIRECT_URL must be an absolute https:// URL.")

    return DigimartConfig(
        application_id=_required("DIGIMART_APP_ID", "every notification is verified against it"),
        api_key=_required("DIGIMART_API_KEY", "an authorize URL is configured") if uses_sdk else "",
        api_secret=_required("DIGIMART_API_SECRET", "an authorize URL is configured") if uses_sdk else "",
        redirect_url=redirect_url,
        password=_required("DIGIMART_PASSWORD", "a REST endpoint is configured") if uses_rest else "",
        endpoints=endpoints,
    )


config = load_config()

/**
 * Digimart configuration — the ONLY module that reads process.env.
 *
 * Two surfaces, two credentials:
 *   - the charging SDK (signed URLs on user.digimart.store): API Key + API Secret
 *   - the REST APIs (JSON on api.digimart.store): applicationId + App Password
 * plus one URL per flow or call you actually use. Nothing else is
 * configuration: timeouts and the signing rules are constants in the client.
 *
 * An endpoint that is not set means you do not use that service. The client
 * refuses to use it, so you get a clear local error naming the variable.
 *
 * Validation runs at import time, so a misconfigured deployment fails at boot
 * rather than on the first customer.
 *
 * SERVER-SIDE ONLY. Importing this into client code would bundle the API Secret
 * — and with it the ability to charge your customers — into something anyone
 * can read.
 */

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

function required(name: string, why: string): string {
  const value = optional(name);
  if (!value) {
    throw new Error(
      `[digimart] Missing required environment variable ${name} (${why}).\n` +
        `Copy templates/.env.example to .env, or set it in your host's secret manager.`
    );
  }
  return value;
}

const endpoints = {
  subscriptionAuthorize: optional("DIGIMART_SUBSCRIPTION_AUTHORIZE_URL"),
  caasAuthorize: optional("DIGIMART_CAAS_AUTHORIZE_URL"),
  getSubscribers: optional("DIGIMART_GET_SUBSCRIBERS_URL"),
  chargingInfo: optional("DIGIMART_CHARGING_INFO_URL"),
  unregistration: optional("DIGIMART_UNREGISTRATION_URL"),
} as const;

const usesSdk = Boolean(endpoints.subscriptionAuthorize || endpoints.caasAuthorize);
const usesRest = Boolean(endpoints.getSubscribers || endpoints.chargingInfo || endpoints.unregistration);

export const config = {
  /** Checked against every notification. Not secret. */
  applicationId: required("DIGIMART_APP_ID", "every notification is verified against it"),

  /** Charging SDK. The secret never leaves this process. */
  apiKey: usesSdk ? required("DIGIMART_API_KEY", "an authorize URL is configured") : "",
  apiSecret: usesSdk ? required("DIGIMART_API_SECRET", "an authorize URL is configured") : "",
  redirectUrl: usesSdk ? required("DIGIMART_REDIRECT_URL", "an authorize URL is configured") : "",

  /** REST. Never log it. Never send it to a client. */
  password: usesRest ? required("DIGIMART_PASSWORD", "a REST endpoint is configured") : "",

  endpoints,
} as const;

if (usesSdk && !/^https:\/\//.test(config.redirectUrl)) {
  throw new Error("[digimart] DIGIMART_REDIRECT_URL must be an absolute https:// URL.");
}

export type ServiceName = keyof typeof endpoints;

/** Resolve an endpoint, or fail with a message that names the missing variable. */
export function requireEndpoint(service: ServiceName): string {
  const url = config.endpoints[service];
  if (!url) {
    const variable = {
      subscriptionAuthorize: "DIGIMART_SUBSCRIPTION_AUTHORIZE_URL",
      caasAuthorize: "DIGIMART_CAAS_AUTHORIZE_URL",
      getSubscribers: "DIGIMART_GET_SUBSCRIBERS_URL",
      chargingInfo: "DIGIMART_CHARGING_INFO_URL",
      unregistration: "DIGIMART_UNREGISTRATION_URL",
    }[service];
    throw new Error(`[digimart] ${service} is not configured. Set ${variable}; see .env.example.`);
  }
  return url;
}

/** Redacted view, safe to log at startup. */
export function describeConfig(): Record<string, unknown> {
  return {
    applicationId: config.applicationId,
    apiKey: config.apiKey ? `${config.apiKey.slice(0, 4)}…` : "(unset)",
    apiSecret: config.apiSecret ? "***redacted***" : "(unset)",
    password: config.password ? "***redacted***" : "(unset)",
    enabled: (Object.keys(endpoints) as ServiceName[]).filter((s) => endpoints[s]),
  };
}

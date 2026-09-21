package com.example.digimart;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * Digimart configuration — the ONLY class that reads the environment.
 *
 * Two surfaces, two credentials:
 *   - the charging SDK (signed URLs on user.digimart.store): API Key + API Secret
 *   - the REST APIs (JSON on api.digimart.store): applicationId + App Password
 * plus one URL per flow or call you actually use. An unset endpoint means the
 * service is off, and the client refuses to use it.
 *
 * Construct it once at startup (a Spring @Bean) so a misconfigured deployment
 * fails at boot. SERVER-SIDE ONLY — the API Secret can charge your customers.
 */
public final class DigimartConfig {

    public static final Map<String, String> ENDPOINT_VARIABLES = Map.of(
        "subscriptionAuthorize", "DIGIMART_SUBSCRIPTION_AUTHORIZE_URL",
        "caasAuthorize", "DIGIMART_CAAS_AUTHORIZE_URL",
        "getSubscribers", "DIGIMART_GET_SUBSCRIBERS_URL",
        "chargingInfo", "DIGIMART_CHARGING_INFO_URL",
        "unregistration", "DIGIMART_UNREGISTRATION_URL"
    );

    public final String applicationId;
    public final String apiKey;
    private final String apiSecret;   // never logged, never returned to a client
    public final String redirectUrl;
    private final String password;    // never logged, never returned to a client
    private final Map<String, String> endpoints = new LinkedHashMap<>();

    public DigimartConfig() {
        ENDPOINT_VARIABLES.forEach((service, variable) -> optional(variable).ifPresent(v -> endpoints.put(service, v)));
        boolean usesSdk = endpoints.containsKey("subscriptionAuthorize") || endpoints.containsKey("caasAuthorize");
        boolean usesRest = endpoints.containsKey("getSubscribers") || endpoints.containsKey("chargingInfo")
            || endpoints.containsKey("unregistration");

        this.applicationId = required("DIGIMART_APP_ID", "every notification is verified against it");
        this.apiKey = usesSdk ? required("DIGIMART_API_KEY", "an authorize URL is configured") : "";
        this.apiSecret = usesSdk ? required("DIGIMART_API_SECRET", "an authorize URL is configured") : "";
        this.redirectUrl = usesSdk ? required("DIGIMART_REDIRECT_URL", "an authorize URL is configured") : "";
        this.password = usesRest ? required("DIGIMART_PASSWORD", "a REST endpoint is configured") : "";

        if (usesSdk && !redirectUrl.startsWith("https://")) {
            throw new IllegalStateException("[digimart] DIGIMART_REDIRECT_URL must be an absolute https:// URL.");
        }
    }

    String apiSecret() { return apiSecret; }
    String password() { return password; }

    public String requireEndpoint(String service) {
        String url = endpoints.get(service);
        if (url == null) {
            throw new IllegalStateException("[digimart] " + service + " is not configured. Set "
                + ENDPOINT_VARIABLES.get(service) + "; see .env.example.");
        }
        return url;
    }

    /** Redacted view, safe to log at startup. */
    public Map<String, Object> describe() {
        return Map.of(
            "applicationId", applicationId,
            "apiSecret", apiSecret.isEmpty() ? "(unset)" : "***redacted***",
            "password", password.isEmpty() ? "(unset)" : "***redacted***",
            "enabled", endpoints.keySet()
        );
    }

    private static Optional<String> optional(String name) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? Optional.empty() : Optional.of(value.trim());
    }

    private static String required(String name, String why) {
        return optional(name).orElseThrow(() -> new IllegalStateException(
            "[digimart] Missing required environment variable " + name + " (" + why + "). "
                + "Copy templates/.env.example to .env, or set it in your host's secret manager."));
    }
}

package com.example.digimart;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.StringJoiner;

/**
 * Digimart client — the URL signer and the REST client. Java 17 HttpClient + Jackson.
 *
 *   1. Charging (subscription and one-time) is a SIGNED URL the customer's
 *      browser opens. Nothing is POSTed. buildSubscriptionUrl() and
 *      buildOneTimeUrl() return it; your start endpoint redirects to it.
 *   2. Subscriber management is REST on a different host with a different
 *      credential. One post() injects applicationId + password, times out, and
 *      decides success on statusCode in the body.
 *
 * TLS: HttpClient verifies certificates by default. Never install a trust-all
 * TrustManager; supply the intermediate CA if a chain is incomplete.
 *
 * SERVER-SIDE ONLY.
 */
public final class DigimartClient {

    private static final Duration TIMEOUT = Duration.ofSeconds(15);
    public static final BigDecimal ONE_TIME_MIN = new BigDecimal("1");
    public static final BigDecimal ONE_TIME_MAX = new BigDecimal("600");

    /** 2024-07-08T10:33:54.929Z — fixed millisecond precision, true UTC. */
    private static final DateTimeFormatter REQUEST_TIME =
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    public static final Set<String> SDK_CONFIGURATION = Set.of("E1006", "E1007", "E1008", "E1010", "E1011");
    public static final Set<String> SDK_TRANSIENT = Set.of("E1001", "E1013", "E2001", "E2003", "E2004");
    public static final Set<String> SDK_USER_STATE = Set.of(
        "E1014", "E2002", "E3001", "E3002", "E3003", "E3004", "E3005", "E3006", "E3007", "E3009", "E4001");

    /** REST success is per call. Subscriber List also permits S1001 (no published meaning). */
    public static final Set<String> REST_SUCCESS_DEFAULT = Set.of("S1000");
    public static final Set<String> REST_SUCCESS_GET_SUBSCRIBERS = Set.of("S1000", "S1001");

    private final DigimartConfig config;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(TIMEOUT).build();
    private final ObjectMapper json = new ObjectMapper();
    private final SecureRandom random = new SecureRandom();

    public DigimartClient(DigimartConfig config) {
        this.config = config;
    }

    /* ── Signing ─────────────────────────────────────────────────────────── */

    public static String requestTimeNow() {
        return REQUEST_TIME.format(Instant.now());
    }

    /** 15 digits, first non-zero, random — never the millisecond clock (collides: E1005). */
    public String newRequestId() {
        long head = 1_000_000L + random.nextInt(9_000_000);   // 7 digits
        long tail = random.nextInt(100_000_000);              // 8 digits
        return head + String.format("%08d", tail);
    }

    /**
     * SHA-512 over the pipe-joined fields, lowercase hex.
     *   subscription: apiKey|requestTime|apiSecret
     *   one-time:     apiKey|requestTime|apiSecret|amount
     *
     * Known answer (keep it in your tests):
     *   sign("myApiKey123", "2024-08-08T12:00:00Z", "mySecretKey456", "50") equals
     *   "3badf638ceca499000fd07b899e5fc0cec348d9762886b8430104291126683892845a208caef8e99b53432571e46c5f04162a1a25646443f7935239ea0901b38"
     */
    public static String sign(String... fields) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-512")
                .digest(String.join("|", fields).getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest); // lowercase
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Format ONCE; the same string goes into the hash and the URL. */
    public static String formatAmount(String amount) {
        String text = amount.trim();
        if (!text.matches("\\d+(\\.\\d+)?")) {
            throw new IllegalArgumentException("[digimart] amount must be a plain number, got " + text);
        }
        BigDecimal value = new BigDecimal(text);
        if (value.compareTo(ONE_TIME_MIN) < 0 || value.compareTo(ONE_TIME_MAX) > 0) {
            throw new IllegalArgumentException("[digimart] amount " + text + " is outside 1-600 BDT (E1330/E1329)");
        }
        return text;
    }

    public record AuthorizeUrl(String url, String requestId, String requestTime) {}

    /** Subscription flow. heAmount only for the header-enrichment variant — NOT signed. */
    public AuthorizeUrl buildSubscriptionUrl(String requestId, String msisdn, String heAmount) {
        String base = config.requireEndpoint("subscriptionAuthorize");
        String requestTime = requestTimeNow();
        String signature = sign(config.apiKey, requestTime, config.apiSecret());
        Map<String, String> q = new LinkedHashMap<>();
        q.put("apiKey", config.apiKey);
        q.put("requestId", requestId);
        q.put("requestTime", requestTime);
        q.put("signature", signature);
        q.put("redirectUrl", config.redirectUrl);
        q.put("msisdn", msisdn);
        q.put("amount", heAmount);
        return new AuthorizeUrl(base + "?" + encode(q), requestId, requestTime);
    }

    /** One-time (CaaS) flow. The amount is signed AND sent. Take it from your price list. */
    public AuthorizeUrl buildOneTimeUrl(String requestId, String amount, String msisdn) {
        String base = config.requireEndpoint("caasAuthorize");
        String amountText = formatAmount(amount);
        String requestTime = requestTimeNow();
        String signature = sign(config.apiKey, requestTime, config.apiSecret(), amountText);
        Map<String, String> q = new LinkedHashMap<>();
        q.put("apiKey", config.apiKey);
        q.put("requestId", requestId);
        q.put("requestTime", requestTime);
        q.put("signature", signature);
        q.put("redirectUrl", config.redirectUrl);
        q.put("msisdn", msisdn);
        q.put("amount", amountText);
        return new AuthorizeUrl(base + "?" + encode(q), requestId, requestTime);
    }

    private static String encode(Map<String, String> params) {
        StringJoiner joiner = new StringJoiner("&");
        params.forEach((k, v) -> {
            if (v != null) joiner.add(k + "=" + URLEncoder.encode(v, StandardCharsets.UTF_8));
        });
        return joiner.toString();
    }

    /* ── Status codes ────────────────────────────────────────────────────── */

    /** success | configuration | transient | user-state | client */
    public static String classifySdkCode(String code) {
        if ("S1000".equals(code)) return "success";
        if (SDK_CONFIGURATION.contains(code)) return "configuration";
        if (SDK_TRANSIENT.contains(code)) return "transient";
        if (SDK_USER_STATE.contains(code)) return "user-state";
        return "client";
    }

    public static final class DigimartException extends RuntimeException {
        public final String statusCode;
        public final String statusDetail;
        public final String requestId;

        DigimartException(String statusCode, String statusDetail, String requestId, String service) {
            super("[" + statusCode + "] " + statusDetail + " (" + service + ", requestId " + requestId + ")");
            this.statusCode = statusCode;
            this.statusDetail = statusDetail;
            this.requestId = requestId;
        }
    }

    /* ── Addressing ──────────────────────────────────────────────────────── */

    public static String fromTel(String value) {
        return value == null ? "" : value.trim().replaceFirst("(?i)^tel:\\s*", "");
    }

    /** The ONLY place tel: is added. No space after the colon. */
    public static String toTel(String subscriberId) {
        String bare = fromTel(subscriberId);
        if (bare.isEmpty()) throw new IllegalArgumentException("[digimart] empty subscriberId");
        return "tel:" + bare;
    }

    public static String maskId(String value) {
        String s = fromTel(value);
        return s.length() <= 8 ? "***" : s.substring(0, 4) + "…" + s.substring(s.length() - 4);
    }

    /* ── REST ────────────────────────────────────────────────────────────── */

    private JsonNode post(String service, ObjectNode body, Set<String> success) {
        body.put("applicationId", config.applicationId);   // credentials injected here only
        body.put("password", config.password());
        HttpRequest request = HttpRequest.newBuilder(URI.create(config.requireEndpoint(service)))
            .timeout(TIMEOUT)
            .header("Content-Type", "application/json;charset=utf-8")
            .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
            .build();
        JsonNode data;
        try {
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            data = json.readTree(response.body());
        } catch (java.io.IOException e) {
            throw new DigimartException("TRANSPORT", e.getMessage(), null, service);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new DigimartException("INTERRUPTED", "interrupted", null, service);
        }
        String code = data.path("statusCode").asText("");
        if (!success.contains(code)) { // the body decides, not the HTTP status
            throw new DigimartException(code.isEmpty() ? "NO_CODE" : code,
                data.path("statusDetail").asText("no statusDetail"), data.path("requestId").asText(null), service);
        }
        return data;
    }

    public record SubscriberPage(List<JsonNode> subscribers, Integer nextPage, String statusCode) {}

    /** requestPage is the ONLY integer in any Digimart body. */
    public SubscriberPage getSubscribers(int requestPage, String status, String subscriberRequestId) {
        ObjectNode body = json.createObjectNode().put("version", "2.0").put("requestPage", requestPage);
        if (status != null) body.put("status", status);
        if (subscriberRequestId != null) body.put("subscriberRequestId", subscriberRequestId);
        JsonNode data = post("getSubscribers", body, REST_SUCCESS_GET_SUBSCRIBERS);

        List<JsonNode> subs = new ArrayList<>();
        JsonNode node = data.path("subscribers");
        if (node.isArray()) node.forEach(subs::add);          // the example shows an array
        else if (node.isObject()) subs.add(node);             // the spec types it as one object
        boolean more = data.path("moreDataAvailable").asBoolean(false) && data.path("nextPageNumber").asInt(-1) != -1;
        return new SubscriberPage(subs, more ? data.path("nextPageNumber").asInt() : null, data.path("statusCode").asText());
    }

    /** subscriberId is an ARRAY. Read every entry's statusCode. */
    public List<JsonNode> getChargingInfo(List<String> subscriberIds) {
        ObjectNode body = json.createObjectNode();
        ArrayNode ids = body.putArray("subscriberId");
        subscriberIds.forEach(id -> ids.add(toTel(id)));
        List<JsonNode> out = new ArrayList<>();
        post("chargingInfo", body, REST_SUCCESS_DEFAULT).path("destinationResponses").forEach(out::add);
        return out;
    }

    /** ONE subscriber, a string; action is the string "0". The id comes from YOUR store. */
    public String unsubscribe(String subscriberId) {
        ObjectNode body = json.createObjectNode().put("subscriberId", toTel(subscriberId)).put("action", "0");
        return post("unregistration", body, REST_SUCCESS_DEFAULT)
            .path("subscriptionStatus").asText("").replaceAll("[\\s.]+$", "");
    }
}

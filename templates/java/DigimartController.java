package com.example.digimart;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;
import java.net.URI;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The endpoints YOU build for Digimart, on Spring Boot.
 *
 *   POST /digimart/checkout                 start a one-time charge  (your users)
 *   POST /digimart/subscribe                start a subscription     (your users)
 *   GET  /digimart/return                   the redirectUrl          (the customer's browser)
 *   POST /api/digimart/charging/notify      Async charging resp URL  (Digimart's server)
 *   POST /api/digimart/subscription/notify  Subscription Notification URL (Digimart's server)
 *   POST /digimart/unsubscribe              your cancel button       (your users)
 *
 * The redirect is UNTRUSTED and grants nothing. Notifications are acknowledged
 * with 200 immediately and processed by an @Async service (enable it with
 * @EnableAsync). Exempt /api/digimart/** from CSRF and session authentication.
 */
@RestController
public class DigimartController {

    private static final Logger log = LoggerFactory.getLogger("digimart");

    /** The amount is signed — it must come from here, never from the request. */
    private static final Map<String, String> PRICE_LIST = Map.of("premium-article", "10", "credits-100", "50");

    private final DigimartClient client;
    private final DigimartStore store;
    private final DigimartNotifications notifications;
    private final ObjectMapper json = new ObjectMapper();

    public DigimartController(DigimartClient client, DigimartStore store, DigimartNotifications notifications) {
        this.client = client;
        this.store = store;
        this.notifications = notifications;
    }

    /* ── Start endpoints ─────────────────────────────────────────────────── */

    @PostMapping("/digimart/checkout")
    public ResponseEntity<?> checkout(@RequestHeader("X-User-Id") String userId,   // replace with your auth
                                      @RequestBody Map<String, String> body,
                                      @RequestHeader(value = "Accept", defaultValue = "") String accept) {
        String amount = PRICE_LIST.get(body.getOrDefault("itemId", ""));
        if (amount == null) return ResponseEntity.notFound().build();

        String requestId = client.newRequestId();
        store.orders.put(requestId, new DigimartStore.Order(userId, body.get("itemId"), amount));  // BEFORE redirect
        var built = client.buildOneTimeUrl(requestId, amount, null);
        log.info("digimart checkout requestId={} amount={}", requestId, amount);
        return respond(accept, built.url(), requestId);
    }

    @PostMapping("/digimart/subscribe")
    public ResponseEntity<?> subscribe(@RequestHeader("X-User-Id") String userId,
                                       @RequestHeader(value = "Accept", defaultValue = "") String accept) {
        String requestId = client.newRequestId();
        var record = new DigimartStore.Subscription(userId, requestId);
        store.subsByRequestId.put(requestId, record);
        store.subsByUser.put(userId, record);
        return respond(accept, client.buildSubscriptionUrl(requestId, null, null).url(), requestId);
    }

    private ResponseEntity<?> respond(String accept, String url, String requestId) {
        if (accept.contains("application/json")) return ResponseEntity.ok(Map.of("url", url, "requestId", requestId));
        return ResponseEntity.status(HttpStatus.FOUND).location(URI.create(url)).build();
    }

    /* ── Redirect page — picks a screen, grants nothing ──────────────────── */

    @GetMapping("/digimart/return")
    public Map<String, Object> redirectReturn(@RequestParam(defaultValue = "") String subscriptionStatus,
                                              @RequestParam(defaultValue = "") String subscriberId,
                                              @RequestParam(defaultValue = "") String requestId) {
        var order = store.orders.get(requestId);
        var sub = store.subsByRequestId.get(requestId);
        if (order == null && sub == null) return Map.of("message", "We couldn't find that payment.");
        if (sub != null && !subscriberId.isEmpty() && sub.subscriberId == null) {
            sub.subscriberId = subscriberId;   // provisional — the notification confirms it
            sub.provisional = true;
        }

        String outcome = DigimartClient.classifySdkCode(subscriptionStatus);
        if (outcome.equals("client") || outcome.equals("configuration")) {
            log.error("digimart redirect failure requestId={} code={}", requestId, subscriptionStatus);
        }
        String message = switch (subscriptionStatus) {
            case "S1000" -> "Payment received — confirming…";
            case "E3009" -> "Your balance is too low. Please recharge and try again.";
            case "E3001" -> "You're already subscribed.";
            case "E4001" -> "That code wasn't right. Please try again.";
            default -> switch (outcome) {
                case "user-state" -> "This number can't complete the payment right now. Please try again later.";
                case "transient" -> "Something went wrong on our side. Please try again.";
                default -> "Sorry, we couldn't start the payment. Please try again later.";
            };
        };
        // Never the raw code. On S1000 the page polls YOUR order status.
        return Map.of("requestId", requestId, "message", message, "pending", subscriptionStatus.equals("S1000"));
    }

    /* ── Notifications — 200 first ───────────────────────────────────────── */

    @PostMapping("/api/digimart/charging/notify")
    public Map<String, Object> chargingNotify(@RequestBody(required = false) String raw) {
        notifications.charging(parse(raw));        // @Async — returns immediately
        return Map.of("received", true);           // no response body is published; always 200
    }

    @PostMapping("/api/digimart/subscription/notify")
    public Map<String, Object> subscriptionNotify(@RequestBody(required = false) String raw) {
        notifications.subscription(parse(raw));
        return Map.of("received", true);
    }

    private JsonNode parse(String raw) {
        try {
            return raw == null ? json.createObjectNode() : json.readTree(raw);
        } catch (Exception e) {
            return json.createObjectNode();         // malformed still gets a 200
        }
    }

    /* ── Cancel — the id comes from YOUR store, never the client ─────────── */

    @PostMapping("/digimart/unsubscribe")
    public ResponseEntity<?> unsubscribe(@RequestHeader("X-User-Id") String userId) {
        var sub = store.subsByUser.get(userId);
        if (sub == null || sub.subscriberId == null) return ResponseEntity.notFound().build();
        try {
            String status = client.unsubscribe(sub.subscriberId);
            if ("UNREGISTERED".equals(status)) sub.status = "UNREGISTERED";   // end access now
            return ResponseEntity.ok(Map.of("status", status));
        } catch (DigimartClient.DigimartException e) {
            log.error("digimart unsubscribe failed — keep the request and retry: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of("error", "could not cancel right now"));
        }
    }
}

/**
 * In-process state so the example runs. In production: JPA entities or tables
 * (orders by requestId, subscribers by user) and a unique constraint for dedupe.
 */
@Service
class DigimartStore {
    static final class Order {
        final String userId, itemId, amount;
        volatile String state = "PENDING";
        volatile String internalTrxId;
        Order(String userId, String itemId, String amount) { this.userId = userId; this.itemId = itemId; this.amount = amount; }
    }

    static final class Subscription {
        final String userId, requestId;
        volatile String subscriberId, status, frequency;
        volatile boolean provisional;
        Subscription(String userId, String requestId) { this.userId = userId; this.requestId = requestId; }
    }

    final Map<String, Order> orders = new ConcurrentHashMap<>();
    final Map<String, Subscription> subsByRequestId = new ConcurrentHashMap<>();
    final Map<String, Subscription> subsByUser = new ConcurrentHashMap<>();
    final Set<String> seen = ConcurrentHashMap.newKeySet();
}

@Service
class DigimartNotifications {
    private static final Logger log = LoggerFactory.getLogger("digimart");
    private final DigimartConfig config;
    private final DigimartStore store;

    DigimartNotifications(DigimartConfig config, DigimartStore store) {
        this.config = config;
        this.store = store;
    }

    private boolean foreign(JsonNode body) {
        return body.hasNonNull("applicationId") && !config.applicationId.equals(body.get("applicationId").asText());
    }

    private static BigDecimal decimal(JsonNode node) {
        try { return node == null || node.isNull() ? null : new BigDecimal(node.asText()); }
        catch (NumberFormatException e) { return null; }
    }

    @Async
    public void charging(JsonNode body) {
        if (foreign(body)) { log.warn("digimart charging notification for another application — ignored"); return; }
        String requestId = body.path("requestId").asText("");
        String statusCode = body.path("statusCode").asText("");
        String key = "charge:" + body.path("internalTrxId").asText(requestId) + ":" + statusCode;
        if (!store.seen.add(key)) return;   // replay
        log.info("digimart charging requestId={} statusCode={} subscriber={}", requestId, statusCode,
            DigimartClient.maskId(body.path("subscriberId").asText("")));

        var order = store.orders.get(requestId);
        if (order == null) {
            var sub = store.subsByRequestId.get(requestId);   // a header-enrichment subscription charge
            if (sub != null && "S1000".equals(statusCode)) {
                if (body.hasNonNull("subscriberId")) sub.subscriberId = body.get("subscriberId").asText();
                sub.provisional = false;
                sub.status = "REGISTERED";
            }
            return;
        }
        if (!"PENDING".equals(order.state)) return;
        if (!"S1000".equals(statusCode)) { order.state = "FAILED"; return; }

        BigDecimal paid = decimal(body.get("paidAmount"));
        BigDecimal due = body.has("balanceDue") ? decimal(body.get("balanceDue")) : BigDecimal.ZERO;
        if (paid == null || paid.compareTo(new BigDecimal(order.amount)) != 0 || due == null || due.signum() != 0) {
            log.error("digimart amount mismatch requestId={} paid={} expected={} due={}", requestId, paid, order.amount, due);
            return;
        }
        order.internalTrxId = body.path("internalTrxId").asText(null);
        order.state = "PAID";
        order.state = "FULFILLED";   // deliver exactly once here
    }

    @Async
    public void subscription(JsonNode body) {
        if (foreign(body)) { log.warn("digimart subscription notification for another application — ignored"); return; }
        String subscriberId = body.path("subscriberId").asText("");
        String status = body.path("status").asText("");
        if (subscriberId.isEmpty() || status.isEmpty()) { log.warn("digimart subscription notification missing fields"); return; }
        if (!store.seen.add("sub:" + subscriberId + ":" + status + ":" + body.path("timeStamp").asText(""))) return;

        var sub = store.subsByRequestId.get(body.path("subscriberRequestId").asText(""));
        if (sub == null) { log.warn("digimart subscription notification for unknown requestId"); return; }
        sub.subscriberId = subscriberId;      // the authoritative mapping
        sub.provisional = false;
        sub.status = status;                  // REGISTERED grant · REG_PENDING hold · TEMPORARY_BLOCKED suspend
        if (body.hasNonNull("frequency")) sub.frequency = body.get("frequency").asText();
    }
}

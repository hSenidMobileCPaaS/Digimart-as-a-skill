// The endpoints YOU build for Digimart — ASP.NET Core minimal APIs + a BackgroundService.
//
//   POST /digimart/checkout                 start a one-time charge   (your users)
//   POST /digimart/subscribe                start a subscription      (your users)
//   GET  /digimart/return                   the redirectUrl           (the customer's browser)
//   POST /api/digimart/charging/notify      Async charging resp URL   (Digimart's server)
//   POST /api/digimart/subscription/notify  Subscription Notification URL (Digimart's server)
//   POST /digimart/unsubscribe              your cancel button        (your users)
//
// Program.cs:
//   builder.Services.AddSingleton(DigimartOptions.FromEnvironment());
//   builder.Services.AddHttpClient<DigimartClient>(c => c.Timeout = TimeSpan.FromSeconds(15));
//   builder.Services.AddSingleton<DigimartStore>();
//   builder.Services.AddSingleton(Channel.CreateBounded<(string Kind, JsonObject Body)>(1024));
//   builder.Services.AddHostedService<DigimartNotificationWorker>();
//   app.MapDigimart();
//
// The redirect is UNTRUSTED and grants nothing. Notifications are answered 200
// immediately and processed by the worker. Keep antiforgery off these routes.

using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Example.Digimart;

/// <summary>
/// In-process state so the example runs. In production: database tables (orders by
/// requestId, subscribers by user) and a unique constraint for the dedupe keys.
/// </summary>
public sealed class DigimartStore
{
    public sealed class Order(string userId, string itemId, string amount)
    {
        public string UserId { get; } = userId;
        public string ItemId { get; } = itemId;
        public string Amount { get; } = amount;
        public string State { get; set; } = "PENDING";
        public string? InternalTrxId { get; set; }
    }

    public sealed class Subscription(string userId, string requestId)
    {
        public string UserId { get; } = userId;
        public string RequestId { get; } = requestId;
        public string? SubscriberId { get; set; }
        public string? Status { get; set; }
        public string? Frequency { get; set; }
        public bool Provisional { get; set; }
    }

    public ConcurrentDictionary<string, Order> Orders { get; } = new();
    public ConcurrentDictionary<string, Subscription> SubsByRequestId { get; } = new();
    public ConcurrentDictionary<string, Subscription> SubsByUser { get; } = new();
    public ConcurrentDictionary<string, bool> Seen { get; } = new();
}

public static class DigimartEndpoints
{
    /// <summary>The amount is signed — it comes from here, never from the request.</summary>
    private static readonly Dictionary<string, string> PriceList = new() { ["premium-article"] = "10", ["credits-100"] = "50" };

    public static IEndpointRouteBuilder MapDigimart(this IEndpointRouteBuilder app)
    {
        // Replace the X-User-Id header with your authentication.
        static string? CurrentUser(HttpContext ctx) => ctx.Request.Headers["X-User-Id"].FirstOrDefault();

        static IResult Respond(HttpContext ctx, string url, string requestId) =>
            ctx.Request.Headers.Accept.ToString().Contains("application/json")
                ? Results.Ok(new { url, requestId })          // SPA / web view opens it
                : Results.Redirect(url);

        /* ── Start endpoints ─────────────────────────────────────────────── */

        app.MapPost("/digimart/checkout", async (HttpContext ctx, DigimartClient client, DigimartStore store) =>
        {
            if (CurrentUser(ctx) is not { } userId) return Results.Unauthorized();
            var input = await ctx.Request.ReadFromJsonAsync<JsonObject>() ?? new JsonObject();
            var itemId = input["itemId"]?.GetValue<string>() ?? "";
            if (!PriceList.TryGetValue(itemId, out var amount)) return Results.NotFound();

            var requestId = DigimartClient.NewRequestId();
            store.Orders[requestId] = new DigimartStore.Order(userId, itemId, amount);   // BEFORE redirecting
            return Respond(ctx, client.BuildOneTimeUrl(amount, requestId).Url, requestId);
        });

        app.MapPost("/digimart/subscribe", (HttpContext ctx, DigimartClient client, DigimartStore store) =>
        {
            if (CurrentUser(ctx) is not { } userId) return Results.Unauthorized();
            var requestId = DigimartClient.NewRequestId();
            var record = new DigimartStore.Subscription(userId, requestId);
            store.SubsByRequestId[requestId] = record;
            store.SubsByUser[userId] = record;
            return Respond(ctx, client.BuildSubscriptionUrl(requestId).Url, requestId);
        });

        /* ── Redirect page — picks a screen, grants nothing ──────────────── */

        app.MapGet("/digimart/return", (string? subscriptionStatus, string? subscriberId, string? requestId,
                                        DigimartStore store, ILoggerFactory logs) =>
        {
            var status = subscriptionStatus ?? "";
            var id = requestId ?? "";
            store.Orders.TryGetValue(id, out var order);
            store.SubsByRequestId.TryGetValue(id, out var sub);
            if (order is null && sub is null) return Results.Ok(new { message = "We couldn't find that payment." });

            if (sub is not null && !string.IsNullOrEmpty(subscriberId) && sub.SubscriberId is null)
            {
                sub.SubscriberId = subscriberId;   // provisional — the notification confirms it
                sub.Provisional = true;
            }
            var outcome = DigimartClient.ClassifySdkCode(status);
            if (outcome is "client" or "configuration")
                logs.CreateLogger("digimart").LogError("digimart redirect failure requestId={RequestId} code={Code}", id, status);

            var message = status switch
            {
                "S1000" => "Payment received — confirming…",
                "E3009" => "Your balance is too low. Please recharge and try again.",
                "E3001" => "You're already subscribed.",
                "E4001" => "That code wasn't right. Please try again.",
                _ => outcome switch
                {
                    "user-state" => "This number can't complete the payment right now. Please try again later.",
                    "transient" => "Something went wrong on our side. Please try again.",
                    _ => "Sorry, we couldn't start the payment. Please try again later.",
                },
            };
            // Never the raw code. On S1000 the page polls YOUR order status.
            return Results.Ok(new { requestId = id, message, pending = status == "S1000" });
        });

        /* ── Notifications — 200 first ───────────────────────────────────── */

        static async Task<JsonObject> ReadBody(HttpContext ctx)
        {
            try { return await JsonSerializer.DeserializeAsync<JsonObject>(ctx.Request.Body) ?? new JsonObject(); }
            catch (JsonException) { return new JsonObject(); }   // malformed still gets a 200
        }

        app.MapPost("/api/digimart/charging/notify", async (HttpContext ctx, Channel<(string, JsonObject)> queue) =>
        {
            queue.Writer.TryWrite(("charging", await ReadBody(ctx)));
            return Results.Ok(new { received = true });   // no response body is published; always 200
        });

        app.MapPost("/api/digimart/subscription/notify", async (HttpContext ctx, Channel<(string, JsonObject)> queue) =>
        {
            queue.Writer.TryWrite(("subscription", await ReadBody(ctx)));
            return Results.Ok(new { received = true });
        });

        /* ── Cancel — the id comes from YOUR store, never the client ─────── */

        app.MapPost("/digimart/unsubscribe", async (HttpContext ctx, DigimartClient client, DigimartStore store, ILoggerFactory logs) =>
        {
            if (CurrentUser(ctx) is not { } userId || !store.SubsByUser.TryGetValue(userId, out var sub) || sub.SubscriberId is null)
                return Results.NotFound();
            try
            {
                var status = await client.UnsubscribeAsync(sub.SubscriberId, ctx.RequestAborted);
                if (status == "UNREGISTERED") sub.Status = "UNREGISTERED";   // end access now — no notification is documented
                return Results.Ok(new { status });
            }
            catch (DigimartException e)
            {
                logs.CreateLogger("digimart").LogError("digimart unsubscribe failed — keep the request and retry: {Error}", e.Message);
                return Results.StatusCode(502);
            }
        });

        return app;
    }
}

/// <summary>Processes notifications after the 200 has been sent: verify, dedupe, settle.</summary>
public sealed class DigimartNotificationWorker(
    Channel<(string Kind, JsonObject Body)> queue, DigimartStore store, DigimartOptions options,
    ILogger<DigimartNotificationWorker> log) : BackgroundService
{
    private static string S(JsonObject body, string key) => body[key] switch
    {
        JsonValue v when v.TryGetValue<string>(out var s) => s,
        JsonValue v => v.ToJsonString(),
        _ => "",
    };

    private static decimal? Dec(JsonObject body, string key) =>
        decimal.TryParse(S(body, key), System.Globalization.NumberStyles.Number,
            System.Globalization.CultureInfo.InvariantCulture, out var d) ? d : null;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var (kind, body) in queue.Reader.ReadAllAsync(stoppingToken))
        {
            try
            {
                if (body.ContainsKey("applicationId") && S(body, "applicationId") != options.ApplicationId)
                {
                    log.LogWarning("digimart {Kind} notification for another application — ignored", kind);
                    continue;
                }
                if (kind == "charging") Charging(body); else Subscription(body);
            }
            catch (Exception e)
            {
                log.LogError(e, "digimart notification processing failed");
            }
        }
    }

    private void Charging(JsonObject body)
    {
        var requestId = S(body, "requestId");
        var statusCode = S(body, "statusCode");
        var trx = S(body, "internalTrxId");
        if (!store.Seen.TryAdd($"charge:{(trx.Length > 0 ? trx : requestId)}:{statusCode}", true)) return;   // replay
        log.LogInformation("digimart charging requestId={RequestId} statusCode={Code} subscriber={Sub}",
            requestId, statusCode, DigimartClient.MaskId(S(body, "subscriberId")));

        if (!store.Orders.TryGetValue(requestId, out var order))
        {
            if (store.SubsByRequestId.TryGetValue(requestId, out var sub) && statusCode == "S1000")   // header-enrichment subscription
            {
                var id = S(body, "subscriberId");
                if (id.Length > 0) sub.SubscriberId = id;
                sub.Provisional = false;
                sub.Status = "REGISTERED";
            }
            return;
        }
        if (order.State != "PENDING") return;
        if (statusCode != "S1000") { order.State = "FAILED"; return; }

        var paid = Dec(body, "paidAmount");
        var due = body.ContainsKey("balanceDue") ? Dec(body, "balanceDue") : 0m;
        if (paid != decimal.Parse(order.Amount, System.Globalization.CultureInfo.InvariantCulture) || due != 0m)
        {
            log.LogError("digimart amount mismatch requestId={RequestId} paid={Paid} expected={Expected} due={Due}",
                requestId, paid, order.Amount, due);
            return;
        }
        order.InternalTrxId = trx;
        order.State = "PAID";
        order.State = "FULFILLED";   // deliver exactly once here
    }

    private void Subscription(JsonObject body)
    {
        var subscriberId = S(body, "subscriberId");
        var status = S(body, "status");
        if (subscriberId.Length == 0 || status.Length == 0) { log.LogWarning("digimart subscription notification missing fields"); return; }
        if (!store.Seen.TryAdd($"sub:{subscriberId}:{status}:{S(body, "timeStamp")}", true)) return;

        if (!store.SubsByRequestId.TryGetValue(S(body, "subscriberRequestId"), out var sub))
        {
            log.LogWarning("digimart subscription notification for unknown requestId");
            return;
        }
        sub.SubscriberId = subscriberId;   // the authoritative mapping
        sub.Provisional = false;
        sub.Status = status;               // REGISTERED grant · REG_PENDING hold · TEMPORARY_BLOCKED suspend
        var frequency = S(body, "frequency");
        if (frequency.Length > 0) sub.Frequency = frequency;
    }
}

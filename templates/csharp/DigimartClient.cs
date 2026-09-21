// Digimart client — the URL signer and the REST client. HttpClient + System.Text.Json.
//
//   1. Charging (subscription and one-time) is a SIGNED URL the customer's
//      browser opens. Nothing is POSTed. BuildSubscriptionUrl and BuildOneTimeUrl
//      return it; your start endpoint redirects to it.
//   2. Subscriber management is REST on a different host with a different
//      credential. PostAsync injects applicationId + password, times out, and
//      decides success on statusCode in the body.
//
// Register with IHttpClientFactory:
//   builder.Services.AddSingleton(DigimartOptions.FromEnvironment());
//   builder.Services.AddHttpClient<DigimartClient>(c => c.Timeout = TimeSpan.FromSeconds(15));
//
// TLS: never set ServerCertificateCustomValidationCallback to return true;
// install the intermediate CA if a chain is incomplete.
//
// SERVER-SIDE ONLY.

using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Example.Digimart;

public sealed class DigimartException(string statusCode, string statusDetail, string? requestId, string service)
    : Exception($"[{statusCode}] {statusDetail} ({service}, requestId {requestId})")
{
    public string StatusCode { get; } = statusCode;
    public string StatusDetail { get; } = statusDetail;
    public string? RequestId { get; } = requestId;
}

public sealed record AuthorizeUrl(string Url, string RequestId, string RequestTime);

public sealed partial class DigimartClient(HttpClient http, DigimartOptions options)
{
    public const decimal OneTimeMin = 1m;
    public const decimal OneTimeMax = 600m;

    public static readonly IReadOnlySet<string> SdkConfiguration = new HashSet<string> { "E1006", "E1007", "E1008", "E1010", "E1011" };
    public static readonly IReadOnlySet<string> SdkTransient = new HashSet<string> { "E1001", "E1013", "E2001", "E2003", "E2004" };
    public static readonly IReadOnlySet<string> SdkUserState = new HashSet<string>
        { "E1014", "E2002", "E3001", "E3002", "E3003", "E3004", "E3005", "E3006", "E3007", "E3009", "E4001" };

    /// <summary>REST success is per call. Subscriber List also permits S1001 (no published meaning).</summary>
    public static readonly IReadOnlySet<string> RestSuccessDefault = new HashSet<string> { "S1000" };
    public static readonly IReadOnlySet<string> RestSuccessGetSubscribers = new HashSet<string> { "S1000", "S1001" };

    [GeneratedRegex(@"^\d+(\.\d+)?$")] private static partial Regex AmountPattern();
    [GeneratedRegex(@"^tel:\s*", RegexOptions.IgnoreCase)] private static partial Regex TelPrefix();

    /* ── Signing ─────────────────────────────────────────────────────────── */

    /// <summary>2024-07-08T10:33:54.929Z — true UTC, never Dhaka wall-clock with a Z.</summary>
    public static string RequestTimeNow() =>
        DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    /// <summary>15 digits, first non-zero, random — never the clock (collides: E1005).</summary>
    public static string NewRequestId() =>
        RandomNumberGenerator.GetInt32(1_000_000, 10_000_000).ToString(CultureInfo.InvariantCulture)
        + RandomNumberGenerator.GetInt32(0, 100_000_000).ToString("D8", CultureInfo.InvariantCulture);

    /// <summary>
    /// SHA-512 over the pipe-joined fields, lowercase hex.
    ///   subscription: apiKey|requestTime|apiSecret
    ///   one-time:     apiKey|requestTime|apiSecret|amount
    /// Known answer (keep it in your tests):
    ///   Sign("myApiKey123", "2024-08-08T12:00:00Z", "mySecretKey456", "50") ==
    ///   "3badf638ceca499000fd07b899e5fc0cec348d9762886b8430104291126683892845a208caef8e99b53432571e46c5f04162a1a25646443f7935239ea0901b38"
    /// </summary>
    public static string Sign(params string[] fields) =>
        Convert.ToHexString(SHA512.HashData(Encoding.UTF8.GetBytes(string.Join("|", fields)))).ToLowerInvariant();

    /// <summary>Format ONCE; the same string goes into the hash and the URL.</summary>
    public static string FormatAmount(string amount)
    {
        var text = amount.Trim();
        if (!AmountPattern().IsMatch(text))
            throw new ArgumentException($"[digimart] amount must be a plain number, got {text}");
        var value = decimal.Parse(text, CultureInfo.InvariantCulture);
        if (value < OneTimeMin || value > OneTimeMax)
            throw new ArgumentException($"[digimart] amount {text} is outside 1-600 BDT (E1330/E1329)");
        return text;
    }

    private string Authorize(string baseUrl, string requestId, string requestTime, string signature,
                             params (string Key, string? Value)[] extra)
    {
        var pairs = new List<(string, string?)>
        {
            ("apiKey", options.ApiKey), ("requestId", requestId), ("requestTime", requestTime),
            ("signature", signature), ("redirectUrl", options.RedirectUrl),
        };
        pairs.AddRange(extra);
        var query = string.Join("&", pairs.Where(p => !string.IsNullOrEmpty(p.Item2))
            .Select(p => $"{p.Item1}={Uri.EscapeDataString(p.Item2!)}"));
        return $"{baseUrl}?{query}";
    }

    /// <summary>Subscription flow. heAmount only for the header-enrichment variant — NOT signed.</summary>
    public AuthorizeUrl BuildSubscriptionUrl(string? requestId = null, string? msisdn = null, string? heAmount = null)
    {
        var baseUrl = options.RequireEndpoint("subscriptionAuthorize");
        requestId ??= NewRequestId();
        var requestTime = RequestTimeNow();
        var signature = Sign(options.ApiKey, requestTime, options.ApiSecret);
        return new(Authorize(baseUrl, requestId, requestTime, signature, ("msisdn", msisdn), ("amount", heAmount)),
            requestId, requestTime);
    }

    /// <summary>One-time (CaaS) flow. The amount is signed AND sent. Take it from your price list.</summary>
    public AuthorizeUrl BuildOneTimeUrl(string amount, string? requestId = null, string? msisdn = null)
    {
        var baseUrl = options.RequireEndpoint("caasAuthorize");
        var amountText = FormatAmount(amount);
        requestId ??= NewRequestId();
        var requestTime = RequestTimeNow();
        var signature = Sign(options.ApiKey, requestTime, options.ApiSecret, amountText);
        return new(Authorize(baseUrl, requestId, requestTime, signature, ("msisdn", msisdn), ("amount", amountText)),
            requestId, requestTime);
    }

    /* ── Status codes ────────────────────────────────────────────────────── */

    /// <summary>success | configuration | transient | user-state | client</summary>
    public static string ClassifySdkCode(string code) => code switch
    {
        "S1000" => "success",
        _ when SdkConfiguration.Contains(code) => "configuration",
        _ when SdkTransient.Contains(code) => "transient",
        _ when SdkUserState.Contains(code) => "user-state",
        _ => "client",
    };

    /* ── Addressing ──────────────────────────────────────────────────────── */

    public static string FromTel(string? value) => TelPrefix().Replace((value ?? "").Trim(), "");

    /// <summary>The ONLY place tel: is added. No space after the colon.</summary>
    public static string ToTel(string subscriberId)
    {
        var bare = FromTel(subscriberId);
        return bare.Length == 0 ? throw new ArgumentException("[digimart] empty subscriberId") : $"tel:{bare}";
    }

    public static string MaskId(string? value)
    {
        var s = FromTel(value);
        return s.Length <= 8 ? "***" : $"{s[..4]}…{s[^4..]}";
    }

    /* ── REST ────────────────────────────────────────────────────────────── */

    private async Task<JsonObject> PostAsync(string service, JsonObject body, IReadOnlySet<string> success, CancellationToken ct)
    {
        body["applicationId"] = options.ApplicationId;   // credentials injected here only
        body["password"] = options.Password;
        using var content = new StringContent(body.ToJsonString(), Encoding.UTF8);
        content.Headers.ContentType = new("application/json") { CharSet = "utf-8" };
        using var response = await http.PostAsync(options.RequireEndpoint(service), content, ct);

        JsonObject data;
        try
        {
            data = JsonNode.Parse(await response.Content.ReadAsStringAsync(ct)) as JsonObject ?? new JsonObject();
        }
        catch (JsonException)
        {
            throw new DigimartException($"HTTP{(int)response.StatusCode}", "Response was not JSON", null, service);
        }
        var code = data["statusCode"]?.GetValue<string>() ?? "";
        if (!success.Contains(code))   // the body decides, not the HTTP status
            throw new DigimartException(code.Length == 0 ? "NO_CODE" : code,
                data["statusDetail"]?.GetValue<string>() ?? "no statusDetail", data["requestId"]?.GetValue<string>(), service);
        return data;
    }

    /// <summary>One page. requestPage is the ONLY integer in any Digimart body. NextPage is null when done.</summary>
    public async Task<(List<JsonObject> Subscribers, int? NextPage)> GetSubscribersAsync(
        int requestPage, string? status = null, string? subscriberRequestId = null, CancellationToken ct = default)
    {
        var body = new JsonObject { ["version"] = "2.0", ["requestPage"] = requestPage };
        if (status is not null) body["status"] = status;
        if (subscriberRequestId is not null) body["subscriberRequestId"] = subscriberRequestId;
        var data = await PostAsync("getSubscribers", body, RestSuccessGetSubscribers, ct);

        var list = data["subscribers"] switch
        {
            JsonArray array => array.OfType<JsonObject>().ToList(),   // the example shows an array
            JsonObject one => [one],                                   // the spec types it as one object
            _ => new List<JsonObject>(),
        };
        var more = data["moreDataAvailable"]?.GetValue<bool>() == true && data["nextPageNumber"]?.GetValue<int>() is int n && n != -1;
        return (list, more ? data["nextPageNumber"]!.GetValue<int>() : null);
    }

    /// <summary>subscriberId is an ARRAY. Check every entry's statusCode.</summary>
    public async Task<List<JsonObject>> GetChargingInfoAsync(IEnumerable<string> subscriberIds, CancellationToken ct = default)
    {
        var ids = new JsonArray(subscriberIds.Select(id => (JsonNode)JsonValue.Create(ToTel(id))!).ToArray());
        var data = await PostAsync("chargingInfo", new JsonObject { ["subscriberId"] = ids }, RestSuccessDefault, ct);
        return (data["destinationResponses"] as JsonArray)?.OfType<JsonObject>().ToList() ?? [];
    }

    /// <summary>ONE subscriber, a string; action is the string "0". The id comes from YOUR store.</summary>
    public async Task<string> UnsubscribeAsync(string subscriberId, CancellationToken ct = default)
    {
        var body = new JsonObject { ["subscriberId"] = ToTel(subscriberId), ["action"] = "0" };
        var data = await PostAsync("unregistration", body, RestSuccessDefault, ct);
        return (data["subscriptionStatus"]?.GetValue<string>() ?? "").TrimEnd(' ', '.');
    }
}

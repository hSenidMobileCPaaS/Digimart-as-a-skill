// Digimart configuration — the ONLY type that reads the environment.
//
// Two surfaces, two credentials:
//   - the charging SDK (signed URLs on user.digimart.store): API Key + API Secret
//   - the REST APIs (JSON on api.digimart.store): applicationId + App Password
// plus one URL per flow or call you actually use. An unset endpoint means the
// service is off, and the client refuses to use it.
//
// Register it as a singleton at startup so a misconfigured deployment fails at
// boot. In production the values come from your secret store (Key Vault,
// Secrets Manager) surfaced as environment variables — never appsettings.json.
//
// SERVER-SIDE ONLY — the API Secret can charge your customers.

namespace Example.Digimart;

public sealed class DigimartOptions
{
    public static readonly IReadOnlyDictionary<string, string> EndpointVariables = new Dictionary<string, string>
    {
        ["subscriptionAuthorize"] = "DIGIMART_SUBSCRIPTION_AUTHORIZE_URL",
        ["caasAuthorize"] = "DIGIMART_CAAS_AUTHORIZE_URL",
        ["getSubscribers"] = "DIGIMART_GET_SUBSCRIBERS_URL",
        ["chargingInfo"] = "DIGIMART_CHARGING_INFO_URL",
        ["unregistration"] = "DIGIMART_UNREGISTRATION_URL",
    };

    public string ApplicationId { get; }
    public string ApiKey { get; }
    public string RedirectUrl { get; }
    internal string ApiSecret { get; }   // never logged, never returned to a client
    internal string Password { get; }    // never logged, never returned to a client
    private readonly Dictionary<string, string> _endpoints = new();

    public static DigimartOptions FromEnvironment() => new();

    private DigimartOptions()
    {
        foreach (var (service, variable) in EndpointVariables)
        {
            var value = Optional(variable);
            if (value is not null) _endpoints[service] = value;
        }
        var usesSdk = _endpoints.ContainsKey("subscriptionAuthorize") || _endpoints.ContainsKey("caasAuthorize");
        var usesRest = _endpoints.ContainsKey("getSubscribers") || _endpoints.ContainsKey("chargingInfo")
            || _endpoints.ContainsKey("unregistration");

        ApplicationId = Required("DIGIMART_APP_ID", "every notification is verified against it");
        ApiKey = usesSdk ? Required("DIGIMART_API_KEY", "an authorize URL is configured") : "";
        ApiSecret = usesSdk ? Required("DIGIMART_API_SECRET", "an authorize URL is configured") : "";
        RedirectUrl = usesSdk ? Required("DIGIMART_REDIRECT_URL", "an authorize URL is configured") : "";
        Password = usesRest ? Required("DIGIMART_PASSWORD", "a REST endpoint is configured") : "";

        if (usesSdk && !RedirectUrl.StartsWith("https://", StringComparison.Ordinal))
            throw new InvalidOperationException("[digimart] DIGIMART_REDIRECT_URL must be an absolute https:// URL.");
    }

    public string RequireEndpoint(string service) =>
        _endpoints.TryGetValue(service, out var url)
            ? url
            : throw new InvalidOperationException(
                $"[digimart] {service} is not configured. Set {EndpointVariables[service]}; see .env.example.");

    /// <summary>Redacted view, safe to log at startup.</summary>
    public object Describe() => new
    {
        ApplicationId,
        ApiSecret = ApiSecret.Length == 0 ? "(unset)" : "***redacted***",
        Password = Password.Length == 0 ? "(unset)" : "***redacted***",
        Enabled = _endpoints.Keys.ToArray(),
    };

    private static string? Optional(string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    private static string Required(string name, string why) =>
        Optional(name) ?? throw new InvalidOperationException(
            $"[digimart] Missing required environment variable {name} ({why}). " +
            "Copy templates/.env.example to .env, or set it in your secret store.");
}

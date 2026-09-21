<?php
/**
 * Digimart configuration — the ONLY class that reads the environment.
 *
 * Two surfaces, two credentials:
 *   - the charging SDK (signed URLs on user.digimart.store): API Key + API Secret
 *   - the REST APIs (JSON on api.digimart.store): applicationId + App Password
 * plus one URL per flow or call you actually use. An unset endpoint means the
 * service is off, and the client refuses to use it.
 *
 * Build it once at bootstrap so a misconfigured deployment fails immediately.
 * Laravel: bind it as a singleton in a service provider and read env() only
 * from config/*.php, never from here at request time with config caching on.
 *
 * SERVER-SIDE ONLY — the API Secret can charge your customers.
 */

declare(strict_types=1);

namespace App\Digimart;

final class DigimartConfig
{
    public const ENDPOINT_VARIABLES = [
        'subscriptionAuthorize' => 'DIGIMART_SUBSCRIPTION_AUTHORIZE_URL',
        'caasAuthorize'         => 'DIGIMART_CAAS_AUTHORIZE_URL',
        'getSubscribers'        => 'DIGIMART_GET_SUBSCRIBERS_URL',
        'chargingInfo'          => 'DIGIMART_CHARGING_INFO_URL',
        'unregistration'        => 'DIGIMART_UNREGISTRATION_URL',
    ];

    public readonly string $applicationId;
    public readonly string $apiKey;
    public readonly string $redirectUrl;
    private readonly string $apiSecret;   // never logged, never returned to a client
    private readonly string $password;    // never logged, never returned to a client
    /** @var array<string,string> */
    private readonly array $endpoints;

    public function __construct()
    {
        $endpoints = [];
        foreach (self::ENDPOINT_VARIABLES as $service => $variable) {
            $value = self::optional($variable);
            if ($value !== null) {
                $endpoints[$service] = $value;
            }
        }
        $this->endpoints = $endpoints;

        $usesSdk  = isset($endpoints['subscriptionAuthorize']) || isset($endpoints['caasAuthorize']);
        $usesRest = isset($endpoints['getSubscribers']) || isset($endpoints['chargingInfo']) || isset($endpoints['unregistration']);

        $this->applicationId = self::required('DIGIMART_APP_ID', 'every notification is verified against it');
        $this->apiKey        = $usesSdk ? self::required('DIGIMART_API_KEY', 'an authorize URL is configured') : '';
        $this->apiSecret     = $usesSdk ? self::required('DIGIMART_API_SECRET', 'an authorize URL is configured') : '';
        $this->redirectUrl   = $usesSdk ? self::required('DIGIMART_REDIRECT_URL', 'an authorize URL is configured') : '';
        $this->password      = $usesRest ? self::required('DIGIMART_PASSWORD', 'a REST endpoint is configured') : '';

        if ($usesSdk && !str_starts_with($this->redirectUrl, 'https://')) {
            throw new \RuntimeException('[digimart] DIGIMART_REDIRECT_URL must be an absolute https:// URL.');
        }
    }

    public function apiSecret(): string { return $this->apiSecret; }
    public function password(): string { return $this->password; }

    public function requireEndpoint(string $service): string
    {
        if (!isset($this->endpoints[$service])) {
            throw new \RuntimeException(sprintf(
                '[digimart] %s is not configured. Set %s; see .env.example.',
                $service,
                self::ENDPOINT_VARIABLES[$service] ?? $service
            ));
        }
        return $this->endpoints[$service];
    }

    /** Redacted view, safe to log at startup. */
    public function describe(): array
    {
        return [
            'applicationId' => $this->applicationId,
            'apiSecret'     => $this->apiSecret === '' ? '(unset)' : '***redacted***',
            'password'      => $this->password === '' ? '(unset)' : '***redacted***',
            'enabled'       => array_keys($this->endpoints),
        ];
    }

    private static function optional(string $name): ?string
    {
        $value = getenv($name);
        if ($value === false || trim($value) === '') {
            $value = $_ENV[$name] ?? $_SERVER[$name] ?? null;
        }
        return is_string($value) && trim($value) !== '' ? trim($value) : null;
    }

    private static function required(string $name, string $why): string
    {
        $value = self::optional($name);
        if ($value === null) {
            throw new \RuntimeException(
                "[digimart] Missing required environment variable {$name} ({$why}). "
                . 'Copy templates/.env.example to .env, or set it in your secret manager.'
            );
        }
        return $value;
    }
}

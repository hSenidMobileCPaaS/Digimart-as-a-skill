<?php
/**
 * Digimart client — the URL signer and the REST client. ext-curl and ext-bcmath (for decimal
 * money comparisons), no Composer dependency. PHP 8.1+.
 *
 *   1. Charging (subscription and one-time) is a SIGNED URL the customer's
 *      browser opens. Nothing is POSTed. buildSubscriptionUrl() and
 *      buildOneTimeUrl() return it; your start endpoint redirects to it.
 *   2. Subscriber management is REST on a different host with a different
 *      credential. post() injects applicationId + password, times out, and
 *      decides success on statusCode in the body.
 *
 * TLS: cURL verifies by default. Never set CURLOPT_SSL_VERIFYPEER to false;
 * point CURLOPT_CAINFO at a bundle with the intermediate CA if a chain is incomplete.
 *
 * SERVER-SIDE ONLY.
 */

declare(strict_types=1);

namespace App\Digimart;

final class DigimartException extends \RuntimeException
{
    public function __construct(
        public readonly string $statusCode,
        public readonly string $statusDetail,
        public readonly ?string $requestId,
        string $service
    ) {
        parent::__construct("[{$statusCode}] {$statusDetail} ({$service}, requestId {$requestId})");
    }
}

final class DigimartClient
{
    private const TIMEOUT_SECONDS = 15;
    public const ONE_TIME_MIN = '1';
    public const ONE_TIME_MAX = '600';

    public const SDK_CONFIGURATION = ['E1006', 'E1007', 'E1008', 'E1010', 'E1011'];
    public const SDK_TRANSIENT     = ['E1001', 'E1013', 'E2001', 'E2003', 'E2004'];
    public const SDK_USER_STATE    = ['E1014', 'E2002', 'E3001', 'E3002', 'E3003', 'E3004', 'E3005', 'E3006', 'E3007', 'E3009', 'E4001'];

    /** REST success is per call. Subscriber List also permits S1001 (no published meaning). */
    public const REST_SUCCESS_DEFAULT         = ['S1000'];
    public const REST_SUCCESS_GET_SUBSCRIBERS = ['S1000', 'S1001'];

    public function __construct(private readonly DigimartConfig $config) {}

    /* ── Signing ─────────────────────────────────────────────────────────── */

    /** 2024-07-08T10:33:54.929Z — true UTC with real milliseconds, never Dhaka wall-clock with a Z. */
    public static function requestTimeNow(): string
    {
        return (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z');
    }

    /** 15 digits, first non-zero, random — never the clock (collides: E1005). */
    public static function newRequestId(): string
    {
        return (string) random_int(1_000_000, 9_999_999) . str_pad((string) random_int(0, 99_999_999), 8, '0', STR_PAD_LEFT);
    }

    /**
     * SHA-512 over the pipe-joined fields, lowercase hex.
     *   subscription: apiKey|requestTime|apiSecret
     *   one-time:     apiKey|requestTime|apiSecret|amount
     *
     * Known answer (keep it in your tests):
     *   sign('myApiKey123', '2024-08-08T12:00:00Z', 'mySecretKey456', '50') ===
     *   '3badf638ceca499000fd07b899e5fc0cec348d9762886b8430104291126683892845a208caef8e99b53432571e46c5f04162a1a25646443f7935239ea0901b38'
     */
    public static function sign(string ...$fields): string
    {
        return hash('sha512', implode('|', $fields));
    }

    /** Format ONCE; the same string goes into the hash and the URL. */
    public static function formatAmount(string|int $amount): string
    {
        $text = trim((string) $amount);
        if (!preg_match('/^\d+(\.\d+)?$/', $text)) {
            throw new \InvalidArgumentException("[digimart] amount must be a plain number, got {$text}");
        }
        if (bccomp($text, self::ONE_TIME_MIN, 2) < 0 || bccomp($text, self::ONE_TIME_MAX, 2) > 0) {
            throw new \InvalidArgumentException("[digimart] amount {$text} is outside 1-600 BDT (E1330/E1329)");
        }
        return $text;
    }

    /** @return array{url:string, requestId:string, requestTime:string} */
    private function authorize(string $base, string $requestId, string $requestTime, string $signature, array $extra): array
    {
        $params = array_filter([
            'apiKey'      => $this->config->apiKey,
            'requestId'   => $requestId,
            'requestTime' => $requestTime,
            'signature'   => $signature,
            'redirectUrl' => $this->config->redirectUrl,
        ] + $extra, static fn ($v) => $v !== null && $v !== '');
        return ['url' => $base . '?' . http_build_query($params, '', '&', PHP_QUERY_RFC3986),
                'requestId' => $requestId, 'requestTime' => $requestTime];
    }

    /** Subscription flow. $heAmount only for the header-enrichment variant — NOT signed. */
    public function buildSubscriptionUrl(?string $requestId = null, ?string $msisdn = null, ?string $heAmount = null): array
    {
        $base = $this->config->requireEndpoint('subscriptionAuthorize');
        $requestId ??= self::newRequestId();
        $requestTime = self::requestTimeNow();
        $signature = self::sign($this->config->apiKey, $requestTime, $this->config->apiSecret());
        return $this->authorize($base, $requestId, $requestTime, $signature, ['msisdn' => $msisdn, 'amount' => $heAmount]);
    }

    /** One-time (CaaS) flow. The amount is signed AND sent. Take it from your price list. */
    public function buildOneTimeUrl(string|int $amount, ?string $requestId = null, ?string $msisdn = null): array
    {
        $base = $this->config->requireEndpoint('caasAuthorize');
        $amountText = self::formatAmount($amount);
        $requestId ??= self::newRequestId();
        $requestTime = self::requestTimeNow();
        $signature = self::sign($this->config->apiKey, $requestTime, $this->config->apiSecret(), $amountText);
        return $this->authorize($base, $requestId, $requestTime, $signature, ['msisdn' => $msisdn, 'amount' => $amountText]);
    }

    /* ── Status codes ────────────────────────────────────────────────────── */

    /** success | configuration | transient | user-state | client */
    public static function classifySdkCode(string $code): string
    {
        return match (true) {
            $code === 'S1000'                                => 'success',
            in_array($code, self::SDK_CONFIGURATION, true)   => 'configuration',
            in_array($code, self::SDK_TRANSIENT, true)       => 'transient',
            in_array($code, self::SDK_USER_STATE, true)      => 'user-state',
            default                                          => 'client',
        };
    }

    /* ── Addressing ──────────────────────────────────────────────────────── */

    public static function fromTel(string $value): string
    {
        return (string) preg_replace('/^tel:\s*/i', '', trim($value));
    }

    /** The ONLY place tel: is added. No space after the colon. */
    public static function toTel(string $subscriberId): string
    {
        $bare = self::fromTel($subscriberId);
        if ($bare === '') {
            throw new \InvalidArgumentException('[digimart] empty subscriberId');
        }
        return 'tel:' . $bare;
    }

    public static function maskId(string $value): string
    {
        $s = self::fromTel($value);
        return strlen($s) <= 8 ? '***' : substr($s, 0, 4) . '…' . substr($s, -4);
    }

    /* ── REST ────────────────────────────────────────────────────────────── */

    private function post(string $service, array $body, array $success = self::REST_SUCCESS_DEFAULT): array
    {
        $payload = ['applicationId' => $this->config->applicationId, 'password' => $this->config->password()] + $body;
        $ch = curl_init($this->config->requireEndpoint($service));
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES),
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json;charset=utf-8'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => self::TIMEOUT_SECONDS,
        ]);
        $raw = curl_exec($ch);
        $error = curl_error($ch);
        curl_close($ch);
        if ($raw === false) {
            throw new DigimartException('TRANSPORT', $error, null, $service);
        }
        $data = json_decode((string) $raw, true);
        if (!is_array($data)) {
            throw new DigimartException('NOT_JSON', 'Response was not JSON', null, $service);
        }
        $code = (string) ($data['statusCode'] ?? '');
        if (!in_array($code, $success, true)) { // the body decides, not the HTTP status
            throw new DigimartException($code ?: 'NO_CODE', (string) ($data['statusDetail'] ?? 'no statusDetail'), $data['requestId'] ?? null, $service);
        }
        return $data;
    }

    /** One page. requestPage is the ONLY integer in any Digimart body. */
    public function getSubscribers(int $requestPage, ?string $status = null, ?string $subscriberRequestId = null): array
    {
        $body = array_filter(['version' => '2.0', 'requestPage' => $requestPage, 'status' => $status,
            'subscriberRequestId' => $subscriberRequestId], static fn ($v) => $v !== null);
        $data = $this->post('getSubscribers', $body, self::REST_SUCCESS_GET_SUBSCRIBERS);

        $subs = $data['subscribers'] ?? [];
        if ($subs !== [] && !array_is_list($subs)) {
            $subs = [$subs]; // typed as one object in the spec, an array in the example
        }
        $more = ($data['moreDataAvailable'] ?? false) === true && ($data['nextPageNumber'] ?? -1) !== -1;
        return ['subscribers' => $subs, 'nextPage' => $more ? (int) $data['nextPageNumber'] : null,
                'statusCode' => $data['statusCode'], 'requestId' => $data['requestId'] ?? null];
    }

    /** subscriberId is an ARRAY. Check every entry's statusCode. */
    public function getChargingInfo(array $subscriberIds): array
    {
        $data = $this->post('chargingInfo', ['subscriberId' => array_map([self::class, 'toTel'], $subscriberIds)]);
        return $data['destinationResponses'] ?? [];
    }

    /** ONE subscriber, a string; action is the string "0". The id comes from YOUR store. */
    public function unsubscribe(string $subscriberId): string
    {
        $data = $this->post('unregistration', ['subscriberId' => self::toTel($subscriberId), 'action' => '0']);
        return rtrim((string) ($data['subscriptionStatus'] ?? ''), " .");
    }
}

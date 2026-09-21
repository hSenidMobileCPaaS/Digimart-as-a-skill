<?php
/**
 * The endpoints YOU build for Digimart — framework-neutral front controller.
 *
 *   POST /digimart/checkout                 start a one-time charge   (your users)
 *   POST /digimart/subscribe                start a subscription      (your users)
 *   GET  /digimart/return                   the redirectUrl           (the customer's browser)
 *   POST /api/digimart/charging/notify      Async charging resp URL   (Digimart's server)
 *   POST /api/digimart/subscription/notify  Subscription Notification URL (Digimart's server)
 *   POST /digimart/unsubscribe              your cancel button        (your users)
 *
 * The redirect is UNTRUSTED and grants nothing. Notifications are answered 200
 * first; the work happens after the response is flushed.
 *
 * Laravel: one controller per route; exempt /api/digimart/* from VerifyCsrfToken;
 * dispatch a queued job for the notification work instead of fastcgi_finish_request().
 */

declare(strict_types=1);

namespace App\Digimart;

require_once __DIR__ . '/DigimartConfig.php';
require_once __DIR__ . '/DigimartClient.php';

/**
 * Replace with your database. Everything here must be shared across requests,
 * so this sketch uses a JSON file under sys_get_temp_dir() purely to run.
 * Production: tables (orders by requestId, subscribers by user) and a unique
 * constraint for the dedupe keys.
 */
final class Store
{
    private string $file;
    public array $data;

    public function __construct()
    {
        $this->file = sys_get_temp_dir() . '/digimart-demo-store.json';
        $this->data = is_file($this->file)
            ? (json_decode((string) file_get_contents($this->file), true) ?: [])
            : [];
        $this->data += ['orders' => [], 'subsByRequestId' => [], 'userToRequestId' => [], 'seen' => []];
    }

    public function save(): void
    {
        file_put_contents($this->file, json_encode($this->data), LOCK_EX);
    }
}

/** The amount is signed — it comes from here, never from the request. */
const PRICE_LIST = ['premium-article' => '10', 'credits-100' => '50'];

function json_out(int $status, array $body): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($body);
}

function current_user(): ?string
{
    return $_SERVER['HTTP_X_USER_ID'] ?? null; // replace with your authentication
}

function respond_with_url(string $url, string $requestId): void
{
    if (str_contains($_SERVER['HTTP_ACCEPT'] ?? '', 'application/json')) {
        json_out(200, ['url' => $url, 'requestId' => $requestId]); // SPA / web view opens it
        return;
    }
    header('Location: ' . $url, true, 302);
}

/** Answer 200 now; the caller continues the work after this returns. */
function acknowledge(): array
{
    $body = json_decode((string) file_get_contents('php://input'), true);
    json_out(200, ['received' => true]); // no response body is published
    if (function_exists('fastcgi_finish_request')) {
        fastcgi_finish_request();
    }
    return is_array($body) ? $body : []; // malformed → empty, still 200
}

$config = new DigimartConfig();
$client = new DigimartClient($config);
$store  = new Store();
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path   = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);

switch ("{$method} {$path}") {

    /* ── Start endpoints ─────────────────────────────────────────────────── */

    case 'POST /digimart/checkout':
        $userId = current_user();
        if ($userId === null) { json_out(401, ['error' => 'unauthenticated']); break; }
        $input  = json_decode((string) file_get_contents('php://input'), true) ?: [];
        $amount = PRICE_LIST[$input['itemId'] ?? ''] ?? null;
        if ($amount === null) { json_out(404, ['error' => 'unknown item']); break; }

        $requestId = DigimartClient::newRequestId();
        $store->data['orders'][$requestId] = ['userId' => $userId, 'itemId' => $input['itemId'], 'amount' => $amount, 'state' => 'PENDING'];
        $store->save(); // BEFORE redirecting — the notification is matched on requestId
        respond_with_url($client->buildOneTimeUrl($amount, $requestId)['url'], $requestId);
        break;

    case 'POST /digimart/subscribe':
        $userId = current_user();
        if ($userId === null) { json_out(401, ['error' => 'unauthenticated']); break; }
        $requestId = DigimartClient::newRequestId();
        $store->data['subsByRequestId'][$requestId] = ['userId' => $userId];
        $store->data['userToRequestId'][$userId] = $requestId;
        $store->save();
        respond_with_url($client->buildSubscriptionUrl($requestId)['url'], $requestId);
        break;

    /* ── Redirect page — picks a screen, grants nothing ──────────────────── */

    case 'GET /digimart/return':
        $status       = (string) ($_GET['subscriptionStatus'] ?? '');
        $requestId    = (string) ($_GET['requestId'] ?? '');
        $subscriberId = (string) ($_GET['subscriberId'] ?? '');
        $order = $store->data['orders'][$requestId] ?? null;
        $sub   = $store->data['subsByRequestId'][$requestId] ?? null;
        if ($order === null && $sub === null) { json_out(200, ['message' => "We couldn't find that payment."]); break; }

        if ($sub !== null && $subscriberId !== '' && empty($sub['subscriberId'])) {
            $store->data['subsByRequestId'][$requestId] += ['subscriberId' => $subscriberId, 'provisional' => true];
            $store->save(); // provisional — the notification confirms it
        }
        $outcome = DigimartClient::classifySdkCode($status);
        if (in_array($outcome, ['client', 'configuration'], true)) {
            error_log("digimart redirect failure requestId={$requestId} code={$status}");
        }
        $message = [
            'S1000' => 'Payment received — confirming…',
            'E3009' => 'Your balance is too low. Please recharge and try again.',
            'E3001' => "You're already subscribed.",
            'E4001' => "That code wasn't right. Please try again.",
        ][$status] ?? match ($outcome) {
            'user-state' => "This number can't complete the payment right now. Please try again later.",
            'transient'  => 'Something went wrong on our side. Please try again.',
            default      => "Sorry, we couldn't start the payment. Please try again later.",
        };
        // Never the raw code. On S1000 the page polls YOUR order status.
        json_out(200, ['requestId' => $requestId, 'message' => $message, 'pending' => $status === 'S1000']);
        break;

    /* ── Notifications — 200 first, then verify, dedupe, settle ─────────── */

    case 'POST /api/digimart/charging/notify':
        $body = acknowledge();
        if (isset($body['applicationId']) && $body['applicationId'] !== $config->applicationId) {
            error_log('digimart charging notification for another application — ignored');
            break;
        }
        $requestId  = (string) ($body['requestId'] ?? '');
        $statusCode = (string) ($body['statusCode'] ?? '');
        $key = 'charge:' . ($body['internalTrxId'] ?? $requestId) . ':' . $statusCode;
        if (isset($store->data['seen'][$key])) break; // replay
        $store->data['seen'][$key] = true;
        error_log("digimart charging requestId={$requestId} statusCode={$statusCode} subscriber=" . DigimartClient::maskId((string) ($body['subscriberId'] ?? '')));

        $order = $store->data['orders'][$requestId] ?? null;
        if ($order === null) {
            if (isset($store->data['subsByRequestId'][$requestId]) && $statusCode === 'S1000') { // header-enrichment subscription
                $store->data['subsByRequestId'][$requestId] = array_merge($store->data['subsByRequestId'][$requestId], [
                    'subscriberId' => $body['subscriberId'] ?? ($store->data['subsByRequestId'][$requestId]['subscriberId'] ?? null),
                    'provisional' => false, 'status' => 'REGISTERED',
                ]);
            }
        } elseif ($order['state'] === 'PENDING') {
            if ($statusCode !== 'S1000') {
                $store->data['orders'][$requestId]['state'] = 'FAILED';
            } else {
                $paid = (string) ($body['paidAmount'] ?? '');
                $due  = (string) ($body['balanceDue'] ?? '0');
                if (!is_numeric($paid) || bccomp($paid, $order['amount'], 2) !== 0 || bccomp($due, '0', 2) !== 0) {
                    error_log("digimart amount mismatch requestId={$requestId} paid={$paid} expected={$order['amount']} due={$due}");
                } else {
                    $store->data['orders'][$requestId]['internalTrxId'] = $body['internalTrxId'] ?? null;
                    $store->data['orders'][$requestId]['state'] = 'FULFILLED'; // deliver exactly once here
                }
            }
        }
        $store->save();
        break;

    case 'POST /api/digimart/subscription/notify':
        $body = acknowledge();
        if (isset($body['applicationId']) && $body['applicationId'] !== $config->applicationId) {
            error_log('digimart subscription notification for another application — ignored');
            break;
        }
        $subscriberId = (string) ($body['subscriberId'] ?? '');
        $status       = (string) ($body['status'] ?? '');
        if ($subscriberId === '' || $status === '') { error_log('digimart subscription notification missing fields'); break; }
        $key = "sub:{$subscriberId}:{$status}:" . ($body['timeStamp'] ?? '');
        if (isset($store->data['seen'][$key])) break;
        $store->data['seen'][$key] = true;

        $requestId = (string) ($body['subscriberRequestId'] ?? '');
        if (!isset($store->data['subsByRequestId'][$requestId])) {
            error_log('digimart subscription notification for unknown requestId');
        } else {
            // The authoritative mapping. REGISTERED grant · REG_PENDING hold · TEMPORARY_BLOCKED suspend
            $store->data['subsByRequestId'][$requestId] = array_merge($store->data['subsByRequestId'][$requestId], [
                'subscriberId' => $subscriberId, 'provisional' => false, 'status' => $status,
                'frequency' => $body['frequency'] ?? null,
            ]);
        }
        $store->save();
        break;

    /* ── Cancel — the id comes from YOUR store, never the client ─────────── */

    case 'POST /digimart/unsubscribe':
        $userId    = current_user();
        $requestId = $store->data['userToRequestId'][$userId ?? ''] ?? null;
        $sub       = $requestId ? ($store->data['subsByRequestId'][$requestId] ?? null) : null;
        if (empty($sub['subscriberId'])) { json_out(404, ['error' => 'no active subscription']); break; }
        try {
            $status = $client->unsubscribe($sub['subscriberId']);
            if ($status === 'UNREGISTERED') {
                $store->data['subsByRequestId'][$requestId]['status'] = 'UNREGISTERED'; // end access now
                $store->save();
            }
            json_out(200, ['status' => $status]);
        } catch (DigimartException $e) {
            error_log('digimart unsubscribe failed — keep the request and retry: ' . $e->getMessage());
            json_out(502, ['error' => 'could not cancel right now']);
        }
        break;

    default:
        json_out(404, ['error' => 'not found']);
}

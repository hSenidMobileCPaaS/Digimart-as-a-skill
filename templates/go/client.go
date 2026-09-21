package digimart

// Digimart client — the URL signer and the REST client. Standard library only.
//
//  1. Charging (subscription and one-time) is a SIGNED URL the customer's
//     browser opens. Nothing is POSTed. BuildSubscriptionURL and BuildOneTimeURL
//     return it; your start endpoint redirects to it.
//  2. Subscriber management is REST on a different host with a different
//     credential. post() injects applicationId + password, times out, and
//     decides success on statusCode in the body.
//
// TLS: net/http verifies certificates by default. Never set
// InsecureSkipVerify; add the intermediate CA to RootCAs if a chain is incomplete.

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const timeout = 15 * time.Second

// One-time band in BDT. Outside it: E1330 (low) / E1329 (high).
const (
	OneTimeMin = 1.0
	OneTimeMax = 600.0
)

var (
	// SDK codes as they arrive on the redirect and the charging notification.
	SDKConfiguration = set("E1006", "E1007", "E1008", "E1010", "E1011")
	SDKTransient     = set("E1001", "E1013", "E2001", "E2003", "E2004")
	SDKUserState     = set("E1014", "E2002", "E3001", "E3002", "E3003", "E3004", "E3005", "E3006", "E3007", "E3009", "E4001")

	// REST success is per call. Subscriber List also permits S1001 (no published meaning).
	RESTSuccessDefault        = set("S1000")
	RESTSuccessGetSubscribers = set("S1000", "S1001")

	amountPattern = regexp.MustCompile(`^\d+(\.\d+)?$`)
	telPrefix     = regexp.MustCompile(`(?i)^tel:\s*`)
)

func set(values ...string) map[string]bool {
	m := map[string]bool{}
	for _, v := range values {
		m[v] = true
	}
	return m
}

// Client is safe for concurrent use.
type Client struct {
	cfg  *Config
	http *http.Client
}

func NewClient(cfg *Config) *Client {
	return &Client{cfg: cfg, http: &http.Client{Timeout: timeout}}
}

/* ── Signing ─────────────────────────────────────────────────────────────── */

// RequestTimeNow is the current instant as 2024-07-08T10:33:54.929Z — true
// UTC, never Dhaka wall-clock time with a Z.
func RequestTimeNow() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// NewRequestID returns 15 random digits, first non-zero. Never the clock (E1005).
func NewRequestID() string {
	n, err := rand.Int(rand.Reader, big.NewInt(900_000_000_000_000))
	if err != nil {
		panic(err)
	}
	return n.Add(n, big.NewInt(100_000_000_000_000)).String()
}

// Sign is SHA-512 over the pipe-joined fields, lowercase hex.
//
//	subscription: apiKey|requestTime|apiSecret
//	one-time:     apiKey|requestTime|apiSecret|amount
//
// Known answer (keep it in your tests):
//
//	Sign("myApiKey123", "2024-08-08T12:00:00Z", "mySecretKey456", "50") ==
//	"3badf638ceca499000fd07b899e5fc0cec348d9762886b8430104291126683892845a208caef8e99b53432571e46c5f04162a1a25646443f7935239ea0901b38"
func Sign(fields ...string) string {
	sum := sha512.Sum512([]byte(strings.Join(fields, "|")))
	return hex.EncodeToString(sum[:])
}

// FormatAmount validates once; the same string goes into the hash and the URL.
func FormatAmount(amount string) (string, error) {
	text := strings.TrimSpace(amount)
	if !amountPattern.MatchString(text) {
		return "", fmt.Errorf("[digimart] amount must be a plain number, got %q", text)
	}
	var v float64
	fmt.Sscan(text, &v) // range check only; the string itself is what gets signed
	if v < OneTimeMin || v > OneTimeMax {
		return "", fmt.Errorf("[digimart] amount %s is outside 1-600 BDT (E1330/E1329)", text)
	}
	return text, nil
}

// AuthorizeURL is what a start endpoint redirects to.
type AuthorizeURL struct {
	URL, RequestID, RequestTime string
}

func authorize(base string, params [][2]string) string {
	q := url.Values{}
	for _, p := range params {
		if p[1] != "" {
			q.Set(p[0], p[1])
		}
	}
	return base + "?" + q.Encode()
}

// BuildSubscriptionURL — heAmount only for the header-enrichment variant; NOT signed.
func (c *Client) BuildSubscriptionURL(requestID, msisdn, heAmount string) (AuthorizeURL, error) {
	base, err := c.cfg.RequireEndpoint("subscriptionAuthorize")
	if err != nil {
		return AuthorizeURL{}, err
	}
	rt := RequestTimeNow()
	sig := Sign(c.cfg.APIKey, rt, c.cfg.apiSecret)
	return AuthorizeURL{authorize(base, [][2]string{
		{"apiKey", c.cfg.APIKey}, {"requestId", requestID}, {"requestTime", rt}, {"signature", sig},
		{"redirectUrl", c.cfg.RedirectURL}, {"msisdn", msisdn}, {"amount", heAmount},
	}), requestID, rt}, nil
}

// BuildOneTimeURL — the amount is signed AND sent. Take it from your price list.
func (c *Client) BuildOneTimeURL(requestID, amount, msisdn string) (AuthorizeURL, error) {
	base, err := c.cfg.RequireEndpoint("caasAuthorize")
	if err != nil {
		return AuthorizeURL{}, err
	}
	amt, err := FormatAmount(amount)
	if err != nil {
		return AuthorizeURL{}, err
	}
	rt := RequestTimeNow()
	sig := Sign(c.cfg.APIKey, rt, c.cfg.apiSecret, amt)
	return AuthorizeURL{authorize(base, [][2]string{
		{"apiKey", c.cfg.APIKey}, {"requestId", requestID}, {"requestTime", rt}, {"signature", sig},
		{"redirectUrl", c.cfg.RedirectURL}, {"msisdn", msisdn}, {"amount", amt},
	}), requestID, rt}, nil
}

/* ── Status codes ────────────────────────────────────────────────────────── */

// ClassifySDKCode returns success | configuration | transient | user-state | client.
func ClassifySDKCode(code string) string {
	switch {
	case code == "S1000":
		return "success"
	case SDKConfiguration[code]:
		return "configuration"
	case SDKTransient[code]:
		return "transient"
	case SDKUserState[code]:
		return "user-state"
	default:
		return "client"
	}
}

// Error carries statusDetail and requestId — for most REST codes the only explanation.
type Error struct {
	StatusCode, StatusDetail, RequestID, Service string
}

func (e *Error) Error() string {
	return fmt.Sprintf("[%s] %s (%s, requestId %s)", e.StatusCode, e.StatusDetail, e.Service, e.RequestID)
}

/* ── Addressing ──────────────────────────────────────────────────────────── */

// FromTel strips tel: and the space some published examples put after it.
func FromTel(v string) string { return telPrefix.ReplaceAllString(strings.TrimSpace(v), "") }

// ToTel is the ONLY place tel: is added. No space after the colon.
func ToTel(subscriberID string) string { return "tel:" + FromTel(subscriberID) }

// MaskID for logs.
func MaskID(v string) string {
	s := FromTel(v)
	if len(s) <= 8 {
		return "***"
	}
	return s[:4] + "…" + s[len(s)-4:]
}

/* ── REST ────────────────────────────────────────────────────────────────── */

type envelope struct {
	Version      string `json:"version"`
	StatusCode   string `json:"statusCode"`
	StatusDetail string `json:"statusDetail"`
	RequestID    string `json:"requestId"`
}

func (c *Client) post(ctx context.Context, service string, body map[string]any, success map[string]bool, out any) error {
	endpoint, err := c.cfg.RequireEndpoint(service)
	if err != nil {
		return err
	}
	body["applicationId"] = c.cfg.ApplicationID // credentials injected here only
	body["password"] = c.cfg.password
	payload, _ := json.Marshal(body)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json;charset=utf-8")
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	var raw json.RawMessage
	if err := json.NewDecoder(res.Body).Decode(&raw); err != nil {
		return &Error{StatusCode: fmt.Sprintf("HTTP%d", res.StatusCode), StatusDetail: "response was not JSON", Service: service}
	}
	var env envelope
	_ = json.Unmarshal(raw, &env)
	if !success[env.StatusCode] { // the body decides, not the HTTP status
		return &Error{StatusCode: env.StatusCode, StatusDetail: env.StatusDetail, RequestID: env.RequestID, Service: service}
	}
	return json.Unmarshal(raw, out)
}

// Subscriber is one entry from Subscriber List or Charging Info.
type Subscriber struct {
	SubscriberID        string `json:"subscriberId"`
	SubscriberRequestID string `json:"subscriberRequestId"`
	SubscriptionStatus  string `json:"subscriptionStatus"`
	LastChargedDate     string `json:"lastChargedDate"`
	LastChargedAmount   string `json:"lastChargedAmount"`
	NumberType          string `json:"numberType,omitempty"`
	StatusCode          string `json:"statusCode,omitempty"`
	StatusDetail        string `json:"statusDetail,omitempty"`
}

// GetSubscribers returns one page and the next page number (0 when done).
// requestPage is the ONLY integer in any Digimart body.
func (c *Client) GetSubscribers(ctx context.Context, page int, status, subscriberRequestID string) ([]Subscriber, int, error) {
	body := map[string]any{"version": "2.0", "requestPage": page}
	if status != "" {
		body["status"] = status
	}
	if subscriberRequestID != "" {
		body["subscriberRequestId"] = subscriberRequestID
	}
	var res struct {
		NextPageNumber    int             `json:"nextPageNumber"`
		MoreDataAvailable bool            `json:"moreDataAvailable"`
		Subscribers       json.RawMessage `json:"subscribers"`
	}
	if err := c.post(ctx, "getSubscribers", body, RESTSuccessGetSubscribers, &res); err != nil {
		return nil, 0, err
	}
	// Typed as one object in the spec, an array in the example.
	var list []Subscriber
	if len(res.Subscribers) > 0 && res.Subscribers[0] == '{' {
		var one Subscriber
		_ = json.Unmarshal(res.Subscribers, &one)
		list = []Subscriber{one}
	} else if len(res.Subscribers) > 0 {
		_ = json.Unmarshal(res.Subscribers, &list)
	}
	next := 0
	if res.MoreDataAvailable && res.NextPageNumber != -1 {
		next = res.NextPageNumber
	}
	return list, next, nil
}

// GetChargingInfo — subscriberId is an ARRAY. Check every entry's StatusCode.
func (c *Client) GetChargingInfo(ctx context.Context, subscriberIDs []string) ([]Subscriber, error) {
	ids := make([]string, len(subscriberIDs))
	for i, id := range subscriberIDs {
		ids[i] = ToTel(id)
	}
	var res struct {
		DestinationResponses []Subscriber `json:"destinationResponses"`
	}
	err := c.post(ctx, "chargingInfo", map[string]any{"subscriberId": ids}, RESTSuccessDefault, &res)
	return res.DestinationResponses, err
}

// Unsubscribe — ONE subscriber, a string; action is the string "0".
// The id comes from YOUR store, never the client.
func (c *Client) Unsubscribe(ctx context.Context, subscriberID string) (string, error) {
	var res struct {
		SubscriptionStatus string `json:"subscriptionStatus"`
	}
	err := c.post(ctx, "unregistration", map[string]any{"subscriberId": ToTel(subscriberID), "action": "0"}, RESTSuccessDefault, &res)
	return strings.TrimRight(res.SubscriptionStatus, " ."), err
}

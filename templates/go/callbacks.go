package digimart

// The endpoints YOU build for Digimart, as net/http handlers (they mount on
// chi, gin, echo or http.ServeMux unchanged).
//
//	POST /digimart/checkout                 start a one-time charge   (your users)
//	POST /digimart/subscribe                start a subscription      (your users)
//	GET  /digimart/return                   the redirectUrl           (the customer's browser)
//	POST /api/digimart/charging/notify      Async charging resp URL   (Digimart's server)
//	POST /api/digimart/subscription/notify  Subscription Notification URL (Digimart's server)
//	POST /digimart/unsubscribe              your cancel button        (your users)
//
// The redirect is UNTRUSTED and grants nothing. Notifications are acknowledged
// with 200 immediately and handed to a worker goroutine over a channel.

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"math/big"
	"net/http"
	"strings"
	"sync"
)

// PriceList — the amount is signed, so it comes from here, never the request.
var PriceList = map[string]string{"premium-article": "10", "credits-100": "50"}

// In-process state so the file runs as-is. In production: database tables and
// a unique constraint (or Redis SETNX) for dedupe, shared by every instance.
type order struct {
	UserID, ItemID, Amount, State, InternalTrxID string
}
type subscription struct {
	UserID, RequestID, SubscriberID, Status, Frequency string
	Provisional                                        bool
}

type Handlers struct {
	cfg    *Config
	client *Client

	mu              sync.Mutex
	orders          map[string]*order
	subsByRequestID map[string]*subscription
	subsByUser      map[string]*subscription
	seen            map[string]bool

	queue chan func()
}

func NewHandlers(cfg *Config, client *Client) *Handlers {
	h := &Handlers{
		cfg: cfg, client: client,
		orders: map[string]*order{}, subsByRequestID: map[string]*subscription{},
		subsByUser: map[string]*subscription{}, seen: map[string]bool{},
		queue: make(chan func(), 1024),
	}
	go func() { // the worker: notification processing happens here, after the 200
		for job := range h.queue {
			job()
		}
	}()
	return h
}

// Register mounts every route.
func (h *Handlers) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /digimart/checkout", h.checkout)
	mux.HandleFunc("POST /digimart/subscribe", h.subscribe)
	mux.HandleFunc("GET /digimart/return", h.redirectReturn)
	mux.HandleFunc("POST /api/digimart/charging/notify", h.acknowledgeThen(h.processCharging))
	mux.HandleFunc("POST /api/digimart/subscription/notify", h.acknowledgeThen(h.processSubscription))
	mux.HandleFunc("POST /digimart/unsubscribe", h.unsubscribe)
}

// currentUser — replace with your authentication.
func currentUser(r *http.Request) string { return r.Header.Get("X-User-Id") }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func respond(w http.ResponseWriter, r *http.Request, url, requestID string) {
	if strings.Contains(r.Header.Get("Accept"), "application/json") {
		writeJSON(w, 200, map[string]string{"url": url, "requestId": requestID}) // SPA / web view opens it
		return
	}
	http.Redirect(w, r, url, http.StatusFound)
}

/* ── Start endpoints ─────────────────────────────────────────────────────── */

func (h *Handlers) checkout(w http.ResponseWriter, r *http.Request) {
	userID := currentUser(r)
	if userID == "" {
		writeJSON(w, 401, map[string]string{"error": "unauthenticated"})
		return
	}
	var body struct{ ItemID string `json:"itemId"` }
	_ = json.NewDecoder(io.LimitReader(r.Body, 32<<10)).Decode(&body)
	amount, ok := PriceList[body.ItemID]
	if !ok {
		writeJSON(w, 404, map[string]string{"error": "unknown item"})
		return
	}
	requestID := NewRequestID()
	h.mu.Lock()
	h.orders[requestID] = &order{UserID: userID, ItemID: body.ItemID, Amount: amount, State: "PENDING"} // BEFORE redirect
	h.mu.Unlock()

	built, err := h.client.BuildOneTimeURL(requestID, amount, "")
	if err != nil {
		log.Printf("digimart checkout: %v", err)
		writeJSON(w, 500, map[string]string{"error": "payments unavailable"})
		return
	}
	respond(w, r, built.URL, requestID)
}

func (h *Handlers) subscribe(w http.ResponseWriter, r *http.Request) {
	userID := currentUser(r)
	if userID == "" {
		writeJSON(w, 401, map[string]string{"error": "unauthenticated"})
		return
	}
	requestID := NewRequestID()
	rec := &subscription{UserID: userID, RequestID: requestID}
	h.mu.Lock()
	h.subsByRequestID[requestID], h.subsByUser[userID] = rec, rec
	h.mu.Unlock()

	built, err := h.client.BuildSubscriptionURL(requestID, "", "")
	if err != nil {
		log.Printf("digimart subscribe: %v", err)
		writeJSON(w, 500, map[string]string{"error": "payments unavailable"})
		return
	}
	respond(w, r, built.URL, requestID)
}

/* ── Redirect page — picks a screen, grants nothing ──────────────────────── */

func (h *Handlers) redirectReturn(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	status, requestID, subscriberID := q.Get("subscriptionStatus"), q.Get("requestId"), q.Get("subscriberId")

	h.mu.Lock()
	o, sub := h.orders[requestID], h.subsByRequestID[requestID]
	if sub != nil && subscriberID != "" && sub.SubscriberID == "" {
		sub.SubscriberID, sub.Provisional = subscriberID, true // the notification confirms it
	}
	h.mu.Unlock()
	if o == nil && sub == nil {
		writeJSON(w, 200, map[string]string{"message": "We couldn't find that payment."})
		return
	}

	outcome := ClassifySDKCode(status)
	if outcome == "client" || outcome == "configuration" {
		log.Printf("digimart redirect failure requestId=%s code=%s", requestID, status)
	}
	message := map[string]string{
		"S1000": "Payment received — confirming…",
		"E3009": "Your balance is too low. Please recharge and try again.",
		"E3001": "You're already subscribed.",
		"E4001": "That code wasn't right. Please try again.",
	}[status]
	if message == "" {
		message = map[string]string{
			"user-state": "This number can't complete the payment right now. Please try again later.",
			"transient":  "Something went wrong on our side. Please try again.",
		}[outcome]
	}
	if message == "" {
		message = "Sorry, we couldn't start the payment. Please try again later."
	}
	// Never the raw code. On S1000 the page polls YOUR order status.
	writeJSON(w, 200, map[string]any{"requestId": requestID, "message": message, "pending": status == "S1000"})
}

/* ── Notifications — 200 first, then verify, dedupe, settle ──────────────── */

func (h *Handlers) acknowledgeThen(process func(map[string]any)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body := map[string]any{}
		_ = json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&body) // malformed → empty, still 200
		select {
		case h.queue <- func() { process(body) }:
		default:
			log.Printf("digimart notification queue full — dropped; reconcile with Subscriber List")
		}
		writeJSON(w, 200, map[string]bool{"received": true}) // no response body is published
	}
}

func str(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return new(big.Float).SetFloat64(t).Text('f', -1)
	case nil:
		return ""
	default:
		b, _ := json.Marshal(t)
		return string(b)
	}
}

func (h *Handlers) foreign(body map[string]any) bool {
	app, ok := body["applicationId"]
	return ok && str(app) != h.cfg.ApplicationID
}

func equalAmount(a, b string) bool {
	x, okx := new(big.Rat).SetString(a)
	y, oky := new(big.Rat).SetString(b)
	return okx && oky && x.Cmp(y) == 0
}

func (h *Handlers) processCharging(body map[string]any) {
	if h.foreign(body) {
		log.Printf("digimart charging notification for another application — ignored")
		return
	}
	requestID, statusCode := str(body["requestId"]), str(body["statusCode"])
	trx := str(body["internalTrxId"])
	if trx == "" {
		trx = requestID
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	key := "charge:" + trx + ":" + statusCode
	if h.seen[key] {
		return // replay
	}
	h.seen[key] = true
	log.Printf("digimart charging requestId=%s statusCode=%s subscriber=%s", requestID, statusCode, MaskID(str(body["subscriberId"])))

	o := h.orders[requestID]
	if o == nil {
		if sub := h.subsByRequestID[requestID]; sub != nil && statusCode == "S1000" { // header-enrichment subscription
			if id := str(body["subscriberId"]); id != "" {
				sub.SubscriberID = id
			}
			sub.Provisional, sub.Status = false, "REGISTERED"
		}
		return
	}
	if o.State != "PENDING" {
		return
	}
	if statusCode != "S1000" {
		o.State = "FAILED"
		return
	}
	due := str(body["balanceDue"])
	if due == "" {
		due = "0"
	}
	if !equalAmount(str(body["paidAmount"]), o.Amount) || !equalAmount(due, "0") {
		log.Printf("digimart amount mismatch requestId=%s paid=%s expected=%s due=%s", requestID, str(body["paidAmount"]), o.Amount, due)
		return
	}
	o.State, o.InternalTrxID = "PAID", str(body["internalTrxId"])
	o.State = "FULFILLED" // deliver exactly once here
}

func (h *Handlers) processSubscription(body map[string]any) {
	if h.foreign(body) {
		log.Printf("digimart subscription notification for another application — ignored")
		return
	}
	subscriberID, status := str(body["subscriberId"]), str(body["status"])
	if subscriberID == "" || status == "" {
		log.Printf("digimart subscription notification missing fields")
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	key := "sub:" + subscriberID + ":" + status + ":" + str(body["timeStamp"])
	if h.seen[key] {
		return
	}
	h.seen[key] = true

	sub := h.subsByRequestID[str(body["subscriberRequestId"])]
	if sub == nil {
		log.Printf("digimart subscription notification for unknown requestId, subscriber=%s", MaskID(subscriberID))
		return
	}
	sub.SubscriberID, sub.Provisional, sub.Status = subscriberID, false, status // REGISTERED · REG_PENDING · TEMPORARY_BLOCKED
	if f := str(body["frequency"]); f != "" {
		sub.Frequency = f
	}
}

/* ── Cancel — the id comes from YOUR store, never the client ─────────────── */

func (h *Handlers) unsubscribe(w http.ResponseWriter, r *http.Request) {
	userID := currentUser(r)
	h.mu.Lock()
	sub := h.subsByUser[userID]
	h.mu.Unlock()
	if userID == "" || sub == nil || sub.SubscriberID == "" {
		writeJSON(w, 404, map[string]string{"error": "no active subscription"})
		return
	}
	status, err := h.client.Unsubscribe(context.Background(), sub.SubscriberID)
	if err != nil {
		log.Printf("digimart unsubscribe failed — keep the request and retry: %v", err)
		writeJSON(w, 502, map[string]string{"error": "could not cancel right now"})
		return
	}
	if status == "UNREGISTERED" {
		h.mu.Lock()
		sub.Status = "UNREGISTERED" // end access now — no notification is documented
		h.mu.Unlock()
	}
	writeJSON(w, 200, map[string]string{"status": status})
}

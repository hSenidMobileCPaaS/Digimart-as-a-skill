# Getting Started with Digimart

## What Digimart is

Digimart lets an application take money from a **Grameenphone** customer's mobile balance — the
same balance they use for calls and data. It is run by **hSenid Mobile Solutions** to open
Grameenphone's telco assets to developers in **Bangladesh**. Amounts are in **BDT** (taka).

Most people in Bangladesh have never held a credit card, but almost everyone has a phone with
credit on it. Digimart turns that balance into a payment method: no card, no bank account, no
wallet signup.

From the customer's side a payment takes about twenty seconds:

1. They tap *Buy* or *Subscribe* in your app.
2. A Digimart screen shows what they are about to be charged.
3. They receive a one-time password by SMS and type it in.
4. The amount comes off their mobile balance and they land back in your app.

The OTP is consent. Nobody can be charged without confirming it themselves, and Digimart — not
you — sends it, checks it, and renders every one of those screens.

## Two products, one mechanism

| Product | What it does | Guide |
|---|---|---|
| **Subscription** | The customer agrees once and is charged on a repeating cycle (`daily` or `monthly`) until they stop. Digimart runs opt-in, consent, renewal and cancellation against the mobile account. | [03-subscription-sdk.md](03-subscription-sdk.md) |
| **One-time charging (CaaS)** | A single charge of a specific amount between **1 and 600 BDT** — one purchase, one ticket, one unlock. Also called *Charging as a Service* or *on-demand charging*. | [04-one-time-sdk.md](04-one-time-sdk.md) |

Both are **signed URLs**, not REST APIs. Your server builds a URL, signs it with SHA-512, and sends
the customer's browser to it. Digimart owns every screen until it sends the customer back to your
`redirectUrl`, and then tells your server the result with a notification.

Around those flows sit **three REST APIs** for managing subscribers once they exist — list them,
look them up, unsubscribe them — and **two notifications** Digimart posts to you. That is the whole
published surface. See [13-integration-reference.md](13-integration-reference.md) for every one at
the wire.

## Two surfaces, two hosts, two credentials

This is the thing that trips up everyone who has integrated a JSON-only telco platform before:

| | Charging SDK | REST APIs |
|---|---|---|
| Host | `https://user.digimart.store` | `https://api.digimart.store` |
| Shape | A URL opened in the customer's browser | JSON `POST` from your server |
| Credential | **API Key** in the URL + **SHA-512 signature** made with the **API Secret** | **applicationId** + **App Password** in the JSON body |
| Where the credential comes from | Shown on the application in the portal once an administrator approves it | `applicationId` is generated at provisioning; the App Password is **emailed** to the service provider when the app is created |

Never share one base-URL constant between them, and never send the API Secret anywhere — it only
ever goes into the hash.

## How the money works

- **No signup fee, no monthly platform fee, no charge for a sandbox app.**
- **Revenue share.** The customer is charged for the service they take; the sum is split between
  you and Grameenphone at an agreed ratio.
- **Taxes first.** Every price you set includes applicable taxes and government charges, which are
  deducted before the split.
- **hSenid Mobile Solutions settles** the developer share. The ratio and the settlement cycle are
  in your agreement.

Source: <https://digimart.store/docs/how-you-get-paid>, <https://digimart.store/pricing>.

## Create an account

1. Go to the user portal, <https://user.digimart.store/>, and choose *Register As a new user*.
2. Enter your name, email address, and the username and password you want.
3. Digimart emails a one-time password to the address you registered — type it into the
   verification box. Check spam if it does not arrive within a minute or two.
4. Sign in with the username and password from step 2.

An account on its own cannot charge anyone. Next you register an application.

Source: <https://digimart.store/docs/create-account>.

## Provision an application

Once per app, all in the portal, no code:

1. **Log in** to the user portal.
2. **Go to the provisioning area**, where your applications live.
3. Choose **Create New App**.
4. **Basic details** — the app's name, what it does, and who it is for. A reviewer will read this;
   a vague description is the most common reason an app comes back for changes.
5. **Advanced details** — technical settings, including where the app is hosted and how Digimart
   reaches it.
6. **Enable the CaaS API.** Without this your app exists but cannot take money.
7. **CaaS service details** — the service being charged for and how it reaches the customer.
8. **Charging details, and the notification URL** — then **submit for approval**.

The notification URL is the address Digimart's server calls to tell you a charge succeeded. It must
be a real, reachable **HTTPS** address that is live before production — it is how you learn a
payment actually completed. The application carries two notification fields, and the flows use
them differently:

| Field on the application | Receives | From |
|---|---|---|
| **Subscription Notification URL** | Subscription lifecycle notifications | The subscription flow without header enrichment |
| **Async charging resp URL** | Charging results | One-time charges, and subscriptions with header enrichment |

Implement both handlers if there is any chance the application uses both. See
[05-callbacks.md](05-callbacks.md).

Two further settings are switched on **by a Digimart administrator**, not by you:

- **Subscription Charging SDK enabled** for the application — without it, `E1011`.
- **Allow Capturing Mobile Number via Header Enrichment** — switches the subscription flow to the
  header-enrichment variant, where Grameenphone supplies the number from the mobile network.

Source: <https://digimart.store/docs/provision-app>.

### What reviewers look at

| | Why |
|---|---|
| A clear description of the service | So it is obvious what the customer is paying for |
| A working notification URL | So charge results can actually reach you |
| Content that is legal and appropriate | Content that offends the values, culture or sentiments of Bangladesh is prohibited outright |
| Authorisation for any third-party service you resell | You must be able to produce the paperwork on request |

After approval you can publish your service publicly, and the API Key and API Secret become usable
for live charging. Chase a pending review at **support@digimart.store**.

## Sandbox

Sandbox is a free practice mode for an application in the same portal — Digimart publishes **no
separate sandbox host**. Until the app is approved for production, only allowed test numbers can
transact; a number that is not allowed gets `E3005` (*Your Mobile Number Is Not Whitelisted to Use
This Application*). Ask support to allow your test numbers.

## Configuration

One variable per credential and one per endpoint, identical in every language. Copy
[templates/.env.example](../templates/.env.example):

```bash
# Charging SDK
DIGIMART_API_KEY=
DIGIMART_API_SECRET=
DIGIMART_REDIRECT_URL=https://your-app.example/digimart/return
DIGIMART_SUBSCRIPTION_AUTHORIZE_URL=https://user.digimart.store/sdk/subscription/authorize
DIGIMART_CAAS_AUTHORIZE_URL=https://user.digimart.store/sdk/subscription/caas-authorize

# REST
DIGIMART_APP_ID=APP_XXXXXX
DIGIMART_PASSWORD=
DIGIMART_GET_SUBSCRIBERS_URL=https://api.digimart.store/subscription-info-server/getSubscribers
DIGIMART_CHARGING_INFO_URL=https://api.digimart.store/subscription/getSubscriberChargingInfo
DIGIMART_UNREGISTRATION_URL=https://api.digimart.store/subs/unregistration
```

Leave unset what you do not use. An unset endpoint is how your code knows the service is off, and
the client should refuse to use it rather than fail at the platform.

## Your first three checks

**1. Your hashing, before anything else.** Hash Digimart's worked example in your language and
compare with the known digest:

```bash
node tools/digimart.mjs sign --example one-time
# or, with nothing but a shell:
printf '%s' 'myApiKey123|2024-08-08T12:00:00Z|mySecretKey456|50' | openssl dgst -sha512
# 3badf638ceca499000fd07b899e5fc0cec348d9762886b8430104291126683892845a208caef8e99b53432571e46c5f04162a1a25646443f7935239ea0901b38
```

**2. A real signed URL, opened in a browser.** With the credentials exported:

```bash
node tools/digimart.mjs url subscription redirectUrl=https://your-app.example/digimart/return
```

Open the printed URL. If Digimart shows its number-entry (or price-confirmation) screen, your key,
signature and time are right. If it shows an error, decode the code with
`node tools/digimart.mjs code <CODE>`.

**3. The REST credentials.** Subscriber Charging Info with a subscriber you have, or Subscriber
List page 1:

```bash
node tools/digimart.mjs curl get-subscribers requestPage=1
```

Then build the integration: [11-implementation-playbook.md](11-implementation-playbook.md).

## Developer obligations that affect the build

From the developer terms (<https://digimart.store/legal/terms>) and the go-live checklist:

- Respond to any customer query or claim **within 24 hours** — a binding term.
- **Cancelling a subscription must be obvious and must work.**
- Secure all links between you and hSenid against unauthorised access.
- Send no unsolicited material.
- Hold documented authorisation for any third-party service you resell.
- Marketing material goes to **support@digimart.store** for approval before publication; do not
  use the hSenid logo, and use the hSenid name only in standard, non-bold font.
- Comply with Bangladesh government regulations and the telecommunication authority's rules.

## Where to go for help

- Documentation — <https://digimart.store/docs>
- Portal — <https://user.digimart.store/>
- Support — **support@digimart.store** · +8801764987009 (also WhatsApp)

Quote the `requestId` (and `internalTrxId` for a charge) and the status code.

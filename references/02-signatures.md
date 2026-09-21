# Signatures

Every charging URL carries a signature that proves it came from you and was not modified. Getting it
wrong produces **`E1002` — Invalid Signature**, comfortably the most reported Digimart integration
problem.

Source: <https://digimart.store/docs/signatures>.

## How it works

The API Secret never travels over the network. You join a few known values with the secret, hash
the result with **SHA-512**, and send the hash. Digimart holds its own copy of the secret, rebuilds
the same hash from the values in your URL, and compares.

Signatures belong to the **charging SDK only**. The REST APIs authenticate with `applicationId` and
the App Password in the body and carry no signature.

## The signing strings

Fields joined with a pipe. No spaces, no trailing separator, in exactly this order:

```
# Subscription — both variants — three fields
apiKey|requestTime|apiSecret

# One-time charge (CaaS) — four fields, amount last
apiKey|requestTime|apiSecret|amount
```

> **The secret sits in the middle, not at the end.** `apiKey|apiSecret|requestTime` hashes cleanly
> and fails every time. (An older version of the tutorials described that order in prose; the worked
> example and the live documentation use `apiKey|requestTime|apiSecret`.)

The subscription with header enrichment lists an `amount` parameter, but it is **not** signed there.
Only the one-time charge signs the amount.

## Known answers

Hash these in your language before you go anywhere near the platform. A different digest means the
bug is in your hashing — encoding, algorithm, hex case — not in Digimart.

| Signing string (Digimart's worked example) | SHA-512, lowercase hex |
|---|---|
| `myApiKey123\|2024-08-08T12:00:00Z\|mySecretKey456` | `f03c8c41e0fec896bc2510e51f46353b8d753512c4892a2c56004bcd2a3aa42ce625c3c92a76fa2b5571b161cff1b1e8a2b5b497e3c89f016561731b69547a8d` |
| `myApiKey123\|2024-08-08T12:00:00Z\|mySecretKey456\|50` | `3badf638ceca499000fd07b899e5fc0cec348d9762886b8430104291126683892845a208caef8e99b53432571e46c5f04162a1a25646443f7935239ea0901b38` |

```bash
node tools/digimart.mjs sign --example subscription
node tools/digimart.mjs sign --example one-time
printf '%s' 'myApiKey123|2024-08-08T12:00:00Z|mySecretKey456' | openssl dgst -sha512
```

Put one of these in your own test suite as a fixed-vector test. It is the cheapest regression test
the integration will ever have.

## The rules that trip people up

| Rule | Why it bites |
|---|---|
| **Hash the exact string you send** | Format `requestTime` once for the hash and again for the URL and a millisecond or a zone suffix will differ. Build it into a variable once and use that variable in both places. The same goes for `amount`: `50` and `50.00` are different strings and different hashes. |
| **Time is the current instant in UTC, with a Z** | `2024-07-08T10:33:54.929Z`. Digimart says to generate it "in the Asia/Dhaka timezone"; every published code sample produces the true UTC instant (`new Date().toISOString()`, `Instant.now()`, `gmdate(...)`, `DateTime.UtcNow`), so do that. Writing Dhaka wall-clock time with a `Z` is six hours wrong. |
| **Keep the clock honest** | A drifting server clock or a URL built minutes before it is used produces `E1004` (Request Timeout). Sync with NTP and build the URL at the moment of redirect — never cache one. (The signatures page attributes clock drift to `E1011`; that code actually means *SDK Is Not Enabled*.) |
| **SHA-512, not SHA-256** | 128 hex characters. An older tutorial's prose said SHA 256; the table and worked example always said SHA-512. |
| **Lowercase hex** | Some languages default to uppercase (Java's `String.format("%02X")`, .NET's `Convert.ToHexString`). Normalise it. |
| **No spaces around the pipes** | String interpolation with padding is easy to do by accident and produces a completely different hash. |
| **Hash raw values, encode the URL afterwards** | You hash `2024-07-08T10:33:54.929Z`, then the query-string encoder turns it into `2024-07-08T10%3A33%3A54.929Z`. Hashing the encoded form never matches. |
| **UTF-8 bytes** | Hash the UTF-8 encoding of the string. |
| **Sign on the server** | A signature built in browser JavaScript or a mobile app means your secret is public and anyone can charge your customers. |

## The shape of a correct implementation

Language-neutral. Every language has SHA-512 and hex encoding in its standard library.

```
requestTime  = now_utc_iso8601_with_millis_and_Z()      # ONE value
requestId    = fresh_15_digit_id()                      # persisted before redirect
amount       = price_list[item]                         # one-time only, server-side, ONE string

fields       = [apiKey, requestTime, apiSecret] (+ [amount] for one-time)
signature    = lowercase_hex( sha512( utf8( join(fields, "|") ) ) )

url          = AUTHORIZE_URL + "?" + urlencode({
                 apiKey, requestId, requestTime, signature, redirectUrl,
                 [msisdn], [amount] })
```

Worked implementations: `templates/*/` — search for `signingString` or `sign` in the client file of
your language.

### Per-language notes

| Language | SHA-512 → lowercase hex | Current instant as `…T…Z` with millis |
|---|---|---|
| Node / TypeScript | `createHash("sha512").update(s, "utf8").digest("hex")` | `new Date().toISOString()` |
| Python | `hashlib.sha512(s.encode("utf-8")).hexdigest()` | `datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")` |
| Java | `MessageDigest.getInstance("SHA-512")` + `HexFormat.of().formatHex(...)` | `Instant.now().truncatedTo(ChronoUnit.MILLIS).toString()` |
| Go | `sha512.Sum512([]byte(s))` + `hex.EncodeToString` | `time.Now().UTC().Format("2006-01-02T15:04:05.000Z")` |
| PHP | `hash('sha512', $s)` | `(new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z')` — Digimart's own sample uses `gmdate('Y-m-d\TH:i:s.v\Z')`, where `v` is always `000` because `gmdate` takes whole seconds; valid, just coarser |
| C# | `SHA512.HashData(Encoding.UTF8.GetBytes(s))` + `Convert.ToHexString(...).ToLowerInvariant()` | `DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)` |
| Ruby | `Digest::SHA512.hexdigest(s)` | `Time.now.utc.strftime("%Y-%m-%dT%H:%M:%S.%LZ")` |
| Rust | `sha2::Sha512::digest` + `hex::encode` | `chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ")` |

Java's `Instant.now().toString()` can print micro- or nanoseconds on some JVMs and drops the
fraction entirely when it is zero; truncate to millis and format explicitly if you want a fixed
shape. Either way, the URL and the hash must carry the same string.

## `requestId`

Exactly **15 digits**, unique for every URL you build. It is not signed, but it is how the redirect
and the notification find their way back to your order, and a used value is rejected with
**`E1005`**.

- Generate it fresh per URL — including on a retry after a failure.
- Persist it against the order or user **before** you redirect.
- Prefer a random 15-digit value with a non-zero first digit, or a database sequence. The
  documentation's quick samples pad the millisecond clock to 15 digits, which collides the moment
  two customers press *Buy* in the same millisecond.
- Keep it a string end to end; a leading zero would not survive a numeric type.

## Debugging a rejected signature

When you get `E1002`, print the exact signing string your code built — not the hash — and read it
character by character, with the secret redacted:

1. Is the order `apiKey`, `requestTime`, `apiSecret`, (`amount`)?
2. Exactly two pipes for a subscription, three for a one-time charge?
3. Any leading or trailing whitespace on a value?
4. Does the `requestTime` in the string match the one in the URL, byte for byte? The `amount`?
5. Is the hash lowercase hex, 128 characters?
6. Does your code reproduce the known answer above?

Then let the tool find it for you. With the secret exported, `check-url` recomputes the signature
from the URL itself and names the common mistakes — amount missing from a one-time hash, amount
signed on a subscription, secret and time swapped:

```bash
export DIGIMART_API_SECRET='…'
node tools/digimart.mjs check-url 'https://user.digimart.store/sdk/subscription/caas-authorize?apiKey=…'
```

It reads the secret from the environment and never prints it; it makes no network call.

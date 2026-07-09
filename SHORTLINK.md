# Short share links (`#d-…`)

Spec for the compressed trip-share URL used by the EUC Planet Trip Viewer
(https://eucviewer.ried.no/). Audience: any team that wants to generate or
parse these links (viewer, EUC Planet app, bots).

## Why

The classic share link wraps a full Dropbox direct URL in a query parameter:

```
https://eucviewer.ried.no/?file=https%3A%2F%2Fdl.dropboxusercontent.com%2Fscl%2Ffi%2Fd08vshn4piz4rew9gd93k%2Ftrip_20260708_163439.csv%3Frlkey%3Dwrsgt7shhka0o3tuafrgo50bn%26dl%3D1
```

Almost all of that is boilerplate: the host and path skeleton are constant,
the filename is a timestamp, and percent-encoding triples every `/` `:` `?`
`=` `&`. Only the Dropbox file id and rlkey are real information. The short
form keeps exactly those plus the timestamp:

```
https://eucviewer.ried.no/#d-d08vshn4piz4rew9gd93k-76jn2ivsf-wrsgt7shhka0o3tuafrgo50bn
```

86 characters instead of ~180, no percent-encoding (survives chat apps
verbatim), and roughly half the QR-code modules.

`?file=` is NOT deprecated. It remains the universal form for any fetchable
URL and every existing link keeps working. The short form is an additive
optimization for the one URL shape the viewer's own share flow produces.

## Link forms the viewer accepts

Checked in this order at page load:

1. `?file=<urlencoded absolute URL>` (universal, unchanged)
2. `#trip=<urlencoded absolute URL>` (legacy, keep supported, do not emit)
3. `#d-<token>` (this spec)

The payload is removed from the address bar once the download succeeds. On
failure it stays, so a refresh retries.

## Token grammar

```
token   = "d-" fileId "-" ts36 "-" rlkey
fileId  = 1*64 ( %x30-39 / %x61-7A )   ; [0-9a-z]
ts36    = 1*9  ( %x30-39 / %x61-7A )   ; base36 of the 14 timestamp digits
rlkey   = 1*64 ( %x30-39 / %x61-7A )
```

The leading `d` is a format tag ("Dropbox template, v1"). Future templates
get new tags; parsers MUST reject unknown tags (fall through to normal
routing, not an error page). All characters are unreserved per RFC 3986, so
the token never needs URL encoding.

`ts36` is unpadded lowercase base36 (alphabet `0-9a-z`) of the number formed
by the 14 filename digits `YYYYMMDDHHMMSS`. This is a digit-string transform,
NOT a date: the filename is wall-clock local time from the exporting phone.
Never convert through epoch time or any timezone, in either direction.

## Encoding (producer side)

Input: the Dropbox direct link. Emit a token ONLY if every rule passes;
otherwise emit the classic `?file=` link. When in doubt, fall back.

1. Parse as a URL. Scheme `https`, host exactly `dl.dropboxusercontent.com`,
   no fragment.
2. Path matches `^/scl/fi/([a-z0-9]{1,64})/trip_(\d{8})_(\d{6})\.csv$`.
   Capture fileId and the 8+6 timestamp digits.
3. Query contains exactly two parameters: `rlkey` matching
   `^[a-z0-9]{1,64}$` and `dl=1`. Any extra parameter (for example the `st=`
   that Dropbox adds to web-UI copies) disqualifies the URL.
4. `ts36 = base36(Number(YYYYMMDD + HHMMSS))`, lowercase, no padding.
   The 14-digit value is at most 10^14, safely inside IEEE-754 integer
   precision (2^53), so plain doubles are exact.
5. Token: `"d-" + fileId + "-" + ts36 + "-" + rlkey`.
6. Final URL: `https://eucviewer.ried.no/#` + token.

## Decoding (consumer side)

1. Strip the leading `#`. Match the token against
   `^d-([a-z0-9]{1,64})-([a-z0-9]{1,9})-([a-z0-9]{1,64})$`.
   No match: not a short link, continue normal hash routing.
2. `n = parseInt(ts36, 36)`. Reject unless `n` is a safe integer.
3. `digits = decimal(n)` left-padded with `0` to 14 characters. Reject if
   longer than 14.
4. Rebuild:
   ```
   https://dl.dropboxusercontent.com/scl/fi/{fileId}/trip_{digits[0..8]}_{digits[8..14]}.csv?rlkey={rlkey}&dl=1
   ```
5. Fetch and load exactly like a `?file=` value.

Rejected tokens that still matched the `d-` prefix show the standard
"Couldn't fetch the shared trip" error, same as a dead `?file=` URL.

## Test vectors

Round trip (must hold in both directions):

```
URL:   https://dl.dropboxusercontent.com/scl/fi/d08vshn4piz4rew9gd93k/trip_20260708_163439.csv?rlkey=wrsgt7shhka0o3tuafrgo50bn&dl=1
token: d-d08vshn4piz4rew9gd93k-76jn2ivsf-wrsgt7shhka0o3tuafrgo50bn
```

(`20260708163439` in base36 is `76jn2ivsf`.)

Must NOT encode (emit `?file=` instead):

```
…?rlkey=X&st=abc123&dl=1        extra query parameter
…/ride_20260708_163439.csv…    filename not trip_*.csv
…/trip_20260708_1634.csv…      timestamp not 8+6 digits
https://www.dropbox.com/…       wrong host (rewrite to dl.… first)
…?rlkey=WRSGT7…&dl=1            uppercase rlkey
```

Must NOT decode (invalid tokens):

```
d-abc-zzzzzzzzz-def             base36 value has 15 digits
d-abc--def                      empty ts36
D-abc-76jn2ivsf-def             uppercase tag
```

## Reference implementation

`static/js/app.js`, functions `encodeShortLink` / `decodeShortLink`, also
exposed for tooling as `window.eucViewerShortLink.encode(url)` and
`window.eucViewerShortLink.decode(token)`. Both return `null` on any
mismatch.

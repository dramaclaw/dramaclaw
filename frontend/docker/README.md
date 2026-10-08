# Payment form destinations

The frontend serves a restrictive Content-Security-Policy. By default,
`form-action` permits only same-origin forms. Hosted Epay/PayBridge checkout uses
a cross-origin form POST and requires an explicit deployment allowlist.

Set this environment variable on the **frontend Nginx container**:

```yaml
CSP_PAYMENT_FORM_ORIGINS: "https://pay.example.test"
```

Replace the example with the public HTTPS origin from the configured checkout
endpoint. Multiple origins are space-separated. Include a non-default port if
used. Do not include paths, trailing slashes, credentials, query strings,
fragments, wildcard hosts, or CSP directives. If the provider redirects the form
to another origin, allow only the exact required destination origins as well.

The startup hook validates the value before Nginx template substitution and
refuses invalid values. An empty/unset value keeps same-origin-only behavior.
The setting changes `form-action` only, not script, connection or frame policy.

Roll out the new frontend image **with the allowlist**, then reload the checkout
page. Verify its response header contains the expected `form-action` origins and
complete a checkout navigation. Existing open tabs retain their previous CSP
until reloaded. This does not change popup behavior or payment webhook handling.

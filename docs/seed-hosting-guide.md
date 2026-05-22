# Seed Hosting Guide

This guide explains how to host a public Wattcoin seed endpoint safely behind a subdomain such as `seed.wattcoin.ee`.

## Short Answer

Yes, you can host a seed endpoint on the same provider that serves `wattcoin.ee`, but the safest setup is:

1. separate subdomain, for example `seed.wattcoin.ee`
2. separate Wattcoin node process
3. reverse proxy on HTTPS `443`
4. peer server bound behind the proxy, ideally not exposed directly to the internet
5. do not mix the marketing site runtime and the seed node runtime in one document root or one application process

## Safe Enough vs Better

Safe enough:

- same hosting provider
- same VM or hosting account
- different subdomain
- reverse proxy sends only `/api/v1/*` to the Wattcoin peer node

Better:

- separate VPS or container for the seed node
- separate subdomain like `seed.wattcoin.ee`
- firewall only allows the proxy to reach the local Wattcoin peer port

Best:

- multiple seeds on independent providers and regions
- for example `seed-eu.wattcoin.ee`, `seed-us.wattcoin.ee`, `seed-ap.wattcoin.ee`

## Recommended Topology

```text
Public Internet
    -> https://seed.wattcoin.ee
    -> reverse proxy (Nginx or Caddy)
    -> http://127.0.0.1:39310
    -> Wattcoin peer node
```

## Required Endpoints

The public subdomain must return valid JSON for:

- `/api/v1/chain/tip`
- `/api/v1/network/peers`

These are the two minimum checks needed before a seed can be shipped.

## Nginx Example

```nginx
server {
    listen 443 ssl http2;
    server_name seed.wattcoin.ee;

    ssl_certificate     /etc/letsencrypt/live/seed.wattcoin.ee/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/seed.wattcoin.ee/privkey.pem;

    location /api/v1/ {
        proxy_pass http://127.0.0.1:39310;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

## Caddy Example

```caddy
seed.wattcoin.ee {
    reverse_proxy 127.0.0.1:39310
}
```

## Wattcoin Node Requirements

The node behind the proxy must run with:

- `ledgerNetworkEnabled: true`
- `ledgerNetworkMode: peer`
- the correct `wtc-mainnet` genesis and protocol

If the seed is public-facing, prefer leaving the node itself on `127.0.0.1:39310` and expose only the reverse proxy on `443`.

## Validation Steps

Run this before shipping the endpoint as a seed:

```powershell
npm run mainnet:verify-seed-endpoint -- https://seed.wattcoin.ee 07165b5d3fb9bc5f9160d3f37611976b2281076e9659fccf4f03342bb7711d43 wtc-mainnet
```

Expected result:

- `PASS`
- `networkId = wtc-mainnet`
- correct `genesisHash`
- non-error response from `/api/v1/network/peers`

## Operational Note

Using the website provider for one seed is acceptable. Using the website provider for all seeds is not. Real mainnet safety comes from provider diversity, not just a working subdomain.
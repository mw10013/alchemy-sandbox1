# Baton

- https://admin.shopify.com/store/mw10013-dev-shop-01/apps/baton-local/app
- https://baton-website-staging-xyv5yq2naedqkzgg.mw10013.workers.dev


## Run locally

Copy `.env.example` to `.env` first; it holds this checkout's port and Shopify dev store.

```sh
vp install
vp run dev        # start or adopt this checkout's dev server
vp run dev:status
vp run dev:logs
vp run dev:stop
vp run db:reset    # wipe and reseed the local auth database, then restart
```
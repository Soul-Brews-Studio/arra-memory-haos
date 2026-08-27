#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
#
# Reads this add-on's Supervisor options and starts the server.
#
# Options are read HERE, at container start, and passed as environment
# variables — never baked into the image at build time. A secret in an image
# layer is a secret in every registry and every backup of that image.

set -eu

OWNER_PASSPHRASE="$(bashio::config 'owner_passphrase')"
API_TOKEN="$(bashio::config 'api_token')"
PUBLIC_URL="$(bashio::config 'public_url')"

# bashio renders an unset optional string as the literal "null", which would
# then be a perfectly valid — and completely wrong — passphrase.
[ "${OWNER_PASSPHRASE}" = "null" ] && OWNER_PASSPHRASE=""
[ "${API_TOKEN}" = "null" ] && API_TOKEN=""
[ "${PUBLIC_URL}" = "null" ] && PUBLIC_URL=""

if [ -z "${OWNER_PASSPHRASE}" ]; then
    bashio::log.fatal "owner_passphrase is not set."
    bashio::log.fatal "Open this add-on's Configuration tab and set one:"
    bashio::log.fatal "    openssl rand -base64 32"
    bashio::log.fatal "Refusing to start — an unset passphrase would serve your"
    bashio::log.fatal "memories to anyone who reaches this add-on."
    exit 1
fi

# /data is the only path Supervisor persists across restarts and includes in
# Home Assistant's backups. The corpus lives there and nowhere else.
export DATABASE_URL="file:/data/arra-memory.db"
export OWNER_PASSPHRASE
export API_TOKEN
export PUBLIC_URL
export PORT=8099
export PUBLIC_DIR=/app/public

bashio::log.info "Arra Memory starting"
bashio::log.info "  database: /data/arra-memory.db"
if bashio::var.has_value "${API_TOKEN}"; then
    bashio::log.info "  auth:     owner session + OAuth + static API token"
else
    bashio::log.info "  auth:     owner session + OAuth  (api_token not set)"
fi
if bashio::var.has_value "${PUBLIC_URL}"; then
    bashio::log.info "  public:   ${PUBLIC_URL}"
fi

# exec so Bun becomes PID 1 of this process tree and receives the signals s6
# sends on stop — without it, a restart waits for the kill timeout every time.
exec bun /app/src/server.ts

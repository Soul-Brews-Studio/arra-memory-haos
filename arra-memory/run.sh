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
OLLAMA_URL="$(bashio::config 'ollama_url')"
EMBEDDING_MODEL="$(bashio::config 'embedding_model')"
EMBEDDING_DIMENSIONS="$(bashio::config 'embedding_dimensions')"
SEARCH_LOG="$(bashio::config 'search_log')"
TURSO_SYNC_URL="$(bashio::config 'turso_sync_url')"
TURSO_AUTH_TOKEN="$(bashio::config 'turso_auth_token')"
TURSO_SYNC_INTERVAL="$(bashio::config 'turso_sync_interval')"

# bashio renders an unset optional string as the literal "null", which would
# then be a perfectly valid — and completely wrong — passphrase.
[ "${OWNER_PASSPHRASE}" = "null" ] && OWNER_PASSPHRASE=""
[ "${API_TOKEN}" = "null" ] && API_TOKEN=""
[ "${PUBLIC_URL}" = "null" ] && PUBLIC_URL=""
[ "${OLLAMA_URL}" = "null" ] && OLLAMA_URL=""
[ "${EMBEDDING_MODEL}" = "null" ] && EMBEDDING_MODEL="bge-m3"
[ "${EMBEDDING_DIMENSIONS}" = "null" ] && EMBEDDING_DIMENSIONS="1024"
[ "${SEARCH_LOG}" = "null" ] && SEARCH_LOG="false"
[ "${TURSO_SYNC_URL}" = "null" ] && TURSO_SYNC_URL=""
[ "${TURSO_AUTH_TOKEN}" = "null" ] && TURSO_AUTH_TOKEN=""
[ "${TURSO_SYNC_INTERVAL}" = "null" ] && TURSO_SYNC_INTERVAL="60"

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
export OLLAMA_URL
export EMBEDDING_MODEL
export EMBEDDING_DIMENSIONS
export SEARCH_LOG
export TURSO_SYNC_URL
export TURSO_AUTH_TOKEN
export TURSO_SYNC_INTERVAL
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
if bashio::var.has_value "${OLLAMA_URL}"; then
    bashio::log.info "  search:   keyword (trigram FTS5) + semantic via ${EMBEDDING_MODEL}"
else
    bashio::log.info "  search:   keyword only (trigram FTS5) — set ollama_url for semantic"
fi

if [ "${SEARCH_LOG}" = "true" ]; then
    bashio::log.info "  log:      recording every search, INCLUDING query text"
fi
if bashio::var.has_value "${TURSO_SYNC_URL}"; then
    bashio::log.info "  replica:  syncing with ${TURSO_SYNC_URL} every ${TURSO_SYNC_INTERVAL}s"
fi

# exec so Bun becomes PID 1 of this process tree and receives the signals s6
# sends on stop — without it, a restart waits for the kill timeout every time.
exec bun /app/src/server.ts

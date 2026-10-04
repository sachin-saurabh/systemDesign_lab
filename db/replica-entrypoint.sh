#!/bin/bash
# Turns a fresh postgres container into a streaming read replica of the primary.
# First start: copy the primary with pg_basebackup (-R writes standby.signal and the
# connection info). Later starts: data already exists, so just boot as a standby.
set -e

export PGDATA="${PGDATA:-/var/lib/postgresql/data}"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "[replica] waiting for primary at $PRIMARY_HOST..."
  until pg_isready -h "$PRIMARY_HOST" -U postgres >/dev/null 2>&1; do sleep 1; done

  echo "[replica] taking base backup"
  mkdir -p "$PGDATA"
  chown -R postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
  PGPASSWORD="$REPLICATION_PASSWORD" gosu postgres pg_basebackup \
    -h "$PRIMARY_HOST" -U replicator -D "$PGDATA" -R -X stream
fi

exec docker-entrypoint.sh postgres -c hot_standby=on -c listen_addresses='*'

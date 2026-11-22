#!/bin/sh
set -e

echo "Waiting for the database..."

until pg_isready -d "$DATABASE_URL"; do
  echo "Database not ready, waiting..."
  sleep 2
done

echo "Database ready! Ensuring pgvector extension..."
node dist/scripts/setup-pgvector.js

echo "Running migrations..."
node dist/db/migrate.js

echo "Setting up log partitions..."
node dist/scripts/setup-log-partitions.js

echo "Encrypting any SSO provider secret stored in the clear..."
node dist/scripts/encrypt-sso-secrets.js --apply

echo "Starting application..."
exec node dist/index.js

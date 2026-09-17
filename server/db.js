/* Postgres persistence for the account store -- replaces the old
   in-memory Map so accounts/plan/usage survive a process restart. Plain
   `pg`, no ORM, matching this codebase's existing minimal-dependency,
   no-framework style. Connection string comes from DATABASE_URL only,
   same "secrets live in env vars, never in the repo" rule as every other
   key in server/index.js. */
"use strict";
const { Pool } = require("pg");

function createPool(connectionString) {
  return new Pool({ connectionString: connectionString || process.env.DATABASE_URL });
}

/* token is TEXT, not UUID: real tokens are crypto.randomUUID() strings
   (still valid UUIDs), but the test suite seeds accounts with
   human-readable fake tokens ("free-token", "pro-token") that a UUID
   column would reject outright. */
async function initSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      token               TEXT PRIMARY KEY,
      email               TEXT UNIQUE NOT NULL,
      password_salt       TEXT NOT NULL,
      password_hash       TEXT NOT NULL,
      plan_id             TEXT NOT NULL DEFAULT 'free',
      plan_expires_at     TIMESTAMPTZ,
      stripe_customer_id  TEXT,
      usage_month         TEXT NOT NULL,
      usage_drafts        INT NOT NULL DEFAULT 0,
      usage_resumes       INT NOT NULL DEFAULT 0,
      usage_cover_letters INT NOT NULL DEFAULT 0,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

/* Maps one `accounts` row into the exact shape server/index.js's
   in-memory account object used to have, so every function that reads
   `account.planId` / `account.usage.drafts` / etc. needs no shape
   changes elsewhere, only a sync->async call-site change. */
function rowToAccount(row) {
  if (!row) return null;
  return {
    token: row.token,
    email: row.email,
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    planId: row.plan_id,
    planExpiresAt: row.plan_expires_at ? new Date(row.plan_expires_at).getTime() : null,
    stripeCustomerId: row.stripe_customer_id || undefined,
    usage: {
      month: row.usage_month,
      drafts: row.usage_drafts,
      resumes: row.usage_resumes,
      coverLetters: row.usage_cover_letters
    }
  };
}

module.exports = { createPool, initSchema, rowToAccount };

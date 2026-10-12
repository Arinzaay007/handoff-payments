// Runs migrations 0001 → 0005 in an in-memory Postgres (PGlite) and proves the database-level payment
// guards, including Handoff-to-Handoff one-time transfer reservation. Migrations are never applied
// to Supabase here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');

const ROOT = path.join(__dirname, '..');
const MIGRATIONS = ['0001_handoff_mainnet_schema.sql', '0002_claim_handoff_profile.sql', '0003_payment_execution_guards.sql', '0004_exact_output_merchant_settlement.sql', '0005_handoff_to_handoff_transfers.sql'];
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const HASH = n => `0x${n.toString(16).padStart(64, '0')}`;
const PAYER = n => `0x${n.toString(16).padStart(40, '0')}`;
const USDC = 1_000_000n;

let db;
let profileId;
let walletId;
let recipientProfileId;
let recipientWalletId;
let seq = 0;

async function q(sql, params = []) {
  return (await db.query(sql, params)).rows;
}

async function expectError(promise, pattern) {
  let caught = null;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught, `expected an error matching ${pattern}`);
  assert.match(caught.message, pattern);
  return caught;
}

function reserve({ payer, amount, destination = amount, routeFee = 0n, daily = '100000000', perPayment = '25000000', expiresInMinutes = 5 }) {
  return q(
    `select * from public.reserve_payment_attempt($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      payer, profileId, walletId, 8453, USDC_BASE, amount.toString(), destination.toString(), routeFee.toString(), destination.toString(),
      `req-${++seq}-${Date.now()}`, new Date(Date.now() + expiresInMinutes * 60_000).toISOString(), perPayment, daily
    ]
  );
}

// Inserts an attempt directly, bypassing the reservation function, to set up receipt states.
async function insertAttempt(fields = {}) {
  const row = {
    payer_address: PAYER(++seq),
    source_chain_id: 8453,
    source_currency: USDC_BASE,
    source_amount: 10n * USDC,
    minimum_destination_amount: 9n * USDC,
    status: 'quote_created',
    quote_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    relay_request_id: `direct-${seq}-${Date.now()}`,
    ...fields
  };
  // 0004 requires a confirmed source debit for post-submission rows. Direct fixtures model the
  // confirmed debit as the immutable quoted source amount unless a test deliberately overrides it.
  if (['source_confirmed', 'routing', 'settled'].includes(row.status) && row.actual_source_amount === undefined) {
    row.actual_source_amount = row.source_amount;
  }
  const keys = Object.keys(row);
  const values = keys.map(key => row[key]);
  const rows = await q(
    `insert into public.payment_attempts (recipient_profile_id, recipient_wallet_id, ${keys.join(',')})
     values ($1, $2, ${keys.map((_, i) => `$${i + 3}`).join(',')}) returning *`,
    [profileId, walletId, ...values.map(value => (typeof value === 'bigint' ? value.toString() : value))]
  );
  return rows[0];
}

test.before(async () => {
  db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  `);
  for (const file of MIGRATIONS) {
    await db.exec(fs.readFileSync(path.join(ROOT, 'supabase/migrations', file), 'utf8'));
  }
  const [profile] = await q(
    `insert into public.profiles (auth_subject, username, username_normalized, display_name)
     values ('subject-1', 'morgan', 'morgan', 'Morgan Ellis') returning id`
  );
  profileId = profile.id;
  const [wallet] = await q(
    `insert into public.recipient_wallets (profile_id, wallet_address) values ($1, $2) returning id`,
    [profileId, '0x7777777777777777777777777777777777777777']
  );
  walletId = wallet.id;
  const [recipient] = await q(
    `insert into public.profiles (auth_subject, username, username_normalized, display_name)
     values ('subject-2', 'ada', 'ada', 'Ada') returning id`
  );
  recipientProfileId = recipient.id;
  const [recipientWallet] = await q(
    `insert into public.recipient_wallets (profile_id, wallet_address) values ($1, $2) returning id`,
    [recipientProfileId, '0x8888888888888888888888888888888888888888']
  );
  recipientWalletId = recipientWallet.id;
});

test.after(async () => {
  await db?.close();
});

test('migrations 0001 → 0005 apply in order and attach the payment guard trigger', async () => {
  const [trigger] = await q(`select tgname from pg_trigger where tgname = 'payment_attempts_guard_update'`);
  assert.equal(trigger?.tgname, 'payment_attempts_guard_update');
  const [fn] = await q(`select proname from pg_proc where proname = 'reserve_payment_attempt'`);
  assert.equal(fn?.proname, 'reserve_payment_attempt');
});

test('Handoff transfer migration creates the guarded one-time authorization lifecycle', async () => {
  const nonce = HASH(9001);
  const now = Math.floor(Date.now() / 1000);
  const [created] = await q(
    `select * from public.reserve_handoff_transfer($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      profileId, walletId, '0x7777777777777777777777777777777777777777',
      recipientProfileId, recipientWalletId, '0x8888888888888888888888888888888888888888',
      String(25n * USDC), nonce, now - 30, now + 300, String(25n * USDC), String(100n * USDC)
    ]
  );
  assert.equal(created.status, 'created');
  assert.equal(String(created.amount), String(25n * USDC));
  await expectError(q(`update public.handoff_transfers set amount = 1 where id = $1`, [created.id]), /terms are immutable/);

  const signature = `0x${'11'.repeat(65)}`;
  const [authorized] = await q(`select * from public.record_handoff_transfer_authorization($1,$2,$3)`, [created.id, profileId, signature]);
  assert.equal(authorized.status, 'authorized');
  const txHash = HASH(9002);
  const [submitted] = await q(`select * from public.record_handoff_transfer_submission($1,$2,$3)`, [created.id, profileId, txHash]);
  assert.equal(submitted.status, 'submitted');
  const [settled] = await q(`select * from public.settle_handoff_transfer($1,$2)`, [created.id, txHash]);
  assert.equal(settled.status, 'settled');
  await expectError(q(`update public.handoff_transfers set status = 'created' where id = $1`, [created.id]), /already final/);
});

test('the 25 USDC per-payment cap is enforced by the reservation function', async () => {
  const [ok] = await reserve({ payer: PAYER(1001), amount: 25n * USDC });
  assert.equal(ok.status, 'quote_created');
  assert.equal(ok.destination_chain_id, 143);
  assert.equal(ok.exact_output, true);
  assert.equal(String(ok.quoted_source_amount), String(25n * USDC));
  await expectError(reserve({ payer: PAYER(1002), amount: 25n * USDC + 1n }), /PER_PAYMENT_CAP_EXCEEDED/);
});

test('the 100 USDC rolling daily cap counts reserved quotes and refuses the one that crosses it', async () => {
  const payer = PAYER(1003);
  for (let i = 0; i < 4; i += 1) await reserve({ payer, amount: 25n * USDC });
  await expectError(reserve({ payer, amount: USDC }), /DAILY_CAP_EXCEEDED/);
});

test('the function ignores caller caps above the launch ceilings', async () => {
  const payer = PAYER(1004);
  for (let i = 0; i < 4; i += 1) await reserve({ payer, amount: 25n * USDC, daily: '1000000000000', perPayment: '1000000000000' });
  await expectError(reserve({ payer, amount: USDC, daily: '1000000000000' }), /DAILY_CAP_EXCEEDED/);
  await expectError(reserve({ payer: PAYER(1005), amount: 26n * USDC, perPayment: '1000000000000' }), /PER_PAYMENT_CAP_EXCEEDED/);
});

test('a submitted source transaction counts toward the daily cap even after its quote expired', async () => {
  const payer = PAYER(1006);
  for (let i = 0; i < 4; i += 1) {
    await insertAttempt({
      payer_address: payer,
      source_amount: 25n * USDC,
      status: 'transaction_submitted',
      source_tx_hash: HASH(2001 + i),
      quote_expires_at: new Date(Date.now() - 60_000).toISOString()
    });
  }
  await expectError(reserve({ payer, amount: USDC }), /DAILY_CAP_EXCEEDED/);
});

test('failed and refunded attempts without a source transaction do not count toward the cap', async () => {
  const payer = PAYER(1007);
  for (let i = 0; i < 4; i += 1) {
    await insertAttempt({ payer_address: payer, source_amount: 25n * USDC, status: 'failed', failure_code: 'RELAY_FAILURE' });
  }
  const [row] = await reserve({ payer, amount: 25n * USDC });
  assert.equal(row.status, 'quote_created');
});

test('expired quotes stop counting toward the rolling cap once they expire', async () => {
  const payer = PAYER(1008);
  for (let i = 0; i < 4; i += 1) {
    await insertAttempt({
      payer_address: payer,
      source_amount: 25n * USDC,
      quote_expires_at: new Date(Date.now() - 60_000).toISOString()
    });
  }
  const [row] = await reserve({ payer, amount: 25n * USDC });
  assert.equal(row.status, 'quote_created');
});

test('the reservation function is not callable by anon or authenticated clients', async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    try {
      await expectError(reserve({ payer: PAYER(1009), amount: USDC }), /permission denied/);
    } finally {
      await db.exec('reset role');
    }
  }
});

test('the guard trigger refuses backward receipt moves', async () => {
  const row = await insertAttempt({ status: 'routing', source_tx_hash: HASH(3001) });
  await expectError(q(`update public.payment_attempts set status = 'awaiting_sender' where id = $1`, [row.id]), /cannot move backwards/);
});

test('the guard trigger freezes the source hash, amount, payer, and route once recorded', async () => {
  const row = await insertAttempt({ source_tx_hash: HASH(3002), status: 'transaction_submitted' });
  await expectError(q(`update public.payment_attempts set source_tx_hash = $2 where id = $1`, [row.id, HASH(3003)]), /Source transaction hash is immutable/);
  await expectError(q(`update public.payment_attempts set source_amount = 1 where id = $1`, [row.id]), /route and quote terms are immutable/);
  await expectError(q(`update public.payment_attempts set payer_address = $2 where id = $1`, [row.id, PAYER(3004)]), /route and quote terms are immutable/);
});

test('final receipts never change again', async () => {
  const row = await insertAttempt({ status: 'failed', failure_code: 'RELAY_FAILURE' });
  await expectError(q(`update public.payment_attempts set status = 'routing' where id = $1`, [row.id]), /already final/);
});

test('settled requires a Monad destination hash, a settlement time, and an amount at or above the minimum', async () => {
  const base = await insertAttempt({ status: 'routing', source_tx_hash: HASH(4001), minimum_destination_amount: 9n * USDC });
  await expectError(
    q(`update public.payment_attempts set status = 'settled' where id = $1`, [base.id]),
    /payment_attempts_settled_requires_monad_receipt/
  );
  await expectError(
    q(`update public.payment_attempts set status = 'settled', destination_tx_hash = $2, settled_at = now(), final_destination_amount = $3 where id = $1`,
      [base.id, HASH(4002), (9n * USDC - 1n).toString()]),
    /payment_attempts_settled_requires_monad_receipt/
  );
  const [settled] = await q(
    `update public.payment_attempts set status = 'settled', destination_tx_hash = $2, settled_at = now(), final_destination_amount = $3 where id = $1 returning status`,
    [base.id, HASH(4003), (9n * USDC).toString()]
  );
  assert.equal(settled.status, 'settled');
});

test('an exact-output receipt must preserve terms and settle to exactly the requested Monad-USDC amount', async () => {
  const [quoted] = await reserve({ payer: PAYER(4010), amount: 10n * USDC, destination: 9n * USDC, routeFee: 1n * USDC });
  assert.equal(String(quoted.requested_destination_amount), String(9n * USDC));
  assert.equal(String(quoted.quoted_source_amount), String(10n * USDC));
  assert.equal(String(quoted.quoted_route_fee_amount), String(1n * USDC));
  await expectError(q(`update public.payment_attempts set requested_destination_amount = 1 where id = $1`, [quoted.id]), /route and quote terms are immutable/);

  const row = await insertAttempt({
    payer_address: PAYER(4011),
    source_amount: 10n * USDC,
    quoted_source_amount: 10n * USDC,
    actual_source_amount: 10n * USDC,
    quoted_route_fee_amount: 1n * USDC,
    requested_destination_amount: 9n * USDC,
    minimum_destination_amount: 9n * USDC,
    exact_output: true,
    true_exact_output: true,
    source_tx_hash: HASH(4011),
    status: 'routing'
  });
  await expectError(
    q(`update public.payment_attempts set status = 'settled', destination_tx_hash = $2, settled_at = now(), final_destination_amount = $3 where id = $1`, [row.id, HASH(4012), (9n * USDC - 1n).toString()]),
    /payment_attempts_exact_output_settlement/
  );
  await expectError(
    q(`update public.payment_attempts set status = 'settled', destination_tx_hash = $2, settled_at = now(), final_destination_amount = $3 where id = $1`, [row.id, HASH(4013), (9n * USDC + 1n).toString()]),
    /payment_attempts_exact_output_settlement/
  );
});

test('a source transaction is required before any post-submission state', async () => {
  await expectError(insertAttempt({ status: 'transaction_submitted' }), /payment_attempts_submitted_requires_source_hash/);
  await expectError(insertAttempt({ status: 'routing' }), /payment_attempts_post_submission_requires_source_hash/);
});

test('integrity constraints refuse malformed payer, chain, currency, hash, and cap values', async () => {
  await expectError(insertAttempt({ payer_address: '0xABCDEF0000000000000000000000000000000000' }), /payment_attempts_payer_address_shape/);
  await expectError(insertAttempt({ source_chain_id: 999 }), /payment_attempts_source_chain_launch/);
  await expectError(insertAttempt({ source_chain_id: 792703809 }), /payment_attempts_source_chain_launch/);
  await expectError(insertAttempt({ source_currency: 'USDC' }), /payment_attempts_source_currency_shape/);
  await expectError(insertAttempt({ source_amount: 25n * USDC + 1n }), /payment_attempts_per_payment_cap/);
  await expectError(insertAttempt({ status: 'transaction_submitted', source_tx_hash: '0x1234' }), /payment_attempts_source_tx_hash_shape/);
});

test('one source transaction hash belongs to exactly one attempt, regardless of letter case', async () => {
  const hash = `0x${'ab'.repeat(32)}`;
  await insertAttempt({ status: 'transaction_submitted', source_tx_hash: hash });
  await expectError(
    insertAttempt({ status: 'transaction_submitted', source_tx_hash: hash.toUpperCase().replace('0X', '0x') }),
    /duplicate key value violates unique constraint/
  );
});

test('the launch chain allowlist matches the eight executable EVM networks', async () => {
  const [constraint] = await q(
    `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'payment_attempts_source_chain_launch'`
  );
  for (const chainId of [1, 8453, 42161, 10, 137, 56, 43114, 42220]) {
    assert.match(constraint.def, new RegExp(`\\b${chainId}\\b`));
  }
});

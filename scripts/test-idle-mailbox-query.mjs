import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// This database is a disposable CI service, never a Neon URL or a production login.
function sql(input) {
  const result = spawnSync("psql", ["--no-psqlrc", "--quiet", "--tuples-only", "--csv", "--set", "ON_ERROR_STOP=1"], {
    input, encoding: "utf8",
    env: { ...process.env, PGHOST: "127.0.0.1", PGPORT: "5432", PGDATABASE: "neon_idle_fixture", PGUSER: "postgres", PGPASSWORD: "fixture" },
  });
  if (result.status !== 0) throw new Error(result.stderr || "Fixture PostgreSQL command failed");
  return result.stdout.trim().split("\n").filter(Boolean);
}
const source = readFileSync("netlify/functions/sync-mailboxes.mts", "utf8");
const match = source.match(/return sqlOne<ClaimedMailbox>\(\x60([\s\S]*?)\x60, \[interactive, \[\.\.\.visited\]\]\);/);
assert.ok(match, "Must exercise the current claimMailbox SQL");
const claim = (interactive, visited = []) => {
  const array = visited.map(value => "'" + value.replaceAll("'", "''") + "'").join(",");
  const query = match[1].replaceAll("clock_timestamp()", "app.fixture_clock()")
    .replaceAll("$1", interactive ? "true" : "false").replaceAll("$2", "ARRAY[" + array + "]::text[]");
  return sql(query + ";");
};
const a = "00000000-0000-4000-8000-000000000001";
const b = "00000000-0000-4000-8000-000000000002";
sql(`
  create schema app;
  create function app.fixture_clock() returns timestamptz language sql immutable
    as $$ select '2026-11-19T08:10:00Z'::timestamptz $$;
  create table app.gmail_accounts (
    id uuid primary key, email text, credential_id uuid, role text, status text,
    deleted_at timestamptz, last_sync_at timestamptz, created_at timestamptz default app.fixture_clock()
  );
  create table app.email_messages (sender_account_id uuid, smtp_accepted_at timestamptz, technical_confirmation boolean);
  create table app.imap_cursors (
    account_id uuid references app.gmail_accounts(id), mailbox_name text,
    uidvalidity bigint, last_uid bigint, last_attempt_at timestamptz,
    last_success_at timestamptz, caught_up_at timestamptz, version integer default 1,
    primary key(account_id, mailbox_name)
  );
  insert into app.gmail_accounts(id,email,credential_id,role,status,created_at)
    values ('${a}','one@example.invalid','${a}','sender','active',app.fixture_clock()-interval '2 days'),
           ('${b}','two@example.invalid','${b}','sender','active',app.fixture_clock()-interval '1 day');
`);
let rows = claim(false);
assert.equal(rows.length, 1);
assert.ok(rows[0].startsWith(a + ","));
assert.equal(rows[0].split(",")[3], "INBOX");
rows = claim(false, [a + ":INBOX"]);
assert.equal(rows.length, 1);
assert.ok(rows[0].startsWith(b + ","), "An empty first inbox must not hide another account");

sql(`
  delete from app.imap_cursors;
  insert into app.imap_cursors(account_id,mailbox_name,last_uid,last_attempt_at,last_success_at,caught_up_at)
    select a.id,box.name,1,app.fixture_clock()-interval '3 minutes',
      app.fixture_clock()-interval '3 minutes',app.fixture_clock()-interval '3 minutes'
    from app.gmail_accounts a cross join
      (values('INBOX'),('__SENT__'),('__LIVE_ALL__'),('__LIVE_SENT__'),('__UNIFIED_ALL__')) box(name);
`);
assert.deepEqual(claim(false), [], "A caught-up cursor from this quarter must stay idle");
assert.equal(claim(true).length, 1, "Interactive use retains the two-minute refresh eligibility");

sql(`
  update app.imap_cursors set last_success_at=app.fixture_clock()-interval '1 minute',
    last_attempt_at=app.fixture_clock()-interval '3 minutes',caught_up_at=app.fixture_clock();
  update app.imap_cursors set caught_up_at=null where account_id='${b}' and mailbox_name='INBOX';
`);
rows = claim(false);
assert.equal(rows.length, 1);
assert.ok(rows[0].startsWith(b + ","), "An incomplete cursor must continue within the same quarter");
assert.deepEqual(claim(false), [], "A just-claimed cursor retains its cooldown");
console.log("PostgreSQL 17 mailbox claims: multiple accounts, idle suppression, interactive refresh, history catch-up and cooldown passed");

const dispatchSource = readFileSync("netlify/functions/dispatch-outbox.mts", "utf8");
const dispatchMatch = dispatchSource.match(/async function dispatchHint[\s\S]*?sqlOne<[^>]+>\(\x60([\s\S]*?)\x60\)/);
assert.ok(dispatchMatch, "Must exercise the current dispatch hint SQL");
const hint = () => sql(dispatchMatch[1].replaceAll("clock_timestamp()", "app.fixture_clock()") + ";")[0].split(",");
sql("create table app.outbox_jobs(status text, due_at timestamptz, lease_expires_at timestamptz);");
assert.deepEqual(hint(), ["f", ""]);
sql("insert into app.outbox_jobs values ('scheduled','2026-11-19T08:12:00Z',null);");
assert.equal(hint()[0], "f");
assert.equal(new Date(hint()[1]).toISOString(), "2026-11-19T08:12:00.000Z");
sql("insert into app.outbox_jobs values ('running','2026-11-19T08:00:00Z','2026-11-19T08:15:00Z');");
assert.equal(hint()[0], "f", "A current SMTP lease is not a retry opportunity");
sql("update app.outbox_jobs set lease_expires_at='2026-11-19T08:09:00Z' where status='running';");
assert.equal(hint()[0], "t", "Expired leases must reach the existing guarded recovery");
sql("update app.outbox_jobs set status='uncertain' where status='running';");
assert.equal(hint()[0], "f", "An uncertain SMTP result is never made retryable by this hint");
sql("insert into app.outbox_jobs values ('pending','2026-11-19T08:05:00Z',null);");
assert.equal(hint()[0], "t");
console.log("PostgreSQL 17 dispatch hints: empty queue, future due date, current/expired leases and uncertain results passed");

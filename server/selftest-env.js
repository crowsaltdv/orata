// Every self-test imports this FIRST. It tells server/env.js not to read .env, so a test (and every server or tool it starts) sees only what the test itself sets: never
// your real DATABASE_URL, R2 bucket, SMTP login or bot token. Without it a test server would use the real R2 bucket and its sweep of unused theme files would delete real files.
process.env.ORATE_SELFTEST = '1';

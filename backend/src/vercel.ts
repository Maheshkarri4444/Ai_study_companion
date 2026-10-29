import { attachDatabasePool, getDeadline, waitUntil } from '@vercel/functions';
import express from 'express';
import mongoose from 'mongoose';
import { createApp } from './app';
import { config } from './config/env';
import { enqueueJob, jobSignals } from './jobs/queue';
import { runDueJobs } from './jobs/worker';
import { connectDatabase } from './lib/db';
import { logger } from './lib/logger';
import { ensureAdminUser } from './modules/auth/auth.service';
import { ensureVectorIndex } from './modules/knowledge/vector-index';

/**
 * The API as one Vercel function (the backend's `app.js` serves this file's bundle, built by
 * `npm run build`). Nothing runs between requests there, so instead of src/index.ts's long-running process:
 *   - the database connects on the first request and is reused while the instance lives; the admin
 *     account and the vector index are checked once per instance;
 *   - a queued job starts as soon as it is enqueued and may finish after the response (waitUntil);
 *   - UptimeRobot calls GET /api/cron/tick?key=<CRON_KEY> every 5 minutes: the maintenance the worker
 *     schedules every minute (`system.reconcile`), then any job still due (retries, recovered leases).
 */

/** New jobs are claimed until this long before the invocation's deadline (the last one may still run then). */
const JOB_HEADROOM_MS = 120_000;
/** Vercel's limit, when an invocation reports no deadline (e.g. running locally). */
const DEFAULT_DURATION_MS = 300_000;

let starting: Promise<void> | undefined;

/** Once per instance: a small connection pool, the admin account, the vector index (not awaited). */
function ready(): Promise<void> {
  starting ??= (async () => {
    await connectDatabase(config.MONGODB_URI, config.MONGODB_DB_NAME, 2, 5);
    try {
      // lets Vercel release idle connections before it suspends the instance
      attachDatabasePool(mongoose.connection.getClient());
    } catch (err) {
      logger.warn({ err }, 'attachDatabasePool failed');
    }
    await ensureAdminUser();
    void ensureVectorIndex();
  })().catch((err) => {
    starting = undefined; // the next request tries again
    throw err;
  });
  return starting;
}

let jobRun: Promise<void> | null = null;
let queuedMeanwhile = false;

/** Runs due jobs in the background of this invocation; one run per instance, repeated if more were queued. */
function runJobs() {
  if (jobRun) {
    queuedMeanwhile = true;
    return;
  }
  const deadline = getDeadline()?.getTime() ?? Date.now() + DEFAULT_DURATION_MS;
  if (deadline - Date.now() <= JOB_HEADROOM_MS) return; // too late in this invocation: the next one picks it up
  jobRun = (async () => {
    do {
      queuedMeanwhile = false;
      const budgetMs = deadline - Date.now() - JOB_HEADROOM_MS;
      if (budgetMs <= 0) break;
      await runDueJobs({ budgetMs }).catch((err) => logger.error({ err }, 'Job run failed'));
    } while (queuedMeanwhile);
  })().finally(() => {
    jobRun = null;
  });
  waitUntil(jobRun);
}

// An upload's processing, a tutor answer's follow-ups, … start as soon as the request enqueues them.
jobSignals.on('enqueued', runJobs);

const app = express();
app.disable('x-powered-by');

// Liveness needs no database; every other route waits until this instance is connected.
app.use(async (req, res, next) => {
  if (req.path === '/' || req.path === '/api/health') return next();
  try {
    await ready();
  } catch (err) {
    logger.error({ err }, 'Startup failed');
    res.status(503).json({
      error: { code: 'STARTING', message: 'The service is starting. Please try again in a moment.', details: null, requestId: null },
    });
    return;
  }
  next();
});

/**
 * UptimeRobot, every 5 minutes. `ok` is false only when something failed, so a keyword monitor
 * on "ok":true alerts on real trouble.
 */
app.get('/api/cron/tick', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!config.CRON_KEY) {
    res.status(503).json({ ok: false, error: 'CRON_KEY is not set' });
    return;
  }
  if (req.query.key !== config.CRON_KEY) {
    res.status(401).json({ ok: false, error: 'wrong or missing key' });
    return;
  }
  // The worker's per-minute maintenance (deduplicated by the minute, as there)...
  const minute = new Date().toISOString().slice(0, 16);
  await enqueueJob({ type: 'system.reconcile', idempotencyKey: `system.reconcile:${minute}`, maxAttempts: 1, priority: 5 });
  // ...and every other due job, even when this minute's reconcile was already queued.
  runJobs();
  res.json({ ok: true });
});

app.use(createApp());

export default app;

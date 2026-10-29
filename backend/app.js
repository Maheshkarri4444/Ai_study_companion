// Vercel's entry: its Express preset looks for an `app.js` first. It serves the API from the bundle
// `npm run build` makes (dist/vercel.js, see src/vercel.ts), so Vercel never compiles src/ file by file
// (the sources import without extensions, which only a bundler resolves). Locally: `npm run dev`.
import 'express';

let app;
try {
  app = (await import('./dist/vercel.js')).default;
} catch (err) {
  // A start-up failure (most often an environment variable) answers every request with its reason
  // instead of Vercel's bare FUNCTION_INVOCATION_FAILED. Variable names only: values never appear in it.
  console.error('API failed to start:', err);
  const message = String(err?.message ?? err);
  app = (_req, res) => {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { code: 'STARTUP_FAILED', message, details: null, requestId: null } }));
  };
}

export default app;

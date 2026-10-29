// Vercel's entry: its Express preset looks for an `app.js` first. It serves the API from the bundle
// `npm run build` makes (dist/vercel.js, see src/vercel.ts), so Vercel never compiles src/ file by file
// (the sources import without extensions, which only a bundler resolves). Locally: `npm run dev`.
import 'express';
export { default } from './dist/vercel.js';

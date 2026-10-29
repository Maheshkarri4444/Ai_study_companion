import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    // the Vercel function (served by ../app.js)
    vercel: 'src/vercel.ts',
    'seed-admin': 'src/scripts/seed-admin.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
});

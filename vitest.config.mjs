import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    include: [
      'tests/**/*.test.js',
      'tests/**/*.test.jsx',
      'tests/**/*.integration.test.js',
      'tests/**/*.runtime.test.js',
    ],
    exclude: ['node_modules', 'dist', 'releases'],
    passWithNoTests: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    environment: 'node',
    environmentMatchGlobs: [['tests/**/*.test.jsx', 'happy-dom']],
    setupFiles: ['tests/setup.js'],
    coverage: {
      provider: 'v8',
      include: [
        'wtc-consensus.js',
        'wtc-address.js',
        'wtc-accounts.js',
        'wtc-chain.js',
        'wtc-mempool.js',
        'wtc-staking-queue.js',
        'wtc-nfts.js',
        'wtc-sale-queue.js',
        'probe-attestation.js',
        'runtime-config.js',
        'peer-privacy.js',
        'peer-self-filter.js',
        'local-subnet-discovery.js',
        'peer-count-observability.js',
        'peer-discovery-observability.js',
        'remote-seed-manifest.js',
        'requester-registration.js',
        'ops-health.js',
      ],
      exclude: ['tests/**', 'scripts/**', 'node_modules/**'],
      reportsDirectory: './coverage',
    },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js', 'tests/**/*.integration.test.js', 'tests/**/*.runtime.test.js'],
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

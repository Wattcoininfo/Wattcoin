module.exports = {
  env: {
    browser: true,
    node: true,
    es2022: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  settings: {
    react: { version: 'detect' },
  },
  rules: {
    // Allow console in production (the project uses it extensively for logging)
    'no-console': 'off',

    // Warn on empty catch blocks — we want visibility
    'no-empty': ['warn', { allowEmptyCatch: false }],

    // Warn on unused variables (except those prefixed with _)
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

    // Warn on constant conditions (e.g. if (true))
    'no-constant-condition': 'warn',

    // Warn on unreachable code after return/throw
    'no-unreachable': 'warn',

    // Warn on async functions without await
    'require-await': 'warn',

    // Warn on return/throw in finally
    'no-unsafe-finally': 'warn',

    // Warn on useless catch clauses that just rethrow
    'no-useless-catch': 'warn',

    // Warn on promise rejections not handled with .catch()
    'no-unsafe-optional-chaining': 'warn',

    // React: allow JSX in .jsx files
    'react/jsx-uses-react': 'off',
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'warn',
    'react/no-unescaped-entities': 'warn',
    'react/jsx-no-comment-textnodes': 'warn',
    'no-inner-declarations': 'warn',

    // React hooks
    'react-hooks/exhaustive-deps': 'warn',
    'react-hooks/rules-of-hooks': 'error',

    // Require === and !== (no == or !=)
    eqeqeq: ['error', 'always', { null: 'ignore' }],

    // No debugger in production
    'no-debugger': 'error',
  },
  overrides: [
    {
      files: ['tests/**/*.js'],
      env: { mocha: false },
      rules: {
        'no-console': 'off',
        'no-empty': 'off',
      },
    },
    {
      files: ['scripts/**/*.js'],
      rules: {
        'no-process-exit': 'off',
        'no-console': 'off',
      },
    },
  ],
};

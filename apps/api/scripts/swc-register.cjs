// Fast TypeScript execution with decorator metadata (needed by NestJS DI).
process.env.SWC_NODE_PROJECT ??= require('node:path').join(__dirname, '..', 'tsconfig.json');
require('@swc-node/register');

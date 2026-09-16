import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Response } from 'express';
import helmet from 'helmet';
import { ERROR_CODES } from '@resortos/shared';
import { AppModule } from './app.module';
import { AppErrorFilter } from './common/error.filter';
import type { AppRequest } from './common/request-context';
import { requestIdMiddleware } from './common/request-id.middleware';
import { loadConfig } from './config';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function createApp(): Promise<INestApplication> {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: config.NODE_ENV === 'test' ? ['error'] : ['log', 'warn', 'error'],
  });
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
  app.use(requestIdMiddleware);
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '1mb' });
  app.enableCors({ origin: config.WEB_ORIGIN, credentials: true, allowedHeaders: ['content-type', 'idempotency-key', 'x-request-id', 'x-resortos'] });

  // CSRF defence (spec §57): unsafe methods must carry a custom header, which a
  // cross-site form or image cannot send without a CORS preflight we reject.
  app.use((req: AppRequest, res: Response, next: NextFunction) => {
    if (!SAFE_METHODS.has(req.method) && req.header('x-resortos') !== '1') {
      res.status(403).json({ code: ERROR_CODES.FORBIDDEN, message: 'Request blocked for security reasons. Please reload the page.', requestId: req.requestId });
      return;
    }
    next();
  });

  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new AppErrorFilter());
  app.enableShutdownHooks();
  return app;
}

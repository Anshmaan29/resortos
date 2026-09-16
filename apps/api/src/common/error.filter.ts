import { ArgumentsHost, Catch, HttpException, Logger, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ERROR_CODES, type ApiError } from '@resortos/shared';
import { AppError, fromPgError } from './errors';
import type { AppRequest } from './request-context';

/** Staff never see technical errors — only a plain message and a short code for support (spec §72). */
@Catch()
export class AppErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<AppRequest>();
    const requestId = req.requestId;

    let error: AppError | null = exception instanceof AppError ? exception : fromPgError(exception);

    if (!error && exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = status === 404 ? ERROR_CODES.NOT_FOUND : status === 401 ? ERROR_CODES.UNAUTHENTICATED : status === 403 ? ERROR_CODES.FORBIDDEN : status === 429 ? ERROR_CODES.RATE_LIMITED : ERROR_CODES.VALIDATION;
      error = new AppError(code, status === 404 ? 'This page or action does not exist.' : 'The request could not be processed.');
    }

    if (!error) {
      // Log without request bodies — they may contain personal data (spec §57).
      const e = exception as Error;
      this.logger.error(JSON.stringify({ requestId, path: req.path, method: req.method, name: e?.name, message: e?.message, stack: e?.stack }));
      error = new AppError(ERROR_CODES.INTERNAL, 'Something went wrong on our side. Nothing was saved. Please try again.');
    } else if (error.status >= 500) {
      this.logger.error(JSON.stringify({ requestId, path: req.path, code: error.code }));
    }

    const body: ApiError = { code: error.code, message: error.message, requestId };
    if (error.details !== undefined) body.details = error.details;
    res.status(error.status).json(body);
  }
}

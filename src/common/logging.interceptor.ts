import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    const requestId =
      (req.headers['x-request-id'] as string) || randomUUID();
    res.setHeader('X-Request-ID', requestId);

    const { method, originalUrl } = req;
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = Date.now() - start;
          this.logger.log(
            `${method} ${originalUrl} ${res.statusCode} ${duration}ms [${requestId}]`,
          );
        },
        error: (err) => {
          const duration = Date.now() - start;
          const status = err.status || 500;
          this.logger.warn(
            `${method} ${originalUrl} ${status} ${duration}ms [${requestId}]`,
          );
        },
      }),
    );
  }
}

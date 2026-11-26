import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { HttpException, ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

@Catch()
class ErrorFilter implements ExceptionFilter {
  catch(e: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (e instanceof HttpException) {
      const r: any = e.getResponse();
      return res.status(e.getStatus()).json(typeof r === 'string' ? { code: 'error', message: r } : { code: r.code ?? 'error', message: Array.isArray(r.message) ? r.message.join('; ') : r.message ?? 'Hata' });
    }
    console.error(e);
    res.status(500).json({ code: 'internal', message: 'Beklenmeyen bir hata oluştu.' });
  }
}

export async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: process.env.NODE_ENV === 'test' ? false : ['error', 'warn', 'log'] });
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
  app.use(cookieParser());
  app.use((_req: any, res: any, next: any) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store' }); next(); });
  app.useGlobalFilters(new ErrorFilter());
  return app;
}

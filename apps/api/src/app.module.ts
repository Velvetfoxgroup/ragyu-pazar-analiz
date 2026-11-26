import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { getPool } from '@ragyu/core';
import { DB, AuthGuard, QueueService } from './infra';
import { AuthController } from './auth.controller';
import { UsersController } from './users.controller';
import { CatalogController } from './catalog.controller';
import { CompetitorsController } from './competitors.controller';
import { ReportsController } from './reports.controller';
import { MiscController } from './misc.controller';

@Module({
  controllers: [AuthController, UsersController, CatalogController, CompetitorsController, ReportsController, MiscController],
  providers: [{ provide: DB, useFactory: () => getPool() }, QueueService, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}

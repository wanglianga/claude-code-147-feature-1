import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ALL_ENTITIES } from './entities';
import { JwtAuthGuard, RolesGuard } from './common/auth';
import { AuthModule } from './modules/auth';
import { CatalogModule } from './modules/catalog';
import { BookingsModule } from './modules/bookings';
import { OpsModule } from './modules/ops';
import { GuestModule } from './modules/guest';
import { FinanceModule } from './modules/finance';
import { AnalyticsModule } from './modules/analytics';
import { OversellModule } from './modules/oversell';
import { SeedModule } from './seed';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL || 'postgres://homestay:homestay123@localhost:5432/homestay',
      entities: ALL_ENTITIES,
      synchronize: true,
    }),
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET || 'homestay-dev-secret',
      signOptions: { expiresIn: '12h' },
    }),
    AuthModule, CatalogModule, BookingsModule, OpsModule, GuestModule,
    FinanceModule, AnalyticsModule, OversellModule, SeedModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}

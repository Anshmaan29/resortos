import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController, OwnerAuthorisationsController, UsersController } from './auth.controller';
import { AuthService } from './auth.service';
import { OwnerAuthorisationService } from './owner-authorisation.service';
import { SessionGuard } from './session.guard';

@Global()
@Module({
  controllers: [AuthController, OwnerAuthorisationsController, UsersController],
  providers: [AuthService, OwnerAuthorisationService, { provide: APP_GUARD, useClass: SessionGuard }],
  exports: [AuthService, OwnerAuthorisationService],
})
export class AuthModule {}

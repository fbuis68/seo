import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AccessService } from './core/access';
import { AuthGuard } from './core/auth.guard';
import { Db } from './core/db';
import { AppExceptionFilter } from './core/errors';
import { LiveEvents, Mailer, Notifier } from './core/services';
import { IdentityController, IdentityService } from './modules/identity';
import { CatalogController, JoinController, MatchesController, MeController, PublicController, TournamentsController } from './modules/tournament/controllers';
import { GenerationService } from './modules/tournament/generation';
import { MatchesService } from './modules/tournament/matches';
import { ParticipantsService } from './modules/tournament/participants';
import { ResultsService } from './modules/tournament/results';
import { TournamentsService } from './modules/tournament/tournaments';

@Module({
  controllers: [IdentityController, CatalogController, TournamentsController, MatchesController, MeController, JoinController, PublicController],
  providers: [
    Db, AccessService, LiveEvents, Mailer, Notifier, IdentityService,
    GenerationService, ResultsService, ParticipantsService, TournamentsService, MatchesService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
  ],
})
export class AppModule {}

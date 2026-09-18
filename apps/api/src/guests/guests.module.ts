import { Module } from '@nestjs/common';
import { GuestsController, SearchController } from './guests.controller';
import { GuestsService } from './guests.service';
import { SearchService } from './search.service';

@Module({ controllers: [GuestsController, SearchController], providers: [GuestsService, SearchService], exports: [GuestsService, SearchService] })
export class GuestsModule {}

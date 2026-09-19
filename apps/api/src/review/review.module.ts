import { Module } from '@nestjs/common';
import { PropertyModule } from '../property/property.module';
import { ReviewController } from './review.controller';
import { ReviewService } from './review.service';

@Module({ imports: [PropertyModule], controllers: [ReviewController], providers: [ReviewService] })
export class ReviewModule {}

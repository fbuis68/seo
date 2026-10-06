import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { Db } from './db';
import { JobsService } from './jobs.service';
import { StorageService } from './storage';
import { SystemMailer } from './system-mail';

@Global()
@Module({ providers: [Db, AuditService, JobsService, SystemMailer, StorageService], exports: [Db, AuditService, JobsService, SystemMailer, StorageService] })
export class CoreModule {}

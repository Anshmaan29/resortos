import { Client } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate-lib';
import { provisionFirstOwner } from '../scripts/provision-lib';
import { verifySecret } from '../src/auth/password';
import { assertProductionSafe } from '../src/safety/production-guard';
import { APP_URL, MIGRATOR_URL } from './helpers';

const dbName = 'resortos_provision_test';
const url = MIGRATOR_URL.replace(/\/[^/]+$/, `/${dbName}`);
const config = {
  property: { name:'Provision Test Property', legalName:'Provision Test Property', addressLine1:'Test Road', city:'Jaipur', stateCode:'08', pinCode:'302001', phone:'9876543210', checkInTime:'12:00',checkOutTime:'11:00' },
  businessDate:'2026-10-06', owner:{fullName:'Provision Test Owner',username:'provision.owner',email:'owner@example.com'},
};
const password='Example#Only26';
const pin='729461';
beforeAll(async () => {
  const server = new Client({connectionString:MIGRATOR_URL});
  await server.connect();
  try { await server.query(`DROP DATABASE IF EXISTS resortos_provision_test WITH (FORCE)`); await server.query(`CREATE DATABASE resortos_provision_test`); }
  finally { await server.end(); }
  await migrate(url,()=>undefined);
},120_000);

describe('first owner provisioning', () => {
  it('serializes concurrent provisioning, creates a live non-demo owner, and supports normal login', async () => {
    const results=await Promise.allSettled([provisionFirstOwner(url,config,password,pin),provisionFirstOwner(url,config,password,pin)]);
    expect(results.filter((r)=>r.status==='fulfilled')).toHaveLength(1);
    const c=new Client({connectionString:url}); await c.connect();
    try {
      await assertProductionSafe(c);
      const owner=(await c.query<{password_hash:string;owner_pin_hash:string;is_demo:boolean}>('SELECT password_hash,owner_pin_hash,is_demo FROM users')).rows[0]!;
      expect(owner.is_demo).toBe(false);
      expect(await verifySecret(owner.password_hash,password)).toBe(true);
      expect(await verifySecret(owner.owner_pin_hash,pin)).toBe(true);
      expect((await c.query('SELECT action FROM audit_logs')).rows.map((r)=>r.action)).toContain('property.provisioned');
      for(const table of ['rooms','tax_rules','guests','reservations']) expect(Number((await c.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n)).toBe(0);
    } finally { await c.end(); }
    const before={...process.env};
    let app;
    try {
      Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:APP_URL.replace(/\/[^/]+$/,`/${dbName}`),SESSION_COOKIE_SECURE:'false',WEB_ORIGIN:'http://localhost:3000',S3_BUCKET:'resortos-documents-test',S3_ENDPOINT:process.env.TEST_S3_ENDPOINT??'http://localhost:9000',S3_ACCESS_KEY_ID:'resortos',S3_SECRET_ACCESS_KEY:'resortos-dev-minio-secret',S3_FORCE_PATH_STYLE:'true'});
      app=await (await import('../src/bootstrap')).createApp(); await app.init();
      const agent=request.agent(app.getHttpServer());
      await agent.post('/api/v1/auth/login').set('x-resortos','1').send({login:config.owner.username,password}).expect(200);
      const property=await agent.get('/api/v1/property').expect(200);
      expect(property.body.name).toBe(config.property.name);
      expect(property.body.isPractice).toBe(false);
    } finally {
      if(app) await app.close();
      for(const name of Object.keys(process.env)) if(!(name in before)) delete process.env[name];
      Object.assign(process.env,before);
    }
  });
  it('refuses a common password and predictable PIN before provisioning', async()=>{
    await expect(provisionFirstOwner(url,config,'password123','729461')).rejects.toThrow(/too common/);
    await expect(provisionFirstOwner(url,config,password,'123456')).rejects.toThrow(/sequence/);
  });
});

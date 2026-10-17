import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { APP_CONFIG, type AppConfig } from '../src/config';
import { MESSAGE_PROVIDERS, type MessageProvider } from '../src/messaging/providers';
import { MessagingService } from '../src/messaging/messaging.service';
import { GuestMessagesHandler } from '../src/messaging/guest-messages.handler';
import type { OutboxEvent } from '../src/jobs/outbox-handlers';
import { WhatsAppService } from '../src/messaging/whatsapp.service';
import { WhatsAppProvider, defaultBindings, whatsappWording } from '../src/messaging/whatsapp';
import { DbService } from '../src/db/db.service';
import { addVilla } from '../scripts/add-villa-lib';
import { bootAppOnOwnDatabase, booking, fixtures, login, post, type Agent } from './helpers';
import { TEST_BUSINESS_DATE } from './global-setup';

let app: INestApplication, owner: Agent, desk: Agent, messaging: MessagingService, whatsapp: WhatsAppService;
let sql: <T = any>(text: string, values?: unknown[]) => Promise<T[]>;
let f: Awaited<ReturnType<typeof fixtures>>, propertyId: string;
const secret = randomBytes(32).toString('hex'), verify = randomBytes(32).toString('hex');
let next = 0;
const fetcher = vi.fn<typeof fetch>();
beforeAll(async () => {
  const booted = await bootAppOnOwnDatabase('whatsapp', TEST_BUSINESS_DATE);
  app = booted.app; sql = booted.sql; owner = await login(app,'owner'); desk = await login(app,'receptionist'); f = await fixtures(sql);
  propertyId = (await sql<{id:string}>('SELECT id FROM properties'))[0]!.id;
  const config = app.get<AppConfig>(APP_CONFIG);
  Object.assign(config, { WHATSAPP_ACCESS_TOKEN: randomBytes(24).toString('hex'), WHATSAPP_PHONE_NUMBER_ID:'123', WHATSAPP_BUSINESS_ACCOUNT_ID:'456', WHATSAPP_PROPERTY_ID:propertyId, WHATSAPP_APP_SECRET:secret, WHATSAPP_VERIFY_TOKEN:verify });
  app.get<MessageProvider[]>(MESSAGE_PROVIDERS).push(new WhatsAppProvider(config,fetcher));
  messaging = app.get(MessagingService); whatsapp = app.get(WhatsAppService);
  await sql("INSERT INTO settings(property_id,key,value) VALUES($1,'whatsapp',$2::jsonb)", [propertyId, JSON.stringify({
    enabled:true, templates:defaultBindings().map(t=>({...t,ready:true,approval:'APPROVED',matching:true})),
  })]);
  await sql("UPDATE properties SET email_enabled=true,email_from_address='stay@example.com'");
}, 120000);
afterAll(async()=>{await app.close();});
async function book(extra: object = {}) {
  next += 1;
  const day = String(next+1).padStart(2,'0'), end = String(next+2).padStart(2,'0');
  const response = await post(owner,'/reservations',{
    ...booking({roomTypeId:f.type('PRE'),arrival:'2027-01-'+day,departure:'2027-01-'+end}),
    guest:{firstName:'WhatsApp',lastName:'Test',mobile:String(9899900000+next),email:'test@example.com'},
    ...extra,
  }).expect(201);
  return response.body.id as string;
}
async function consent(id: string, optedIn=true) {
  const current=await owner.get('/api/v1/whatsapp-consent').query({reservationId:id}).expect(200);
  await post(owner,'/whatsapp-consent',{reservationId:id,optedIn,version:current.body.version}).expect(200);
}
const send = (id:string,key?:string)=>post(owner,'/messages/send',{channel:'whatsapp',templateKey:'booking_confirmation',reservationId:id},key);
async function bookingEvent(id: string) {
  const [event] = await sql<OutboxEvent>(`SELECT id,property_id AS "propertyId",topic,aggregate_type AS "aggregateType",aggregate_id AS "aggregateId",payload,attempts,created_at AS "createdAt" FROM outbox_events WHERE aggregate_id=$1 AND topic='reservation.created'`,[id]);
  await app.get(GuestMessagesHandler).handle(event!);
}
const reports = (id:string,status:string,opaque?:string,waba='456',sender='123')=>({
  object:'whatsapp_business_account',entry:[{id:waba,changes:[{field:'messages',value:{metadata:{phone_number_id:sender},
    statuses:[{id,status,timestamp:'1791711000',...(opaque?{biz_opaque_callback_data:opaque}:{})}]} }]}],
});
async function callback(body: object, valid=true) {
  const raw=JSON.stringify(body);
  return request(app.getHttpServer()).post('/api/v1/webhooks/whatsapp').set('content-type','application/json')
    .set('x-hub-signature-256','sha256='+createHmac('sha256',valid?secret:'wrong').update(raw).digest('hex')).send(raw);
}
describe('WhatsApp guest workflow',()=>{
  it('Save booking records agreement atomically and automatically sends one confirmation on each channel',async()=>{
    const body={
      ...booking({roomTypeId:f.type('PRE'),arrival:'2027-02-01',departure:'2027-02-02'}),
      guest:{firstName:'Automatic',lastName:'Booking',mobile:'9899910001',email:'automatic@example.com'},
      whatsappOptedIn:true,
    };
    const key='automatic-'+randomUUID();
    const created=await post(desk,'/reservations',body,key).expect(201);
    const repeated=await post(desk,'/reservations',body,key).expect(201);
    expect(repeated.body.id).toBe(created.body.id);
    const id=created.body.id;
    const [g]=await sql<{whatsapp_opted_in:boolean;whatsapp_consent_at:Date|null;recorded_by_creator:boolean}>(`SELECT g.whatsapp_opted_in,g.whatsapp_consent_at,g.whatsapp_consent_by=r.created_by AS recorded_by_creator FROM reservations r JOIN guests g ON g.id=r.primary_guest_id WHERE r.id=$1`,[id]);
    expect(g).toMatchObject({whatsapp_opted_in:true,recorded_by_creator:true});
    expect(g!.whatsapp_consent_at).toBeTruthy();
    expect((await sql<{n:string}>("SELECT count(*) AS n FROM audit_logs WHERE action='guest.whatsapp_consent_recorded' AND entity_id=$1",[created.body.guest.id]))[0]!.n).toBe('1');
    await bookingEvent(id);await bookingEvent(id);
    expect(await sql('SELECT channel,status FROM messages WHERE reservation_id=$1 ORDER BY channel',[id])).toEqual([{channel:'email',status:'queued'},{channel:'whatsapp',status:'queued'}]);
    fetcher.mockResolvedValueOnce(Response.json({messages:[{id:'wamid.automatic'}]}));
    await messaging.sendDue(100);
    expect(await sql('SELECT channel,status FROM messages WHERE reservation_id=$1 ORDER BY channel',[id])).toEqual([{channel:'email',status:'sent'},{channel:'whatsapp',status:'sent'}]);
    fetcher.mockClear();
  });
  it('keeps email automatic when the guest declines WhatsApp at booking',async()=>{
    const id=await book({whatsappOptedIn:false});
    await bookingEvent(id);fetcher.mockClear();await messaging.sendDue(100);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await sql('SELECT channel,status FROM messages WHERE reservation_id=$1 ORDER BY channel',[id])).toEqual([{channel:'email',status:'sent'},{channel:'whatsapp',status:'skipped'}]);
    const [g]=await sql('SELECT g.whatsapp_opted_in,g.whatsapp_consent_at FROM guests g JOIN reservations r ON r.primary_guest_id=g.id WHERE r.id=$1',[id]);
    expect(g.whatsapp_opted_in).toBe(false);expect(g.whatsapp_consent_at).toBeTruthy();
  });
  it('keeps a returning guest’s decline when older API callers omit an agreement',async()=>{
    const old=await book({whatsappOptedIn:false});
    const [r]=await sql<{primary_guest_id:string}>('SELECT primary_guest_id FROM reservations WHERE id=$1',[old]);
    const id=await book({guest:undefined,guestId:r!.primary_guest_id});
    await bookingEvent(id);fetcher.mockClear();await messaging.sendDue(100);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await sql("SELECT status,skip_reason FROM messages WHERE reservation_id=$1 AND channel='whatsapp'",[id]))[0]).toMatchObject({status:'skipped',skip_reason:'The guest has not agreed to WhatsApp messages.'});
  });
  it('has owner-only settings and never exposes access tokens or app secrets',async()=>{
    await desk.get('/api/v1/whatsapp-settings').expect(403);
    const result=await owner.get('/api/v1/whatsapp-settings').expect(200);
    expect(result.body.configured).toBe(true);
    expect(JSON.stringify(result.body)).not.toContain(secret);
    expect(JSON.stringify(result.body)).not.toContain('ACCESS_TOKEN');
  });
  it('defaults to no consent and records a skipped message without making a provider request',async()=>{
    const id=await book();fetcher.mockClear();
    const queued=await send(id).expect(200);
    expect(queued.body).toMatchObject({status:'skipped',skipReason:'The guest has not agreed to WhatsApp messages.'});
    await messaging.sendDue(100);expect(fetcher).not.toHaveBeenCalled();
  });
  it('enforces idempotency, records explicit consent, and handles a callback before the send returns',async()=>{
    const id=await book();await consent(id);
    const requestKey='same-'+randomUUID();
    const queued=await send(id,requestKey).expect(200);
    expect((await send(id,requestKey).expect(200)).body.id).toBe(queued.body.id);
    fetcher.mockImplementationOnce(async(_url,options)=>{
      const body=JSON.parse(String(options?.body));
      expect(body.biz_opaque_callback_data).toBe(queued.body.id);
      expect((await callback(reports('wamid.early','delivered',queued.body.id))).status).toBe(200);
      return Response.json({messages:[{id:'wamid.early'}]});
    });
    await messaging.sendDue(100);
    expect((await sql<{status:string}>('SELECT status FROM messages WHERE id=$1',[queued.body.id]))[0]!.status).toBe('delivered');
    await callback(reports('wamid.early','delivered',queued.body.id));
    await callback(reports('wamid.early','sent',queued.body.id));
    expect((await sql<{status:string}>('SELECT status FROM messages WHERE id=$1',[queued.body.id]))[0]!.status).toBe('delivered');
    expect((await sql<{n:string}>("SELECT count(*) AS n FROM message_events WHERE message_id=$1 AND status='whatsapp.delivered'",[queued.body.id]))[0]!.n).toBe('1');
  });
  it('blocks a queued send when consent is revoked',async()=>{
    const id=await book();await consent(id);const queued=await send(id).expect(200);await consent(id,false);fetcher.mockClear();
    await messaging.sendDue(100);
    expect((await sql<{status:string}>('SELECT status FROM messages WHERE id=$1',[queued.body.id]))[0]!.status).toBe('skipped');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('blocks a queued message when its approved template is switched off',async()=>{
    const id=await book();await consent(id);const queued=await send(id).expect(200);
    await sql("UPDATE settings SET value=jsonb_set(value,'{templates,0,active}','false'::jsonb) WHERE property_id=$1 AND key='whatsapp'",[propertyId]);
    fetcher.mockClear();await messaging.sendDue(100);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await sql<{status:string}>('SELECT status FROM messages WHERE id=$1',[queued.body.id]))[0]!.status).toBe('skipped');
    await sql("UPDATE settings SET value=jsonb_set(value,'{templates,0,active}','true'::jsonb) WHERE property_id=$1 AND key='whatsapp'",[propertyId]);
  });
  it('does not automatically resend after a network timeout or stale sender lease',async()=>{
    const id=await book();await consent(id);const queued=await send(id).expect(200);
    fetcher.mockRejectedValueOnce(new Error('timeout'));
    await messaging.sendDue(100);await messaging.sendDue(100);
    expect((await sql<{status:string;attempts:number}>('SELECT status,attempts FROM messages WHERE id=$1',[queued.body.id]))[0]).toMatchObject({status:'failed',attempts:1});
    const id2=await book();await consent(id2);const nextRow=await send(id2).expect(200);
    await sql("UPDATE messages SET status='sending',attempts=1,send_after=now()-interval '1 minute' WHERE id=$1",[nextRow.body.id]);
    fetcher.mockClear();await messaging.sendDue(100);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await sql<{status:string}>('SELECT status FROM messages WHERE id=$1',[nextRow.body.id]))[0]!.status).toBe('failed');
  });
  it('keeps new WhatsApp sends independent of email and stable when the outbox cause repeats',async()=>{
    const id=await book();await consent(id);
    const req={propertyId,reservationId:id,templateKey:'booking_confirmation' as const,sourceKey:'event:test-'+id,trigger:'event' as const};
    const {DbService}=await import('../src/db/db.service');
    const db=app.get(DbService);
    const first=await db.tx({},q=>whatsapp.queue(q,req));
    const repeated=await db.tx({},q=>whatsapp.queue(q,req));
    expect(first).toBeTruthy();expect(repeated).toBeNull();
    fetcher.mockResolvedValueOnce(Response.json({messages:[{id:'wamid.independent'}]}));
    await messaging.sendDue(100);
  });
});
describe('Meta callbacks',()=>{
  it('returns the exact plain-text verification challenge only with the correct token',async()=>{
    const result=await request(app.getHttpServer()).get('/api/v1/webhooks/whatsapp').query({'hub.mode':'subscribe','hub.verify_token':verify,'hub.challenge':'0000123'}).expect(200);
    expect(result.text).toBe('0000123');expect(result.headers['content-type']).toMatch(/text\/plain/);
    await request(app.getHttpServer()).get('/api/v1/webhooks/whatsapp').query({'hub.mode':'subscribe','hub.verify_token':'wrong','hub.challenge':'123'}).expect(401);
  });
  it('refuses forged callbacks and ignores events for another WABA or sender',async()=>{
    expect((await callback(reports('unknown','delivered'),false)).status).toBe(401);
    expect((await callback(reports('unknown','delivered',undefined,'other'))).body.matched).toBe(0);
    expect((await callback(reports('unknown','delivered',undefined,'456','other'))).body.matched).toBe(0);
  });
  it('acknowledges incoming chats without storing message content or contact details',async()=>{
    const body={object:'whatsapp_business_account',entry:[{id:'456',changes:[{field:'messages',value:{metadata:{phone_number_id:'123'},messages:[{text:{body:'private ID data'}}],contacts:[{profile:{name:'Private'}}]}}]}]};
    expect((await callback(body)).status).toBe(200);
    expect((await sql<{n:string}>("SELECT count(*) AS n FROM messages WHERE body LIKE '%private ID data%'"))[0]!.n).toBe('0');
  });
});

describe('shared property sender',()=>{
  let villaId:string,villaBooking:string;
  it('automatically sends Villa pool confirmation with its own contact and timed visit details',async()=>{
    const [u]=await sql<{id:string}>("SELECT id FROM users WHERE property_id=$1 AND role='owner'",[propertyId]);
    villaId=(await app.get(DbService).tx({userId:u!.id},q=>addVilla(q,propertyId,u!.id,'324001'))).propertyId;
    app.get<AppConfig>(APP_CONFIG).WHATSAPP_PROPERTY_IDS=[propertyId,villaId];
    await sql("INSERT INTO settings(property_id,key,value) VALUES($1,'whatsapp',$2::jsonb)",[villaId,JSON.stringify({enabled:true,templates:defaultBindings().map(t=>({...t,name:t.key==='receipt'?t.name:'resortos_villa_'+t.key+'_en_v1',ready:true,approval:'APPROVED',matching:true}))})]);
    const b=await post(owner,'/villa/bookings',{useKind:'pool',startsAt:'2027-03-01T10:00:00+05:30',endsAt:'2027-03-01T12:00:00+05:30',guestCount:4,price:'1250',gstPercent:'18',guest:{firstName:'Villa Guest',mobile:'9899910020',email:'villa@example.com'},whatsappOptedIn:true})
      .set('x-resortos-property',villaId).expect(201);
    villaBooking=b.body.id;await bookingEvent(villaBooking);await bookingEvent(villaBooking);
    const [m]=await sql<{id:string;body:string;outgoing_payload:any}>("SELECT id,body,outgoing_payload FROM messages WHERE reservation_id=$1 AND channel='whatsapp'",[villaBooking]);
    expect(m!.body).toContain('Villa Sol by Voitto');expect(m!.body).toContain('+919352204825');
    expect(m!.body).toContain('Swimming pool');expect(m!.body).toContain('10:00');expect(m!.body).toContain('12:00');
    expect(m!.body).not.toContain('Laxmi');expect(m!.outgoing_payload.whatsapp.imageHeader).toBe(true);
    fetcher.mockResolvedValueOnce(Response.json({id:'villa_logo'})).mockImplementationOnce(async()=>{
      expect((await callback(reports('wamid.villa.early','read',m!.id))).body.matched).toBe(1);
      return Response.json({messages:[{id:'wamid.villa.early'}]});
    });
    await messaging.sendDue(100);
    expect((await sql<{status:string}>('SELECT status FROM messages WHERE id=$1',[m!.id]))[0]!.status).toBe('opened');
    expect((await callback(reports('wamid.villa.early','delivered',m!.id))).body.matched).toBe(1);
    const get=await owner.get('/api/v1/whatsapp-settings').set('x-resortos-property',villaId).expect(200);
    expect(get.body).toMatchObject({configured:true,sharedSender:true});
    expect(get.body.templates[0]).toMatchObject({imageHeader:true,variables:whatsappWording('booking_confirmation','en','resortos_villa_booking_confirmation_en_v1').variables});
  });
  it('keeps receptionist access and message histories separated despite the shared number',async()=>{
    await desk.get('/api/v1/whatsapp-settings').set('x-resortos-property',villaId).expect(403);
    await post(desk,'/messages/send',{channel:'whatsapp',templateKey:'booking_confirmation',reservationId:villaBooking}).expect(404);
    const rows=await owner.get('/api/v1/messages').expect(200);
    expect(rows.body.every((m:any)=>m.reservationId!==villaBooking)).toBe(true);
  });
  it('does not route callbacks or early delivery to an unlisted property',async()=>{
    app.get<AppConfig>(APP_CONFIG).WHATSAPP_PROPERTY_IDS=[propertyId];
    expect((await callback(reports('wamid.villa.early','failed'))).body.matched).toBe(0);
    app.get<AppConfig>(APP_CONFIG).WHATSAPP_PROPERTY_IDS=[propertyId,villaId];
  });
  it('checks the shared-property allowlist again before sending and leaves hotel sending enabled',async()=>{
    const queued=await post(owner,'/messages/send',{channel:'whatsapp',templateKey:'booking_confirmation',reservationId:villaBooking}).set('x-resortos-property',villaId).expect(200);
    app.get<AppConfig>(APP_CONFIG).WHATSAPP_PROPERTY_IDS=[propertyId];fetcher.mockClear();
    await messaging.sendDue(100);expect(fetcher).not.toHaveBeenCalled();
    expect((await sql<{status:string}>('SELECT status FROM messages WHERE id=$1',[queued.body.id]))[0]!.status).toBe('skipped');
    const hotel=await book({whatsappOptedIn:true});await bookingEvent(hotel);
    fetcher.mockResolvedValueOnce(Response.json({messages:[{id:'wamid.hotel.still.works'}]}));await messaging.sendDue(100);
    expect((await sql<{status:string}>("SELECT status FROM messages WHERE reservation_id=$1 AND channel='whatsapp'",[hotel]))[0]!.status).toBe('sent');
    app.get<AppConfig>(APP_CONFIG).WHATSAPP_PROPERTY_IDS=[propertyId,villaId];
  });
});

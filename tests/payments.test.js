import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import mongoose from "mongoose";
import Stripe from "stripe";
import app from "../app.js";
import User from "../models/User.js";
import Session from "../models/Session.js";
import Course from "../models/Course.js";
import Category from "../models/Category.js";
import Module from "../models/Module.js";
import Lesson from "../models/Lesson.js";
import Enrollment from "../models/Enrollment.js";
import Progress from "../models/Progress.js";
import VideoAsset from "../models/VideoAsset.js";
import CourseNote from "../models/CourseNote.js";
import { paymentOrderModel } from "../models/PaymentOrder.js";
import { stripeEventModel } from "../models/StripeEvent.js";
import AuditEvent from "../models/AuditEvent.js";
import { rupeesToMinor } from "../services/coursePricing.js";
import { stripeReadiness, STRIPE_API_VERSION, trustedCheckoutUrl, validateStripeStartup } from "../services/stripeClient.js";

test("INR paise conversion is exact and rejects rounding, invalid prices and unsafe Checkout URLs", () => {
  for (const [value, amount] of [[0,0],["0.50",50],["12.34",1234],[1999.99,199999],["999999.99",99999999]]) assert.equal(rupeesToMinor(value),amount);
  for(const value of [-1,NaN,Infinity,"1.001","1e3","0.49","1000000",{},null,"abc"]) assert.throws(()=>rupeesToMinor(value));
  assert.equal(trustedCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test_fixture"),true);
  for(const url of ["https://checkout.stripe.com.evil.invalid","javascript:alert(1)","http://checkout.stripe.com","https://user@checkout.stripe.com","https://checkout.stripe.com:8443"]) assert.equal(trustedCheckoutUrl(url),false);
  assert.equal(stripeReadiness({STRIPE_SECRET_KEY:"sk_live_fixture",STRIPE_WEBHOOK_SECRET:"whsec_fixture"}).configured,false);
  assert.equal(stripeReadiness({}).configured,false);
  for (const mode of ["test","live"]) {
    const settings={STRIPE_MODE:mode,STRIPE_SECRET_KEY:`sk_${mode}_fixture`,STRIPE_WEBHOOK_SECRET:"whsec_fixture",CLIENT_URL:"https://frontend.fixture.invalid"};
    assert.deepEqual(stripeReadiness(settings),{configured:true,mode,testMode:mode==="test"});assert.doesNotThrow(()=>validateStripeStartup(settings));
    for (const key of [`sk_${mode==="test"?"live":"test"}_fixture`,"pk_live_fixture","sk_org_fixture","rk_live_fixture"]) {const invalid={...settings,STRIPE_SECRET_KEY:key};assert.equal(stripeReadiness(invalid).configured,false);assert.throws(()=>validateStripeStartup(invalid),/does not match/);}
    assert.equal(stripeReadiness({...settings,STRIPE_WEBHOOK_SECRET:"whsec_REPLACE_PRIVATELY"}).configured,false);
    assert.equal(stripeReadiness({...settings,STRIPE_WEBHOOK_SECRET:""}).configured,false);assert.doesNotThrow(()=>validateStripeStartup({...settings,STRIPE_WEBHOOK_SECRET:""}));
    assert.equal(stripeReadiness({...settings,STRIPE_WEBHOOK_SECRET:"bad"}).configured,false);assert.throws(()=>validateStripeStartup({...settings,STRIPE_WEBHOOK_SECRET:"bad"}));
    for (const origin of ["javascript:alert(1)","https://user@frontend.fixture.invalid","https://frontend.fixture.invalid/path","https://frontend.fixture.invalid?foo=bar","https://frontend.fixture.invalid/#fragment"]) assert.equal(stripeReadiness({...settings,CLIENT_URL:origin}).configured,false);
    if(mode==="live")for(const origin of ["","http://localhost:5173","http://frontend.fixture.invalid"])assert.equal(stripeReadiness({...settings,CLIENT_URL:origin}).configured,false);
  }
  for(const mode of ["LIVE","sandbox","","false"]) {assert.equal(stripeReadiness({STRIPE_MODE:mode}).configured,false);assert.throws(()=>validateStripeStartup({STRIPE_MODE:mode}),/STRIPE_MODE/);}
  assert.equal(stripeReadiness({STRIPE_SECRET_KEY:"sk_test_fixture",STRIPE_WEBHOOK_SECRET:"whsec_fixture"}).testMode,true);
  const client=new Stripe("sk_test_fixture",{apiVersion:STRIPE_API_VERSION});assert.equal(client.getApiField("version"),"2026-09-30.endive");
});

for (const mode of ["test", "live"]) test(`Stripe ${mode} payments, real signature/raw HTTP and MongoDB (all provider APIs mocked)`, {timeout:120000}, async(t)=>{
  const testMode = mode === "test", PaymentOrder = paymentOrderModel(mode), StripeEvent = stripeEventModel(mode);
  process.env.STRIPE_MODE=mode;process.env.CLIENT_URL="https://frontend.fixture.invalid";
  process.env.NODE_ENV="test";process.env.STRIPE_SECRET_KEY=`sk_${mode}_`+crypto.randomBytes(20).toString("hex");process.env.STRIPE_WEBHOOK_SECRET="whsec_"+crypto.randomBytes(24).toString("hex");
  await mongoose.connect(`mongodb://127.0.0.1:${process.env.TEST_MONGO_PORT||27018}/lms_test_payments_${crypto.randomBytes(6).toString("hex")}`,{serverSelectionTimeoutMS:5000});
  await Promise.all([User,Session,Course,Category,Module,Lesson,Enrollment,Progress,VideoAsset,CourseNote,PaymentOrder,StripeEvent,AuditEvent].map(m=>m.init()));
  const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});const base=`http://127.0.0.1:${server.address().port}/api`;
  const sessions=new Map(), intents=new Map(), disputes=new Map(), creates=new Map(), legacyCache=new Map();let failCreate=false, failRead=false, beforeReturn, failList=false, listPageSize=100;let createCalls=0;
  const createError=new Stripe.errors.StripeInvalidRequestError({code:"parameter_missing",param:"customer",statusCode:400,requestId:"req_fixtureCreate",message:"fixture-private-provider-message",headers:{authorization:"fixture-private-authorization"}});
  const fake={checkout:{sessions:{list:async(params)=>{
    if(failList)throw new Error("mock provider list unavailable");
    let data=[...sessions.values()].filter(s=>s.created>=params.created.gte).sort((a,b)=>b.id.localeCompare(a.id));
    if(params.starting_after)data=data.slice(data.findIndex(s=>s.id===params.starting_after)+1);
    const limit=Math.min(params.limit,listPageSize);return{data:structuredClone(data.slice(0,limit)),has_more:data.length>limit};
  },create:async(params,options)=>{
    createCalls++;
    const prior=legacyCache.get(options.idempotencyKey)||creates.get(options.idempotencyKey);
    if(prior){
      if(JSON.stringify(prior.params)!==JSON.stringify(params))throw new Stripe.errors.StripeIdempotencyError({statusCode:400,requestId:"req_fixtureConflict",message:"fixture-private-idempotency-message"});
      if(prior.error)throw prior.error;
    }
    if (Object.hasOwn(params,"payment_method_types")) throw new Stripe.errors.StripeInvalidRequestError({param:"payment_method_types",statusCode:400,requestId:"req_fixtureRejectedMethods",message:"Synthetic account rejects a forced method list"});
    if(failCreate)throw createError;
    if(!creates.has(options.idempotencyKey)){
      const id=`cs_${mode}_`+crypto.randomBytes(6).toString("hex");
      const session={id,created:Math.floor(Date.now()/1000),livemode:!testMode,mode:params.mode,currency:"inr",amount_total:params.line_items[0].price_data.unit_amount,metadata:params.metadata,client_reference_id:params.client_reference_id,status:"open",payment_status:"unpaid",payment_intent:null,expires_at:Math.floor(Date.now()/1000)+86400,url:`https://checkout.stripe.com/c/pay/${id}`};sessions.set(id,session);creates.set(options.idempotencyKey,{params,session});
    }
    await new Promise(r=>setTimeout(r,15));const session=creates.get(options.idempotencyKey).session;await beforeReturn?.(session);return structuredClone(session);
  },expire:async id=>{const s=sessions.get(id);assert.equal(s.payment_status,"unpaid");s.status="expired";return structuredClone(s);},retrieve:async id=>{if(failRead)throw new Error("mock unavailable");assert.ok(sessions.has(id));return structuredClone(sessions.get(id));}}},paymentIntents:{retrieve:async id=>{assert.ok(intents.has(id));return structuredClone(intents.get(id));}},disputes:{list:async({charge})=>({data:structuredClone(disputes.get(charge)||[])})},charges:{retrieve:async id=>{const intent=[...intents.values()].find(i=>i.latest_charge?.id===id);assert.ok(intent);return structuredClone(intent.latest_charge);}}};
  app.locals.stripeClient=fake;app.locals.directVideoStore={playback:async()=>({url:"https://fixture.invalid/private-video",expiresAt:Date.now()+300000})};app.locals.courseNoteStore={link:async()=>({url:"https://fixture.invalid/private-note",expiresAt:Date.now()+300000})};
  const call=async(path,cookie,method="GET",body,extra={})=>{
    const response=await fetch(base+path,{method,headers:{"Content-Type":"application/json",...(cookie?{cookie}:{}),...extra},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    return{status:response.status,body:await response.json(),cookie:response.headers.get("set-cookie")?.split(";")[0]};
  };
  const webhook=async(event,{bad=false,old=false,raw}={})=>{
    const body=raw||JSON.stringify(event);const signature=Stripe.webhooks.generateTestHeaderString({payload:body,secret:bad?"whsec_wrong":process.env.STRIPE_WEBHOOK_SECRET,timestamp:Math.floor(Date.now()/1000)-(old?600:0)});
    const response=await fetch(base+"/payments/webhook",{method:"POST",headers:{"Content-Type":"application/json","Stripe-Signature":signature},body});return{status:response.status,body:await response.json()};
  };
  const event=(type,object,created=Math.floor(Date.now()/1000))=>({id:"evt_"+crypto.randomBytes(8).toString("hex"),type,created,livemode:!testMode,data:{object}});
  const pay=order=>{
    const session=[...sessions.values()].find(s=>s.metadata.orderId===String(order._id));assert.ok(session);
    const id="pi_"+crypto.randomBytes(6).toString("hex"),charge={id:"ch_"+crypto.randomBytes(6).toString("hex"),livemode:!testMode,paid:true,status:"succeeded",amount:order.amountMinor,currency:"inr",amount_refunded:0,disputed:false,payment_intent:id};
    intents.set(id,{id,livemode:!testMode,status:"succeeded",currency:"inr",amount:order.amountMinor,metadata:session.metadata,latest_charge:charge});Object.assign(session,{status:"complete",payment_status:"paid",payment_intent:id});return session;
  };
  const users={};let course,videoLesson,textLesson,note,freeCourse,orderId;
  const create=async(user="student",key=crypto.randomUUID(),quoted=12345,extra={})=>call("/payments/checkout",users[user].cookie,"POST",{courseId:String(course._id),quotedAmountMinor:quoted,...extra},{"Idempotency-Key":key});
  const access=async(expected,user="student")=>{
    for(const [path,method,body] of [[`/courses/${course._id}`,"GET"],[`/lessons/${videoLesson._id}/playback`,"GET"],[`/courses/${course._id}/notes`,"GET"],[`/courses/${course._id}/notes/${note._id}/url`,"GET"],[`/courses/${course._id}/progress`,"GET"],[`/lessons/${textLesson._id}/complete`,"POST",{}]]){
      const r=await call(path,users[user].cookie,method,body);assert.equal(r.status,users[user].role!=="student" && (path.endsWith("/progress")||path.endsWith("/complete")) ? 403 : expected,`${method} ${path}: ${JSON.stringify(r.body)}`);
    }
  };
  try{
    for(const [name,role] of [["teacher","instructor"],["other","instructor"],["admin","admin"],["student","student"],["stranger","student"],["second","student"],["race","student"],["early","student"],["delayed","student"],["delayedfail","student"],["migrate","student"],["reuse","student"],["uncertain","student"],["legacy_paid","student"],["legacy_invalid","student"],["old_uncertain","student"],["old_reuse","student"]]){
      const password=crypto.randomBytes(24).toString("hex"),user=await User.create({name,role,email:`${name}@fixture.invalid`,password});users[name]={id:user._id,role,cookie:(await call("/auth/login",null,"POST",{email:user.email,password})).cookie};
    }
    const category=await Category.create({name:"General"});course=await Course.create({title:"Paid assigned course",description:"Fixture",instructor:users.teacher.id,category:category._id,price:123.45,isPublished:true});
    freeCourse=await Course.create({title:"Existing free course",description:"Fixture",instructor:users.teacher.id,category:category._id,isPublished:true});
    const module=await Module.create({course:course._id,title:"Lessons",order:0});videoLesson=await Lesson.create({course:course._id,module:module._id,title:"Video",contentType:"video",order:0});textLesson=await Lesson.create({course:course._id,module:module._id,title:"Text",contentType:"text",content:"Private course content",order:1});
    const video=await VideoAsset.create({owner:users.teacher.id,course:course._id,lesson:videoLesson._id,fingerprint:"fixture",filename:"fixture.mp4",size:200,chunkSize:0,chunkCount:0,status:"ready",uploadMode:"direct",storageProvider:"r2",objectKey:"videos/fixture",expiresAt:new Date(Date.now()+3600000)});await Lesson.updateOne({_id:videoLesson._id},{video:video._id});
    note=await CourseNote.create({course:course._id,owner:users.teacher.id,slot:0,uploadId:crypto.randomUUID(),filename:"fixture.pdf",size:100,sha256:"fixture",pages:1,status:"ready",objectKey:"notes/fixture.pdf"});
    await Enrollment.create([{student:users.student.id,course:course._id,assignedBy:users.teacher.id},{student:users.second.id,course:course._id,assignedBy:users.teacher.id},{student:users.student.id,course:freeCourse._id,assignedBy:users.teacher.id}]);
    await t.test("assignment never waives paid access; free courses and owner/admin previews preserved",async()=>{
      await access(402);await access(200,"teacher");await access(200,"admin");await access(403,"stranger");
      const listed=(await call("/courses",users.student.cookie)).body.data.courses;assert.equal(listed.length,2);assert.equal(listed.find(c=>c._id===String(course._id)).payment.required,true);assert.equal(listed.find(c=>c._id===String(freeCourse._id)).payment.status,"free");
      const assigned=(await call("/enrollments/me",users.student.cookie)).body.data.enrollments;assert.equal(assigned.length,2);assert.equal(assigned.find(e=>e.course._id===String(course._id)).course.payment.status,"required");assert.equal((await call("/courses",users.stranger.cookie)).body.data.courses.length,0);
      assert.equal((await call(`/courses/${freeCourse._id}`,users.student.cookie)).status,200);
      assert.equal((await call(`/payments/courses/${course._id}/quote`,users.stranger.cookie)).status,403);
      assert.equal((await create("teacher")).status,403);
      assert.equal((await call("/payments/checkout",null,"POST",{})).status,401);
      const slug=(await call(`/courses/${course.slug}`,users.student.cookie));assert.equal(slug.status,402);assert.equal(slug.body.courseId,String(course._id));
    });
    await t.test("test/live records, entitlements and event IDs remain isolated without migrating existing data",async()=>{
      const otherMode=testMode ? "live" : "test", OtherOrder=paymentOrderModel(otherMode), OtherEvent=stripeEventModel(otherMode);
      await Promise.all([OtherOrder.init(),OtherEvent.init()]);
      const foreign=await OtherOrder.create({student:users.student.id,course:course._id,instructor:users.teacher.id,title:course.title,amountMinor:12345,requestKey:"other-mode-pending",checkoutExpiresAt:new Date(Date.now()+3600000)});
      await OtherOrder.create({student:users.student.id,course:course._id,instructor:users.teacher.id,title:course.title,amountMinor:12345,requestKey:"other-mode-paid",status:"paid",active:false,checkoutExpiresAt:new Date(Date.now()+3600000)});
      await access(402);
      const quote=(await call(`/payments/courses/${course._id}/quote`,users.student.cookie)).body.data.quote;assert.equal(quote.paid,false);assert.equal(quote.testMode,testMode);assert.equal(quote.pendingOrderId,undefined);
      assert.equal((await call(`/payments/orders/${foreign._id}`,users.student.cookie)).status,404);
      assert.equal((await call(`/payments/orders/${foreign._id}/refresh`,users.student.cookie,"POST",{})).status,404);
      const sameEvent=event("checkout.session.completed",{id:`cs_${mode}_unrelated`});
      await OtherEvent.create({_id:sameEvent.id,type:sameEvent.type,status:"processed"});
      const answer=await webhook(sameEvent);assert.equal(answer.status,200);assert.equal(answer.body.duplicate,undefined);assert.equal(answer.body.ignored,true);
      assert.equal(await OtherOrder.countDocuments({}),2);assert.equal(foreign.testMode,!testMode);
    });
    await t.test("instructor price authority, exact paise, currency/destination spoofing ignored; unready/archived blocked",async()=>{
      assert.equal((await call(`/courses/${course._id}`,users.other.cookie,"PATCH",{price:10})).status,403);
      for(const price of ["1.001",-1,"1e4",0.49])assert.equal((await call(`/courses/${course._id}`,users.teacher.cookie,"PATCH",{price})).status,400);
      assert.equal((await create("student",crypto.randomUUID(),100)).status,409);
      assert.equal((await create("student","bad",12345)).status,400);
      const made=await create("student",crypto.randomUUID(),12345,{amount:1,currency:"usd",student:users.stranger.id,destination:"acct_attacker",payment_method_types:["attacker_method"],allowed_payment_method_types:["attacker_method"],payment_method_configuration:"pmc_attacker"});assert.equal(made.status,201);orderId=made.body.data.order.id;
      const request=[...creates.values()][0].params;assert.equal(request.line_items[0].price_data.unit_amount,12345);assert.equal(request.line_items[0].price_data.currency,"inr");assert.equal(request.metadata.studentId,String(users.student.id));assert.equal(request.payment_intent_data.transfer_data,undefined);assert.equal(request.payment_intent_data.application_fee_amount,undefined);
      assert.equal(Object.hasOwn(request,"payment_method_types"),false);assert.equal(request.allowed_payment_method_types,undefined);assert.equal(request.payment_method_configuration,undefined);
      assert.equal(Object.hasOwn(request,"expires_at"),false);
      assert.match(request.success_url,/\/payments\/[a-f0-9]{24}\?checkout=success$/);
      assert.equal((await call(`/payments/orders/${orderId}`,users.stranger.cookie)).status,404);
    });
    await t.test("concurrent same/different keys reuse one checkout, API timeout retry same order and amount snapshot",async()=>{
      const results=await Promise.all([create(),create(),create()]);for(const r of results){assert.equal(r.status,201);assert.equal(r.body.data.order.id,orderId);}assert.equal(await PaymentOrder.countDocuments({student:users.student.id,course:course._id}),1);assert.equal(creates.size,1);
      failCreate=true;const diagnosticLines=[],previousLogger=console.error;
      try {
        console.error=(line)=>diagnosticLines.push(line);
        const failed=await create("second");assert.equal(failed.status,502);assert.doesNotMatch(JSON.stringify(failed.body),/fixture-private|req_fixtureCreate|parameter_missing/);
      } finally { console.error=previousLogger; }
      assert.deepEqual(JSON.parse(diagnosticLines[0]),{event:"stripe_payment_failure",operation:"checkout_create",mode,type:"StripeInvalidRequestError",reason:"request_parameters",code:"parameter_missing",status:400,requestId:"req_fixtureCreate",param:"customer"});
      const failedOrder=await PaymentOrder.findOne({student:users.second.id});await PaymentOrder.updateOne({_id:failedOrder._id},{checkoutExpiresAt:new Date(0)});
      failCreate=false;const r=await create("second");assert.equal(r.status,201);assert.equal(r.body.data.order.id,String(failedOrder._id));assert.equal(await PaymentOrder.countDocuments({student:users.second.id}),1);
      const recovered=await PaymentOrder.findById(failedOrder._id).select("+stripeSessionId +checkoutContract");assert.equal(recovered.checkoutExpiresAt.getTime(),sessions.get(recovered.stripeSessionId).expires_at*1000);
      assert.equal(recovered.checkoutContract.version,2);assert.match(recovered.checkoutContract.key,/-checkout-v2-/);assert.deepEqual(recovered.checkoutContract.request,creates.get(recovered.checkoutContract.key).params);
      assert.equal(r.body.data.order.checkoutContract,undefined);assert.equal(r.body.data.order.checkoutRecoveryPlan,undefined);
      await call(`/courses/${course._id}`,users.teacher.cookie,"PATCH",{price:199.99});assert.equal((await create("student",crypto.randomUUID(),19999)).status,409);const retry=await create();assert.equal(retry.body.data.order.amountMinor,12345);await call(`/courses/${course._id}`,users.teacher.cookie,"PATCH",{price:123.45});
    });
    await t.test("real raw-body signatures reject forged/expired/modified/live/Connect events and oversized JSON",async()=>{
      const raw=event("checkout.session.completed",[...sessions.values()][0]);
      assert.equal((await webhook(raw,{bad:true})).status,400);assert.equal((await webhook(raw,{old:true})).status,400);
      assert.equal((await webhook({...raw,livemode:testMode})).status,400);assert.equal((await webhook({...raw,account:"acct_other"})).status,400);
      assert.equal((await webhook(raw,{raw:"x".repeat(256*1024+1)})).status,413);assert.equal(await StripeEvent.countDocuments({}),1);
      const key=process.env.STRIPE_SECRET_KEY;process.env.STRIPE_SECRET_KEY=`sk_${testMode ? "live" : "test"}_fixture`;assert.equal((await create()).status,503);process.env.STRIPE_SECRET_KEY=key;
      await access(402);
    });
    await t.test("success URL and unpaid completion do not grant access; signed payment grants only nominated account",async()=>{
      const session=[...sessions.values()].find(s=>s.metadata.orderId===orderId);
      session.amount_total=1;assert.equal((await webhook(event("checkout.session.completed",session))).status,409);session.amount_total=12345;await access(402);
      session.metadata.studentId=String(users.stranger.id);assert.equal((await webhook(event("checkout.session.completed",session))).status,409);session.metadata.studentId=String(users.student.id);await access(402);
      assert.equal((await webhook(event("checkout.session.completed",session))).status,200);await access(402);
      const snapshot=pay(await PaymentOrder.findById(orderId));const paid=event("checkout.session.completed",snapshot);assert.equal((await webhook(paid)).status,200);assert.equal((await webhook(paid)).body.duplicate,true);
      await access(200);await access(403,"stranger");assert.equal((await PaymentOrder.findById(orderId)).status,"paid");assert.equal((await create()).status,409);
      const dashboard=(await call("/enrollments/me",users.student.cookie)).body.data.enrollments;assert.equal(dashboard.length,2);assert.equal(dashboard.find(e=>e.course._id===String(course._id)).course.payment.required,false);assert.equal(dashboard.find(e=>e.course._id===String(course._id)).course.payment.status,"paid");
      const stale=event("checkout.session.expired",{...snapshot,status:"expired",payment_status:"unpaid"},paid.created-1000);assert.equal((await webhook(stale)).status,200);await access(200);
      assert.equal(await Enrollment.countDocuments({course:course._id}),2);
    });
    await t.test("failed processing is retryable; mismatched amount/metadata cannot grant access; per-order event lease handles races",async()=>{
      const secondOrder=await PaymentOrder.findOne({student:users.second.id});const session=pay(secondOrder),evt=event("checkout.session.completed",session);
      const intent=intents.get(session.payment_intent), charge=intent.latest_charge;
      for (const object of [session,intent,charge]) {
        object.livemode=testMode;assert.equal((await webhook(event("checkout.session.completed",session))).status,409);await access(402,"second");object.livemode=!testMode;
      }
      failRead=true;assert.equal((await webhook(evt)).status,500);failRead=false;assert.equal((await webhook(evt)).status,200);await access(200,"second");
      session.amount_total=1;assert.equal((await webhook(event("checkout.session.completed",session))).status,409);session.amount_total=secondOrder.amountMinor;
      const results=await Promise.all([webhook(event("payment_intent.succeeded",intents.get(session.payment_intent))),webhook(event("checkout.session.completed",session))]);assert.ok(results.every(r=>[200,503].includes(r.status)));assert.ok(results.some(r=>r.status===200));
      for(const record of await StripeEvent.find({status:"processing"})){
        await StripeEvent.updateOne({_id:record._id},{leaseUntil:new Date(0)});
      }
    });
    await t.test("provider refunds/disputes/reversals remove fresh media/PDF access; stale successes cannot restore it",async()=>{
      const session=[...sessions.values()].find(s=>s.metadata.orderId===orderId),intent=intents.get(session.payment_intent),charge=intent.latest_charge;
      charge.amount_refunded=100;assert.equal((await webhook(event("charge.refunded",charge))).status,200);await access(402);assert.equal((await PaymentOrder.findById(orderId)).status,"partially_refunded");
      const dashboard=(await call("/enrollments/me",users.student.cookie)).body.data.enrollments;assert.equal(dashboard.length,2);assert.equal(dashboard.find(e=>e.course._id===String(course._id)).course.payment.required,true);assert.equal(dashboard.find(e=>e.course._id===String(course._id)).course.payment.status,"partially_refunded");
      charge.amount_refunded=12345;assert.equal((await webhook(event("charge.refunded",charge))).status,200);assert.equal((await PaymentOrder.findById(orderId)).status,"refunded");
      assert.equal((await webhook(event("checkout.session.completed",session))).status,200);await access(402);
      charge.amount_refunded=0;charge.disputed=true;disputes.set(charge.id,[{id:"dp_fixture",livemode:!testMode,charge:charge.id,payment_intent:intent.id,status:"needs_response"}]);assert.equal((await webhook(event("charge.dispute.created",{id:"dp_fixture",charge:charge.id,payment_intent:session.payment_intent}))).status,200);assert.equal((await PaymentOrder.findById(orderId)).status,"disputed");await access(402);
      disputes.get(charge.id)[0].status="lost";assert.equal((await webhook(event("charge.dispute.closed",{id:"dp_fixture",charge:charge.id,payment_intent:session.payment_intent}))).status,200);assert.equal((await PaymentOrder.findById(orderId)).status,"reversed");
      disputes.get(charge.id)[0].status="won";assert.equal((await webhook(event("charge.dispute.closed",{id:"dp_fixture",charge:charge.id,payment_intent:session.payment_intent}))).status,200);await access(200);
    });
    await t.test("dynamic method completion remains locked while processing; async success/failure use canonical state",async()=>{
      await Enrollment.create([{student:users.delayed.id,course:course._id,assignedBy:users.teacher.id},{student:users.delayedfail.id,course:course._id,assignedBy:users.teacher.id}]);
      const made=await create("delayed");assert.equal(made.status,201);const row=await PaymentOrder.findById(made.body.data.order.id),session=pay(row),intent=intents.get(session.payment_intent),charge=intent.latest_charge;
      session.payment_method_types=["fixture_delayed_method"];session.payment_status="unpaid";intent.status="processing";charge.paid=false;charge.status="pending";
      assert.equal((await webhook(event("checkout.session.completed",session))).status,200);await access(402,"delayed");assert.equal((await PaymentOrder.findById(row._id)).status,"pending");
      session.payment_status="paid";intent.status="succeeded";charge.paid=true;charge.status="succeeded";
      const success=event("checkout.session.async_payment_succeeded",session);assert.equal((await webhook(success)).status,200);assert.equal((await webhook(success)).body.duplicate,true);await access(200,"delayed");
      const failed=await create("delayedfail");assert.equal(failed.status,201);const failedOrder=await PaymentOrder.findById(failed.body.data.order.id),failedSession=pay(failedOrder),failedIntent=intents.get(failedSession.payment_intent);
      failedSession.payment_status="unpaid";failedIntent.status="requires_payment_method";failedIntent.last_payment_error={code:"fixture_method_failed"};failedIntent.latest_charge=null;
      assert.equal((await webhook(event("checkout.session.async_payment_failed",failedSession))).status,200);await access(402,"delayedfail");assert.equal((await PaymentOrder.findById(failedOrder._id)).status,"failed");
    });
    await t.test("webhook before session attachment, archive during creation, failure/expiry and duplicate identity guards",async()=>{
      await Enrollment.create([{student:users.early.id,course:course._id,assignedBy:users.teacher.id},{student:users.race.id,course:course._id,assignedBy:users.teacher.id}]);
      beforeReturn=async session=>{assert.equal((await webhook(event("checkout.session.completed",session))).status,200);};
      const early=await create("early");assert.equal(early.status,201);beforeReturn=null;
      const earlySession=sessions.get((await PaymentOrder.findById(early.body.data.order.id).select("+stripeSessionId")).stripeSessionId);
      earlySession.status="expired";await PaymentOrder.updateOne({_id:early.body.data.order.id},{checkoutExpiresAt:new Date(0)});
      const pendingQuote=await call(`/payments/courses/${course._id}/quote`,users.early.cookie);assert.equal(pendingQuote.body.data.quote.pendingOrderId,early.body.data.order.id);
      assert.equal((await call(`/payments/orders/${early.body.data.order.id}/refresh`,users.early.cookie,"POST",{})).status,200);
      assert.equal((await webhook(event("checkout.session.expired",earlySession))).status,200);
      assert.equal((await PaymentOrder.findById(early.body.data.order.id)).status,"expired");
      beforeReturn=async()=>{await Course.updateOne({_id:course._id},{archivedAt:new Date(),isPublished:false});};
      const racing=await create("race");assert.equal(racing.status,410);beforeReturn=null;
      const saved=await PaymentOrder.findOne({student:users.race.id});assert.equal(saved.status,"expired");assert.equal(saved.active,false);
      await Course.updateOne({_id:course._id},{archivedAt:null,isPublished:true});
      const retry=await create("race");assert.equal(retry.status,201);assert.notEqual(retry.body.data.order.id,String(saved._id));
      const row=await PaymentOrder.findById(retry.body.data.order.id).select("+stripeSessionId");const session=sessions.get(row.stripeSessionId);
      const id="pi_failure";session.payment_intent=id;intents.set(id,{id,livemode:!testMode,status:"requires_payment_method",amount:12345,currency:"inr",metadata:session.metadata,last_payment_error:{code:"card_declined"},latest_charge:null});
      assert.equal((await webhook(event("payment_intent.payment_failed",intents.get(id)))).status,200);assert.equal((await PaymentOrder.findById(row._id)).status,"failed");
      const count=await StripeEvent.countDocuments({});
      for (const type of ["customer.created","checkout.session.created","payment_intent.created","charge.succeeded","charge.updated","charge.captured"]) {
        const unrelated=event(type,{id:"unrelated"});const ignored=await webhook(unrelated);assert.equal(ignored.status,200);assert.equal(ignored.body.ignored,true);
      }
      assert.equal(await StripeEvent.countDocuments({}),count);
    });
    await t.test("legacy recovery reuses existing sessions, migrates only a proven cached 400 and blocks unknown outcomes",async()=>{
      const legacy=async(name)=>{
        await Enrollment.create({student:users[name].id,course:course._id,assignedBy:users.teacher.id});
        const row=await PaymentOrder.create({student:users[name].id,course:course._id,instructor:users.teacher.id,title:course.title,amountMinor:12345,requestKey:crypto.randomUUID(),checkoutExpiresAt:new Date(Date.now()+31*60000)});
        const metadata={orderId:String(row._id),studentId:String(row.student),courseId:String(row.course)};
        const current={mode:"payment",client_reference_id:String(row._id),metadata,payment_intent_data:{metadata},line_items:[{quantity:1,price_data:{currency:"inr",unit_amount:12345,product_data:{name:row.title}}}],success_url:`https://frontend.fixture.invalid/payments/${row._id}?checkout=success`,cancel_url:`https://frontend.fixture.invalid/payments/${row._id}?checkout=canceled`};
        return{row,current,original:{...current,payment_method_types:["card"],expires_at:Math.floor(row.checkoutExpiresAt.getTime()/1000)},key:`lessonloop-${mode}-checkout-${row._id}`};
      };
      const old=await legacy("migrate");
      legacyCache.set(old.key,{params:old.original,error:new Stripe.errors.StripeInvalidRequestError({statusCode:400,requestId:"req_fixtureSavedFailure",headers:{"idempotent-replayed":"true"},message:"fixture-private-cached-error"})});
      const before=creates.size,results=await Promise.all([create("migrate"),create("migrate"),create("migrate")]);
      for(const result of results){assert.equal(result.status,201,JSON.stringify(result.body));assert.equal(result.body.data.order.id,String(old.row._id));}
      assert.equal(creates.size,before+1);assert.equal(await PaymentOrder.countDocuments({student:users.migrate.id}),1);
      const saved=await PaymentOrder.findById(old.row._id).select("+checkoutContract +checkoutRecoveryPlan");assert.equal(saved.checkoutContract.version,2);assert.notEqual(saved.checkoutContract.key,old.key);assert.deepEqual(saved.checkoutContract.request,old.current);assert.deepEqual(saved.checkoutRecoveryPlan.original.request,old.original);await access(402,"migrate");
      const seedSession=(old,status="open")=>{
        const id=`cs_${mode}_`+crypto.randomBytes(6).toString("hex"),session={id,created:Math.floor(Date.now()/1000),livemode:!testMode,mode:"payment",currency:"inr",amount_total:12345,metadata:old.current.metadata,client_reference_id:String(old.row._id),status,payment_status:"unpaid",payment_intent:null,expires_at:Math.floor(Date.now()/1000)+86400,url:`https://checkout.stripe.com/c/pay/${id}`};sessions.set(id,session);return session;
      };
      const reuse=await legacy("reuse"),existing=seedSession(reuse);listPageSize=2;const count=createCalls;
      const reused=await create("reuse");assert.equal(reused.status,201);assert.equal(reused.body.data.url,existing.url);assert.equal(createCalls,count);listPageSize=100;
      const paid=await legacy("legacy_paid");seedSession(paid);pay(paid.row);const countPaid=createCalls;assert.equal((await create("legacy_paid")).status,409);assert.equal(createCalls,countPaid);await access(200,"legacy_paid");
      const uncertain=await legacy("uncertain");legacyCache.set(uncertain.key,{params:uncertain.original,error:new Stripe.errors.StripeAPIError({statusCode:500,requestId:"req_fixtureUnknownOutcome",headers:{"idempotent-replayed":"true"},message:"fixture-private-server-error"})});
      const size=creates.size;assert.equal((await create("uncertain")).status,502);assert.equal(creates.size,size);assert.equal((await PaymentOrder.findById(uncertain.row._id).select("+checkoutContract")).checkoutContract,undefined);await access(402,"uncertain");
      failList=true;const calls=createCalls;assert.equal((await create("uncertain")).status,503);assert.equal(createCalls,calls);failList=false;
      const invalid=await legacy("legacy_invalid"),invalidSession=seedSession(invalid);invalidSession.amount_total=1;const invalidCalls=createCalls;assert.equal((await create("legacy_invalid")).status,409);assert.equal(createCalls,invalidCalls);await access(402,"legacy_invalid");
      const pruned=await legacy("old_uncertain");await PaymentOrder.collection.updateOne({_id:pruned.row._id},{$set:{createdAt:new Date(Date.now()-25*3600000)}});const prunedCalls=createCalls;assert.equal((await create("old_uncertain")).status,409);assert.equal(createCalls,prunedCalls);await access(402,"old_uncertain");
    });
    await t.test("a versioned key outside Stripe's retention window only reuses a reconciled Session",async()=>{
      await Enrollment.create({student:users.old_reuse.id,course:course._id,assignedBy:users.teacher.id});
      failCreate=true;const failed=await create("old_reuse");failCreate=false;assert.equal(failed.status,502);
      const row=await PaymentOrder.findOne({student:users.old_reuse.id}).select("+checkoutContract");
      const oldContract={...row.checkoutContract,createdAt:new Date(Date.now()-25*3600000).toISOString()};
      await PaymentOrder.collection.updateOne({_id:row._id},{$set:{checkoutContract:oldContract}});
      const calls=createCalls;assert.equal((await create("old_reuse")).status,409);assert.equal(createCalls,calls);await access(402,"old_reuse");
      const session=await fake.checkout.sessions.create(row.checkoutContract.request,{idempotencyKey:row.checkoutContract.key});const existingCalls=createCalls;
      const recovered=await create("old_reuse");assert.equal(recovered.status,201);assert.equal(recovered.body.data.url,session.url);assert.equal(createCalls,existingCalls);await access(402,"old_reuse");
    });
    await t.test("payment never creates nomination or reopens archive/unpublished/suspended access; paid progress retained",async()=>{
      const progress=await Progress.findOne({student:users.student.id,course:course._id});assert.ok(progress);
      await Enrollment.deleteOne({student:users.student.id,course:course._id});await access(403);assert.equal((await call(`/payments/orders/${orderId}/refresh`,users.student.cookie,"POST",{})).status,200);await access(403);assert.equal(await Progress.countDocuments({_id:progress._id}),1);
      await Enrollment.create({student:users.student.id,course:course._id,assignedBy:users.teacher.id});await access(200);
      await Course.updateOne({_id:course._id},{archivedAt:new Date(),isPublished:false});assert.equal((await create("second")).status,410);await access(410);
      await Course.updateOne({_id:course._id},{archivedAt:null,isPublished:false});await access(403);await Course.updateOne({_id:course._id},{isPublished:true});
      await User.updateOne({_id:users.student.id},{status:"suspended"});await access(401);await User.updateOne({_id:users.student.id},{status:"active"});await access(200);
      assert.equal(await PaymentOrder.countDocuments({student:users.student.id,course:course._id}),1);
    });
  }finally{
    await new Promise(resolve=>server.close(resolve));delete app.locals.stripeClient;delete app.locals.directVideoStore;delete app.locals.courseNoteStore;
    assert.match(mongoose.connection.name,/^lms_test_payments_/);await mongoose.connection.dropDatabase();await mongoose.disconnect();delete process.env.STRIPE_MODE;delete process.env.CLIENT_URL;delete process.env.STRIPE_SECRET_KEY;delete process.env.STRIPE_WEBHOOK_SECRET;
  }
});

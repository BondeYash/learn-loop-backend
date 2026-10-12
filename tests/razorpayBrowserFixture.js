// Real app + disposable loopback database. Every payment provider call is synthetic.
import crypto from "node:crypto";
import readline from "node:readline";
import mongoose from "mongoose";
import app from "../app.js";
import User from "../models/User.js";
import Course from "../models/Course.js";
import Category from "../models/Category.js";
import Module from "../models/Module.js";
import Lesson from "../models/Lesson.js";
import Enrollment from "../models/Enrollment.js";
import { paymentOrderModel } from "../models/PaymentOrder.js";
import { providerFixture } from "./razorpayFixture.js";
if (process.env.NODE_ENV !== "test" || process.env.CLIENT_URL !== "http://127.0.0.1:5186") throw new Error("Only the isolated test environment is supported.");
Object.assign(process.env,{RAZORPAY_MODE:"test",RAZORPAY_KEY_ID:"rzp_test_synthetic",RAZORPAY_KEY_SECRET:crypto.randomBytes(24).toString("hex"),RAZORPAY_WEBHOOK_SECRET:crypto.randomBytes(24).toString("hex")});
const port=Number(process.env.TEST_MONGO_PORT||27018);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error("Invalid loopback port");
await mongoose.connect(`mongodb://127.0.0.1:${port}/lms_payment_browser_${crypto.randomBytes(8).toString("hex")}`,{serverSelectionTimeoutMS:5000});
await Promise.all(Object.values(mongoose.models).map(m=>m.init()));
const fake=providerFixture();app.locals.razorpayClient=fake;
const users={};for(const [name,role] of [["owner","instructor"],["student","student"],["second","student"],["third","student"],["complimentary","student"]]){const password=crypto.randomBytes(20).toString("hex"),email=`${name}@payment-fixture.invalid`,u=await User.create({name:`Synthetic ${name}`,email,password,role});users[name]={id:String(u._id),email,password};}
const category=await Category.create({name:"Synthetic payment course"});
const course=await Course.create({title:"Synthetic Razorpay course",description:"Synthetic paid learning with automatic enrollment",category:category._id,instructor:users.owner.id,visibility:"private",isPublished:false,price:123.45});
const chapter=await Module.create({course:course._id,title:"Lessons",order:0});await Lesson.create({course:course._id,module:chapter._id,title:"Protected paid lesson",contentType:"text",content:"Synthetic learning unlocked after verified payment.",order:0});
const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});const origin=`http://127.0.0.1:${server.address().port}`;
console.log(JSON.stringify({apiOrigin:origin,courseId:String(course._id),slug:course.slug,users}));
const sign=(body,key)=>crypto.createHmac("sha256",key).update(body).digest("hex");
async function deliver(event,id=crypto.randomUUID()){const body=JSON.stringify(event),r=await fetch(origin+"/api/payments/razorpay/webhook",{method:"POST",headers:{"Content-Type":"application/json","X-Razorpay-Signature":sign(body,process.env.RAZORPAY_WEBHOOK_SECRET),"X-Razorpay-Event-Id":id},body});return{status:r.status,body:await r.json()};}
let closing=false;async function close(){if(closing)return;closing=true;await new Promise(r=>server.close(r));await mongoose.connection.dropDatabase();await mongoose.disconnect();process.exit(0);}process.on("SIGTERM",close);process.on("SIGINT",close);
for await(const line of readline.createInterface({input:process.stdin})){
 try{const c=JSON.parse(line);let result;
  if(c.action==="pay"){const p=fake.pay(c.orderId,c.status||"captured");result={razorpay_order_id:p.order_id,razorpay_payment_id:p.id,razorpay_signature:sign(`${p.order_id}|${p.id}`,process.env.RAZORPAY_KEY_SECRET)};if(c.webhook)result.webhook=await deliver(fake.event(p.status==="failed"?"payment.failed":"payment.captured",p));}
  else if(c.action==="refund"){const p=fake.refund(c.paymentId,c.amount);result=await deliver(fake.event("refund.processed",{id:"rfnd_synthetic",payment_id:p.id,amount:c.amount,status:"processed"}));}
  else if(c.action==="stats")result={orders:await paymentOrderModel().countDocuments({}),enrollments:await Enrollment.countDocuments({course:course._id}),creates:fake.creates};
  else if(c.action==="missingEnrollment"){await Enrollment.deleteOne({student:users[c.student].id,course:course._id});result={updated:true};}
  else if(c.action==="unpublish"){await Course.updateOne({_id:course._id},{$set:{isPublished:false}});result={updated:true};}
  else if(c.action==="assign"){await Enrollment.updateOne({student:users[c.student].id,course:course._id},{$set:{assignedBy:users.owner.id}},{upsert:true});result={updated:true};}
  else if(c.action==="assignments")result={assignments:await Enrollment.countDocuments({course:course._id,assignedBy:{$exists:true}})};
  else if(c.action==="stop")await close();else result={error:"Unknown command"};
  console.log(JSON.stringify(result));
 }catch(e){console.log(JSON.stringify({error:e.message}));}
}
await close();

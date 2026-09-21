import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "node:path"; import { fileURLToPath } from "node:url";
const PROTO = "/tmp/hl-clone/services/media/proto/lp_rpc.proto";
const def = protoLoader.loadSync(PROTO, {keepCase:true,longs:String,enums:String,defaults:true,oneofs:true});
const proto = grpc.loadPackageDefinition(def);
let port, lastReq, server = new grpc.Server();
server.addService(proto.net.Orchestrator.service, {
  GetOrchestrator: (call, cb) => {
    lastReq = call.request;
    cb(null, { transcoder:"x", address: Buffer.from("deadbeef","hex"),
      price_info:{pricePerUnit:"1",pixelsPerUnit:"1"}, nodes:["y"],
      auth_token:{ sessionId:"sess-abc", token: Buffer.from("tok","hex"), expiration:"123" } });
  },
});
await new Promise((res,rej)=>server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(),(e,p)=>e?rej(e):(port=p,res())));
server.start();
const client = new proto.net.Orchestrator(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
const info = await new Promise((res,rej)=>client.GetOrchestrator({address:Buffer.from("aa","hex"),sig:Buffer.from("bb","hex"),ignoreCapacityCheck:true},(e,r)=>e?rej(e):res(r)));
console.log("info keys:", Object.keys(info));
console.log("auth_token:", JSON.stringify(info.auth_token));
console.log("authToken:", JSON.stringify(info.authToken));
console.log("has getAuthToken:", typeof info.getAuthToken);
console.log("getAuthToken():", info.getAuthToken && JSON.stringify(info.getAuthToken()));
client.close(); server.forceShutdown();

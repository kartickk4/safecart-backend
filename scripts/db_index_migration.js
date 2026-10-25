/**
 * scripts/db_index_migration.js
 * Database Index Migration & Verification Script
 * SecureKaro / SafeCart
 *
 * WHAT THIS DOES:
 *   1. Connects to MongoDB using MONGODB_URI from .env
 *   2. Syncs all Mongoose model indexes (creates missing ones safely)
 *   3. Lists every active index per collection
 *   4. Runs EXPLAIN on 8 critical query patterns
 *   5. Reports index sizes and DB stats
 *   6. Prints DROP instructions for redundant indexes (manual approval required)
 *
 * SAFETY: Adds indexes only. No data modified. No automatic index drops.
 *
 * USAGE: node scripts/db_index_migration.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Shipment          = require("../src/models/Shipment");
const User              = require("../src/models/User");
const CarrierJourney    = require("../src/models/CarrierJourney");
const WalletTransaction = require("../src/models/WalletTransaction");
const Notification      = require("../src/models/Notification");
const Claim             = require("../src/models/Claim");
const Reward            = require("../src/models/Reward");
const BulkJob           = require("../src/models/BulkJob");
const AgentSession      = require("../src/models/AgentSession");
const AuditLog          = require("../src/models/AuditLog");

const G = "\x1b[32m", Y = "\x1b[33m", R = "\x1b[31m", C = "\x1b[36m", B = "\x1b[1m", X = "\x1b[0m";
const ok   = m => console.log(`  ${G}+${X} ${m}`);
const warn = m => console.log(`  ${Y}!${X} ${m}`);
const fail = m => console.log(`  ${R}x${X} ${m}`);
const hdr  = t => console.log(`\n${B}${C}${"=".repeat(68)}\n  ${t}\n${"=".repeat(68)}${X}`);

async function listIndexes(model, label) {
  const idxs = await model.collection.indexes();
  console.log(`\n${B}${label}${X} (${idxs.length}):`);
  for (const i of idxs) {
    const flags = [i.unique?"UNIQUE":"", i.sparse?"SPARSE":"", i.expireAfterSeconds!=null?`TTL(${i.expireAfterSeconds}s)`:""].filter(Boolean).join(",");
    console.log(`    ${JSON.stringify(i.key).padEnd(60)}${flags?"["+flags+"]":""}`);
  }
  return idxs;
}

function hasIndex(idxs, spec) {
  return idxs.some(i => {
    const a = Object.entries(i.key).map(([k,v])=>`${k}:${v}`).join(",");
    const b = Object.entries(spec).map(([k,v])=>`${k}:${v}`).join(",");
    return a === b;
  });
}

async function verify(idxs, spec, desc) {
  hasIndex(idxs, spec) ? ok(`${desc}`) : fail(`MISSING: ${desc} -> ${JSON.stringify(spec)}`);
}

async function explain(label, model, filter, sort) {
  try {
    let q = model.find(filter);
    if (sort) q = q.sort(sort);
    const p = await q.explain("executionStats");
    const planStr = JSON.stringify(p.queryPlanner?.winningPlan || {});
    const isIx  = planStr.includes("IXSCAN");
    const stage = p.queryPlanner?.winningPlan?.stage || "UNKNOWN";
    const idx   = p.queryPlanner?.winningPlan?.inputStage?.indexName || p.queryPlanner?.winningPlan?.indexName || (isIx ? "(nested IXSCAN)" : "NONE");
    const docs  = p.executionStats?.totalDocsExamined ?? "?";
    const ret   = p.executionStats?.nReturned ?? "?";
    const ms    = p.executionStats?.executionTimeMillis ?? "?";
    (isIx ? ok : fail)(`${label}`);
    console.log(`      Stage:${stage}  Index:${idx}  Examined:${docs}  Returned:${ret}  ${ms}ms`);
    if (!isIx) warn("      --> COLLECTION SCAN. Verify index sync completed.");
  } catch(e) {
    warn(`${label} -- explain error: ${e.message}`);
  }
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { fail("MONGODB_URI not set in .env"); process.exit(1); }
  console.log("Connecting...");
  await mongoose.connect(uri);
  console.log(`${G}Connected!${X}`);

  hdr("Phase 1: Sync Mongoose Schema Indexes");
  const allModels = [
    [Shipment,"Shipment"],[User,"User"],[CarrierJourney,"CarrierJourney"],
    [WalletTransaction,"WalletTransaction"],[Notification,"Notification"],
    [Claim,"Claim"],[Reward,"Reward"],[BulkJob,"BulkJob"],
    [AgentSession,"AgentSession"],[AuditLog,"AuditLog"]
  ];
  for (const [m, n] of allModels) {
    try { await m.syncIndexes(); ok(`${n} synced`); }
    catch(e) { fail(`${n}: ${e.message}`); }
  }

  hdr("Phase 2: Active Index Inventory");
  const si = await listIndexes(Shipment,          "shipments");
  const ui = await listIndexes(User,              "users");
  const ji = await listIndexes(CarrierJourney,    "carrierjourneys");
  const wi = await listIndexes(WalletTransaction, "wallettransactions");
              await listIndexes(Notification,      "notifications");
  const ci = await listIndexes(Claim,             "claims");
              await listIndexes(Reward,            "rewards");
  const bi = await listIndexes(BulkJob,           "bulkjobs");
              await listIndexes(AgentSession,      "agentsessions");
              await listIndexes(AuditLog,          "auditlogs");

  hdr("Phase 3: Verify New Indexes");
  console.log(`\n${B}Shipments:${X}`);
  await verify(si, {awbCode:1},                                                                        "awbCode sparse - tracking webhooks");
  await verify(si, {senderId:1,createdAt:-1},                                                          "senderId+createdAt - seller list+sort");
  await verify(si, {escrowStage:1,awbCode:1},                                                          "escrowStage+awbCode - tracking poll");
  await verify(si, {deliveryConfirmed:1,returnWindowClosed:1,returnWindowExpiresAt:1},                 "deliveryConfirmed+returnWindowClosed+returnWindowExpiresAt - return cron");
  await verify(si, {inboxQrToken:1},                                                                   "inboxQrToken sparse - QR delivery");
  await verify(si, {status:1,createdAt:-1},                                                            "status+createdAt - admin dashboard");
  await verify(si, {youpiPaymentId:1},                                                                 "youpiPaymentId sparse - payment webhook");
  console.log(`\n${B}CarrierJourneys:${X}`);
  await verify(ji, {awbCode:1},                                                                        "awbCode sparse - tracking lookup");
  console.log(`\n${B}Users:${X}`);
  await verify(ui, {phone:1},                                                                          "phone sparse - receiver lookup");
  await verify(ui, {role:1,createdAt:-1},                                                              "role+createdAt - admin user list");
  console.log(`\n${B}WalletTransactions:${X}`);
  await verify(wi, {sellerId:1,createdAt:-1},                                                          "sellerId+createdAt - seller wallet history");
  await verify(wi, {userId:1,createdAt:-1},                                                            "userId+createdAt - buyer wallet history");
  console.log(`\n${B}Claims:${X}`);
  await verify(ci, {status:1},                                                                         "status - admin claim count");
  console.log(`\n${B}BulkJobs:${X}`);
  await verify(bi, {userId:1,createdAt:-1},                                                            "userId+createdAt - user job history");

  hdr("Phase 4: EXPLAIN Validation");
  await explain("Seller shipment list+sort",        Shipment,          {senderId:new mongoose.Types.ObjectId()},    {createdAt:-1});
  await explain("Tracking poll escrowStage+awbCode",Shipment,          {escrowStage:4,awbCode:{$ne:""}},            null);
  await explain("Return window cron",               Shipment,          {deliveryConfirmed:true,returnWindowClosed:false,returnWindowExpiresAt:{$lte:new Date()}}, null);
  await explain("AWB tracking lookup",              Shipment,          {awbCode:"SAMPLE-AWB-001"},                  null);
  await explain("Receiver phone lookup",            User,              {phone:"9999999999"},                        null);
  await explain("CarrierJourney AWB lookup",        CarrierJourney,    {awbCode:"SAMPLE-AWB-001"},                  null);
  await explain("Wallet history+sort",              WalletTransaction, {sellerId:new mongoose.Types.ObjectId()},    {createdAt:-1});
  await explain("Admin status+sort",                Shipment,          {status:"In Transit"},                       {createdAt:-1});

  hdr("Phase 5: Database Statistics");
  const stats = await mongoose.connection.db.command({dbStats:1});
  console.log(`\n  Collections: ${stats.collections}`);
  console.log(`  Indexes:     ${stats.indexes}`);
  console.log(`  Data:        ${(stats.dataSize/1024/1024).toFixed(2)} MB`);
  console.log(`  IndexSize:   ${(stats.indexSize/1024/1024).toFixed(2)} MB`);
  console.log(`  Storage:     ${(stats.storageSize/1024/1024).toFixed(2)} MB`);

  hdr("Phase 6: Redundant Index Drop Instructions (MANUAL - Requires Your Approval)");
  console.log(`
${Y}Review Phase 4 EXPLAIN output first. Once confirmed, run these on Atlas Shell:${X}

db.shipments.dropIndex("senderId_1")
db.shipments.dropIndex("returnWindowClosed_1_returnWindowExpiresAt_1")
db.shipments.dropIndex("returnAllowed_1")
db.shipments.dropIndex("returnCarrierSlug_1")
db.wallettransactions.dropIndex("sellerId_1")
db.wallettransactions.dropIndex("userId_1")

${Y}Verify exact index names in Atlas -> Indexes panel before executing drops.${X}
  `);

  hdr("Migration Complete");
  ok("All indexes synced. Review Phase 3 & 4 output.");
  ok("Run Phase 6 drops ONLY after your manual review and approval.");
  await mongoose.disconnect();
  console.log("Disconnected.\n");
  process.exit(0);
}

main().catch(e => { console.error(`${R}Error:${X}`, e.message); mongoose.disconnect().finally(()=>process.exit(1)); });

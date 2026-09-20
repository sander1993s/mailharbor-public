import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile, mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve, join, extname} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";

// Optional real-browser smoke test. It uses a fresh profile, synthetic email fixtures,
// and mocked extension/network APIs. No Thunderbird profile or mailbox is accessed.
const enabled = process.env.MAILHARBOR_UI_TEST === "1";
const mock = String.raw`
const samples = [
  {id:1,subject:"Project review on Thursday",author:"Alex <alex@example.test>",body:"Could you review the proposal before Thursday?"},
  {id:2,subject:"Your monthly receipt",author:"Accounts <accounts@example.test>",body:"Your payment was received. This is a copy for your records."},
  {id:3,subject:"A few ideas for the weekend",author:"Studio <studio@example.test>",body:"Our monthly newsletter, with a few ideas for the weekend."}
];
const folder={id:"inbox",accountId:"account1",specialUse:["inbox"],isVirtual:false,isUnified:false};
const headers=samples.map(m=>({...m,folder,headerMessageId:m.id+"@example.test",date:new Date("2026-09-08T08:00:00Z"),size:300,read:false,flagged:false,junk:false,tags:[]}));
let requestInput;
window.messenger={
 storage:{local:{get:async()=>({settings:{origin:"https://mock.example:9443",token:"synthetic-token",accountIds:["account1"],language:"en"}})},onChanged:{addListener:()=>{}}},
 tabs:{getCurrent:async()=>({id:5})}, runtime:{openOptionsPage:async()=>{},sendMessage:async()=>({ok:true})},
 accounts:{list:async()=>[{id:"account1",name:"Business inbox",type:"imap"}]},folders:{query:async()=>[folder],get:async()=>folder},
 messages:{query:async()=>"synthetic-list",continueList:async id=>{if(id!=="synthetic-list")throw new Error("Unknown synthetic message list");return {id:null,messages:headers}},abortList:async()=>{},get:async id=>headers.find(m=>m.id===id),getFull:async id=>({contentType:"text/plain",body:samples.find(m=>m.id===id).body,decryptionStatus:"none"}),archive:async()=>{document.body.dataset.archived="true"},update:async()=>{}},
 messengerUtilities:{convertToPlainText:async text=>text}
};
window.fetch=async (url,options)=>{
 let value;
 if(url.endsWith("/status"))value={ready:true,model:"gemini-3.8-flash-high",version:"0.1.1"};
 else if(options.method==="POST"){requestInput=JSON.parse(options.body);value={id:"job1",status:"queued"};}
 else if(options.method==="DELETE")value={id:"job1",status:"cancelled"};
 else value={id:"job1",status:"completed",result:{briefing:"One message needs your attention: Alex would like feedback before Thursday. There is also a receipt to keep and a newsletter you can archive.",items:requestInput.messages.map((m,i)=>({id:m.id,summary:["Alex needs your feedback before Thursday.","Payment received. Keep this receipt for your records.","The studio's monthly newsletter."][i],priority:i===0?"high":"low",category:["action","invoice","newsletter"][i],recommendation:i===2?"archive":"keep",reason:i===2?"No action is needed.":"Worth keeping in your inbox."}))}};
 return new Response(JSON.stringify(value),{headers:{"Content-Type":"application/json"}});
};
window.addEventListener("error",event=>{document.body.dataset.uiError=event.message});
window.addEventListener("unhandledrejection",event=>{document.body.dataset.uiError=String(event.reason)});
window.addEventListener("DOMContentLoaded",()=>{
 setTimeout(()=>document.getElementById("scan").click(),100);
 setTimeout(()=>{
   const cards=document.querySelectorAll(".email");
   document.body.dataset.cardCount=cards.length;
   document.body.dataset.selectedBefore=String(document.querySelectorAll(".email input:checked").length);
   const last=cards[cards.length-1];
   if(last){last.querySelector("input").click();document.getElementById("archive").click();}
 },5000);
});
`;
test("dashboard renders and runs a synthetic briefing/review in a real browser", {skip: !enabled, timeout: 45000}, async () => {
  const root = fileURLToPath(new URL("../addon/", import.meta.url));
  const server = createServer(async (request, response) => {
    try {
      const name = new URL(request.url, "http://localhost").pathname.slice(1) || "dashboard.html";
      if (!/^[a-zA-Z0-9.-]+$/.test(name)) { response.writeHead(404).end(); return; }
      if (name === "mock.js") { response.setHeader("Content-Type", "text/javascript"); response.end(mock); return; }
      let bytes = await readFile(join(root, name));
      const types = {".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript", ".css":"text/css", ".svg":"image/svg+xml"};
      response.setHeader("Content-Type", types[extname(name)] || "application/octet-stream");
      if (name === "dashboard.html") bytes = bytes.toString().replace('<script type="module"', '<script src="mock.js"></script><script type="module"');
      response.end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  const tempBase = resolve(tmpdir());
  const profile = await mkdtemp(join(tempBase, "mailharbor-ui-"));
  try {
    const browser = process.env.MAILHARBOR_TEST_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    const args = ["--headless", "--disable-gpu", "--in-process-gpu", "--disable-software-rasterizer", "--no-first-run", "--disable-extensions", "--no-default-browser-check", `--user-data-dir=${profile}`, "--virtual-time-budget=9000", "--dump-dom", `http://127.0.0.1:${server.address().port}/dashboard.html`];
    const child = spawn(browser,args,{windowsHide:true,stdio:["ignore","pipe","pipe"],timeout:20000});
    let stdout="",stderr="";
    child.stdout.on("data",chunk=>stdout+=chunk);child.stderr.on("data",chunk=>stderr+=chunk);
    const exit = await new Promise((resolve,reject)=>{child.on("error",reject);child.on("close",resolve)});
    assert.equal(exit,0,stderr.slice(-1000));
    assert.doesNotMatch(stdout,/data-ui-error=/);
    assert.match(stdout,/data-card-count="3"/);
    assert.match(stdout,/data-selected-before="0"/);
    assert.match(stdout,/data-archived="true"/);
    assert.match(stdout,/Alex needs your feedback before Thursday/);
    assert.match(stdout,/1 email archived/);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    const resolvedProfile = resolve(profile);
    // Delete only the fresh profile generated inside the known OS temporary directory.
    if (resolvedProfile.startsWith(tempBase + "\\mailharbor-ui-") || resolvedProfile.startsWith(tempBase + "/mailharbor-ui-")) await rm(resolvedProfile,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
});

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const { URL } = require("url");

const MAX_SETUPS = 500;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function safeJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function htmlJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function viewerHtml(id, signature) {
  const boot = htmlJson({ id, signature });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="color-scheme" content="dark">
  <title>Consensus Reaper Setup</title>
  <style>
    :root { --bg:#070a0f; --panel:#0d131d; --line:#202b3a; --muted:#8492a6; --text:#f3f6fb; --green:#24d18f; --red:#ff5f6d; --blue:#4ba3ff; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:radial-gradient(circle at top,#142033 0,#070a0f 45%); color:var(--text); font:14px/1.45 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(100%,980px); margin:auto; padding:18px 14px calc(24px + env(safe-area-inset-bottom)); }
    .top { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:14px; }
    .eyebrow { color:var(--blue); font-size:11px; font-weight:800; letter-spacing:.14em; text-transform:uppercase; }
    h1 { margin:4px 0 2px; font-size:24px; line-height:1.1; }
    .sub { color:var(--muted); }
    .badge { border:1px solid var(--line); border-radius:999px; padding:7px 10px; font-weight:800; white-space:nowrap; }
    .badge.long { color:var(--green); background:rgba(36,209,143,.09); }
    .badge.short { color:var(--red); background:rgba(255,95,109,.09); }
    .chart-card { overflow:hidden; border:1px solid var(--line); border-radius:16px; background:rgba(13,19,29,.94); box-shadow:0 18px 60px rgba(0,0,0,.35); }
    .chart-head { display:flex; justify-content:space-between; gap:10px; padding:12px 14px; border-bottom:1px solid var(--line); color:var(--muted); }
    #chartWrap { position:relative; height:min(58vh,560px); min-height:360px; }
    canvas { display:block; width:100%; height:100%; }
    #loading { position:absolute; inset:0; display:grid; place-items:center; color:var(--muted); background:var(--panel); }
    .map { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-top:12px; }
    .level { border:1px solid var(--line); border-radius:13px; background:rgba(13,19,29,.9); padding:12px; }
    .level span { display:block; color:var(--muted); font-size:11px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
    .level strong { display:block; margin-top:4px; font-size:16px; }
    .level.entry strong { color:var(--blue); } .level.stop strong { color:var(--red); } .level.target strong { color:var(--green); }
    .actions { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:12px; }
    button,a.button { appearance:none; border:1px solid var(--line); border-radius:12px; padding:13px 14px; background:#121b28; color:var(--text); text-decoration:none; text-align:center; font:inherit; font-weight:800; cursor:pointer; }
    a.primary { background:var(--blue); border-color:var(--blue); color:#04101f; }
    .note { margin:12px 2px 0; color:var(--muted); font-size:12px; text-align:center; }
    .error { color:var(--red)!important; padding:22px; text-align:center; }
    @media (max-width:600px) { h1{font-size:20px}.map{grid-template-columns:1fr}.actions{grid-template-columns:1fr}#chartWrap{height:430px;min-height:330px}.chart-head{font-size:12px} }
  </style>
</head>
<body>
<main>
  <div class="top">
    <div><div class="eyebrow">Consensus Reaper</div><h1 id="title">Loading setup…</h1><div class="sub" id="subtitle">Preparing the 15m chart</div></div>
    <div class="badge" id="side">SETUP</div>
  </div>
  <section class="chart-card">
    <div class="chart-head"><span id="symbol">—</span><span id="quality">—</span></div>
    <div id="chartWrap"><canvas id="chart"></canvas><div id="loading">Loading candles and drawing the trade map…</div></div>
  </section>
  <section class="map">
    <div class="level entry"><span>Entry zone</span><strong id="entry">—</strong></div>
    <div class="level stop"><span>Invalidation</span><strong id="stop">—</strong></div>
    <div class="level target"><span>3R target</span><strong id="target">—</strong></div>
  </section>
  <section class="actions"><button id="copy">Copy values</button><a class="button primary" id="tradingview" target="_blank" rel="noopener">Open TradingView</a></section>
  <p class="note">Read-only setup viewer. Review the live market before executing any trade.</p>
</main>
<script>
const BOOT=${boot};
let DATA=null;
const $=(id)=>document.getElementById(id);
const fmt=(n)=>{ n=Number(n); if(!Number.isFinite(n))return "—"; if(Math.abs(n)<.001)return n.toFixed(8); if(Math.abs(n)<1)return n.toFixed(6); if(Math.abs(n)<100)return n.toFixed(4); return n.toFixed(2); };
function line(ctx,x1,y1,x2,y2,color,width=1,dash=[]){ctx.save();ctx.strokeStyle=color;ctx.lineWidth=width;ctx.setLineDash(dash);ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();ctx.restore();}
function draw(){
  if(!DATA)return;
  const canvas=$("chart"), box=canvas.parentElement.getBoundingClientRect(), dpr=Math.min(devicePixelRatio||1,2);
  canvas.width=Math.round(box.width*dpr); canvas.height=Math.round(box.height*dpr); const ctx=canvas.getContext("2d"); ctx.scale(dpr,dpr);
  const W=box.width,H=box.height, pad={l:10,r:82,t:20,b:30}, cw=W-pad.l-pad.r,ch=H-pad.t-pad.b;
  const candles=DATA.candles.slice(-90), s=DATA.setup;
  if(!candles.length){ctx.fillStyle="#8492a6";ctx.fillText("No candle data available",20,30);return;}
  const prices=candles.flatMap(c=>[c.low,c.high]).concat([s.entryLow,s.entryHigh,s.stop,s.target]); let lo=Math.min(...prices),hi=Math.max(...prices); const extra=(hi-lo)*.06||1;lo-=extra;hi+=extra;
  const y=p=>pad.t+(hi-p)/(hi-lo)*ch, step=cw/candles.length, body=Math.max(2,step*.62), x=i=>pad.l+(i+.5)*step;
  ctx.clearRect(0,0,W,H);ctx.fillStyle="#0d131d";ctx.fillRect(0,0,W,H);
  ctx.font="11px Inter,system-ui,sans-serif";ctx.textBaseline="middle";
  for(let i=0;i<=5;i++){const yy=pad.t+ch*i/5,p=hi-(hi-lo)*i/5;line(ctx,pad.l,yy,W-pad.r,yy,"#1b2635");ctx.fillStyle="#8492a6";ctx.fillText(fmt(p),W-pad.r+8,yy);}
  const startX=pad.l+cw*.57, endX=W-pad.r;
  const entryTop=Math.min(y(s.entryLow),y(s.entryHigh)),entryBottom=Math.max(y(s.entryLow),y(s.entryHigh));ctx.fillStyle="rgba(75,163,255,.16)";ctx.fillRect(startX,entryTop,endX-startX,Math.max(3,entryBottom-entryTop));
  const mid=(Number(s.entryLow)+Number(s.entryHigh))/2, midY=y(mid), stopY=y(s.stop), targetY=y(s.target);
  ctx.fillStyle="rgba(255,95,109,.10)";ctx.fillRect(startX,Math.min(midY,stopY),endX-startX,Math.abs(stopY-midY));
  ctx.fillStyle="rgba(36,209,143,.10)";ctx.fillRect(startX,Math.min(midY,targetY),endX-startX,Math.abs(targetY-midY));
  candles.forEach((c,i)=>{const up=c.close>=c.open,color=up?"#24d18f":"#ff5f6d",xx=x(i);line(ctx,xx,y(c.high),xx,y(c.low),color,1);ctx.fillStyle=color;const top=Math.min(y(c.open),y(c.close)),h=Math.max(1,Math.abs(y(c.close)-y(c.open)));ctx.fillRect(xx-body/2,top,body,h);});
  [[mid,"ENTRY","#4ba3ff"],[s.stop,"STOP","#ff5f6d"],[s.target,"3R TARGET","#24d18f"]].forEach(([p,label,color])=>{const yy=y(Number(p));line(ctx,startX,yy,endX,yy,color,1.4,[6,4]);ctx.fillStyle=color;ctx.font="bold 10px Inter,system-ui,sans-serif";ctx.fillText(label,startX+6,yy-8);});
  const last=candles[candles.length-1];line(ctx,pad.l,y(last.close),endX,y(last.close),"#d8e0eb",.8,[2,4]);
  ctx.fillStyle="#8492a6";ctx.font="10px Inter,system-ui,sans-serif";const marks=[0,Math.floor(candles.length/2),candles.length-1];marks.forEach(i=>{const d=new Date(candles[i].time);ctx.fillText(d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}),Math.min(x(i),endX-30),H-14);});
 }
async function load(){
 try{
  const res=await fetch("/api/setup/"+encodeURIComponent(BOOT.id)+"?sig="+encodeURIComponent(BOOT.signature),{cache:"no-store"});
  if(!res.ok)throw new Error((await res.json().catch(()=>({}))).error||"Unable to load setup"); DATA=await res.json(); const s=DATA.setup;
  $("title").textContent=s.name+" · "+s.side.toUpperCase(); $("subtitle").textContent="15m setup · 5m/15m/1h consensus"; $("side").textContent=s.side.toUpperCase(); $("side").classList.add(s.side);
  $("symbol").textContent=s.tvSymbol; $("quality").textContent=s.score+"% confidence · "+s.riskRewardRatio+":1 RR; $("entry").textContent=fmt(s.entryLow)+" – "+fmt(s.entryHigh); $("stop").textContent=fmt(s.stop); $("target").textContent=fmt(s.target);
  $("tradingview").href=s.tradingViewUrl; $("copy").onclick=async()=>{const text=s.name+" "+s.side.toUpperCase()+" | Entry "+fmt(s.entryLow)+"-"+fmt(s.entryHigh)+" | Stop "+fmt(s.stop)+" | Target "+fmt(s.target)+" ("+s.riskRewardRatio+":1)";await navigator.clipboard.writeText(text);$("copy").textContent="Copied";setTimeout(()=>$("copy").textContent="Copy values",1200);};
  $("loading").style.display="none";draw();
 }catch(e){$("loading").className="error";$("loading").textContent=e.message;}
}
addEventListener("resize",()=>requestAnimationFrame(draw));load();
</script>
</body></html>`;
}

function createSetupViewer(options) {
  const baseUrl = String(options.baseUrl || "").replace(/\/$/, "");
  const secret = String(options.secret || "");
  const host = options.host || "127.0.0.1";
  const port = options.port === undefined ? 3080 : Number(options.port);
  const setupsFile = options.setupsFile;
  const ttlMs = Number(options.ttlMs || DEFAULT_TTL_MS);
  const fetchCandles = options.fetchCandles;
  const enabled = /^https:\/\//.test(baseUrl) && secret.length >= 32;
  let server = null;

  function signatureFor(id) {
    return crypto.createHmac("sha256", secret).update(id).digest("hex");
  }

  function validSignature(id, signature) {
    if (!/^[a-f0-9]{32}$/.test(id) || !/^[a-f0-9]{64}$/.test(signature || "")) return false;
    const expected = Buffer.from(signatureFor(id), "hex");
    const received = Buffer.from(signature, "hex");
    return expected.length === received.length && crypto.timingSafeEqual(expected, received);
  }

  function readSetups() {
    const rows = safeJson(setupsFile, []);
    return Array.isArray(rows) ? rows : [];
  }

  function findSetup(id, signature) {
    if (!enabled || !validSignature(id, signature)) return null;
    const setup = readSetups().find((row) => row.id === id);
    if (!setup || Number(setup.expiresAt) <= Date.now()) return null;
    return setup;
  }

  function createSetup(signal) {
    if (!enabled) return null;
    const requiredPrices = [signal.price, signal.entryLow, signal.entryHigh, signal.stop, signal.target];
    if (!requiredPrices.every((value) => Number.isFinite(Number(value)) && Number(value) > 0)) return null;
    if (!/^(long|short)$/.test(signal.side) || !signal.symbol || !signal.tvSymbol) return null;
    const id = crypto.randomBytes(16).toString("hex");
    const now = Date.now();
    const setup = {
      id,
      createdAt: now,
      expiresAt: now + ttlMs,
      pair: { api: signal.symbol, market: signal.market, tv: signal.tvSymbol, label: signal.name },
      timeframe: "15m",
      signal: {
        name: signal.name,
        side: signal.side,
        score: signal.score,
        price: signal.price,
        entryLow: signal.entryLow,
        entryHigh: signal.entryHigh,
        stop: signal.stop,
        target: signal.target,
        riskRewardRatio: signal.riskRewardRatio,
        tvSymbol: signal.tvSymbol,
        time: signal.time,
        confirmations: signal.confirmations,
        tradingViewUrl: signal.url,
      },
    };
    const rows = readSetups().filter((row) => Number(row.expiresAt) > now);
    rows.unshift(setup);
    saveJson(setupsFile, rows.slice(0, MAX_SETUPS));
    return `${baseUrl}/setup/${id}?sig=${signatureFor(id)}`;
  }

  function sendJson(res, status, body) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(body));
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
    if (url.pathname === "/health") return sendJson(res, 200, { ok: true, viewer: enabled });
    const page = url.pathname.match(/^\/setup\/([a-f0-9]{32})$/);
    if (page) {
      const setup = findSetup(page[1], url.searchParams.get("sig"));
      if (!setup) return sendJson(res, 404, { error: "This setup link is invalid or has expired." });
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      return res.end(viewerHtml(page[1], url.searchParams.get("sig")));
    }
    const api = url.pathname.match(/^\/api\/setup\/([a-f0-9]{32})$/);
    if (api) {
      const setup = findSetup(api[1], url.searchParams.get("sig"));
      if (!setup) return sendJson(res, 404, { error: "This setup link is invalid or has expired." });
      try {
        const candles = await fetchCandles(setup.pair, setup.timeframe, 140);
        return sendJson(res, 200, { setup: setup.signal, candles });
      } catch (error) {
        return sendJson(res, 502, { error: `Could not load chart data: ${error.message}` });
      }
    }
    return sendJson(res, 404, { error: "Not found" });
  }

  function start() {
    if (!enabled || server) return Promise.resolve(null);
    server = http.createServer((req, res) => {
      handle(req, res).catch((error) => sendJson(res, 500, { error: error.message }));
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve(server.address()));
    });
  }

  function stop() {
    if (!server) return Promise.resolve();
    const current = server;
    server = null;
    if (!current.listening) return Promise.resolve();
    return new Promise((resolve, reject) => current.close((error) => error ? reject(error) : resolve()));
  }

  return { enabled, createSetup, findSetup, start, stop };
}

module.exports = { createSetupViewer };

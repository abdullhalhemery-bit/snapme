// index.ts — SnapMe: Farcaster Snap 2.0 (correct spec)
import { Hono } from "hono";
import {
  createConfession, canSubmitToday, getConfession, recordView, castVote,
  hasVoted, recordTip, getTrending, getMostSupported, getMostControversial,
  getVerdictBadge, getRealPct, getFakePct, getCountdown, findByClaimToken,
  updateCastHash, seedDemoData, WEEKLY_POOL_SHARE, APP_REVENUE_SHARE, JACKPOT_SHARE,
} from "./db.js";
import { txt, btn, vstack, hstack, bar, inp, buildSnap } from "./ui.js";

// ─── Seed demo data on start ───────────────────────────────────────────────
seedDemoData();

// ─── Config ────────────────────────────────────────────────────────────────
const SNAP_CT = "application/vnd.farcaster.snap+json";
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY ?? "";
const SIGNER_UUID = process.env.SIGNER_UUID ?? "";
const TREASURY_WALLET = process.env.TREASURY_WALLET ?? "0x0000000000000000000000000000000000000000";

function getBase(req: Request): string {
  const env = process.env.SNAP_PUBLIC_BASE_URL?.trim();
  if (env) return env.replace(/\/$/, "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3003";
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ?? "http";
  return `${proto}://${host}`;
}

function isSnap(req: Request) {
  return (req.headers.get("Accept") ?? "").includes(SNAP_CT);
}

function snapRes(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": SNAP_CT, Vary: "Accept" },
  });
}

async function getBody(req: Request) {
  try { return await req.json() as Record<string, any>; } catch { return {}; }
}

function getFid(body: Record<string, any>): number {
  return body?.untrustedData?.fid ?? body?.fid ?? 0;
}

function getInputs(body: Record<string, any>): Record<string, string> {
  return body?.untrustedData?.inputValues ?? body?.inputValues ?? {};
}

// ─── Neynar ────────────────────────────────────────────────────────────────
async function postCast(text: string): Promise<string | null> {
  if (!NEYNAR_API_KEY || !SIGNER_UUID) return null;
  try {
    const res = await fetch("https://api.neynar.com/v2/farcaster/cast", {
      method: "POST",
      headers: { "Content-Type": "application/json", "api_key": NEYNAR_API_KEY },
      body: JSON.stringify({ signer_uuid: SIGNER_UUID, text }),
    });
    const data = await res.json() as { cast: { hash: string } };
    return data.cast.hash;
  } catch { return null; }
}

// ─── App ───────────────────────────────────────────────────────────────────
const app = new Hono();

// ─── Home ──────────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  if (!isSnap(c.req.raw)) return c.html(htmlFallback());
  const base = getBase(c.req.raw);
  const items = await getTrending();

  if (items.length === 0) {
    return snapRes(buildSnap("page", {
      page: vstack("title", "sub", "cta"),
      title: txt("🤫 SnapMe", { weight: "bold" }),
      sub: txt("No confessions yet. Be the first!", { size: "sm" }),
      cta: btn("Submit a Confession", `${base}/submit`, "primary"),
    }));
  }

  const top = items[0];
  const realPct = getRealPct(top);
  const fakePct = getFakePct(top);
  const total = top.real_votes + top.fake_votes;
  const badge = getVerdictBadge(top);
  const countdown = getCountdown(top);

  return snapRes(buildSnap("page", {
    page: vstack("brand", "conf", "stats", "rl", "rb", "fl", "fb", "timer", "verdict", "actions"),
    brand: txt("🤫 SnapMe — Anonymous Confessions", { size: "sm" }),
    conf: txt(`"${top.text}"`, { weight: "bold" }),
    stats: txt(`👁 ${top.views_count}  ·  💬 ${total} votes  ·  💰 $${Number(top.total_tips_amount).toFixed(2)}`, { size: "sm" }),
    rl: txt(`✅ Real — ${realPct}%`, { size: "sm" }),
    rb: bar(realPct, 100, `${realPct}%`),
    fl: txt(`❌ Fake — ${fakePct}%`, { size: "sm" }),
    fb: bar(fakePct, 100, `${fakePct}%`),
    timer: txt(countdown, { size: "sm" }),
    verdict: txt(badge, { weight: "bold", align: "center" }),
    actions: hstack("vote-btn", "tip-btn", "more-btn"),
    "vote-btn": btn("Vote", `${base}/vote?id=${top.confession_id}`, "primary"),
    "tip-btn": btn("💰 Tip", `${base}/tip?id=${top.confession_id}`),
    "more-btn": btn("More →", `${base}/feed`, "ghost"),
  }));
});

// ─── Feed ──────────────────────────────────────────────────────────────────
app.get("/feed", async (c) => {
  if (!isSnap(c.req.raw)) return c.html(htmlFallback());
  const base = getBase(c.req.raw);
  const tab = c.req.query("tab") ?? "trending";

  let items, tabLabel;
  if (tab === "supported") { items = await getMostSupported(); tabLabel = "💰 Most Supported"; }
  else if (tab === "controversial") { items = await getMostControversial(); tabLabel = "🧢 Most Controversial"; }
  else { items = await getTrending(); tabLabel = "🔥 Trending"; }

  const top = items.slice(0, 3);
  const els: Record<string, unknown> = {
    page: vstack("brand", "tabs", ...top.flatMap((_, i) => [`c${i}`, `s${i}`, `b${i}`]), "submit-btn"),
    brand: txt(`🤫 SnapMe  ·  ${tabLabel}`, { weight: "bold" }),
    tabs: hstack("t1", "t2", "t3"),
    t1: btn("🔥", `${base}/feed?tab=trending`, tab === "trending" ? "primary" : "ghost"),
    t2: btn("💰", `${base}/feed?tab=supported`, tab === "supported" ? "primary" : "ghost"),
    t3: btn("🧢", `${base}/feed?tab=controversial`, tab === "controversial" ? "primary" : "ghost"),
    "submit-btn": btn("➕ Confess", `${base}/submit`, "primary"),
  };

  if (top.length === 0) {
    els.page = vstack("brand", "tabs", "empty", "submit-btn");
    els.empty = txt("No confessions yet in this category.", { size: "sm" });
  } else {
    top.forEach((conf, i) => {
      els[`c${i}`] = txt(`${i + 1}. "${conf.text.slice(0, 80)}${conf.text.length > 80 ? "…" : ""}"`, { size: "sm", weight: i === 0 ? "bold" : undefined });
      els[`s${i}`] = txt(`${getVerdictBadge(conf)}  ✅ ${getRealPct(conf)}%  👁 ${conf.views_count}  💰 $${Number(conf.total_tips_amount).toFixed(2)}`, { size: "sm" });
      els[`b${i}`] = btn("Open →", `${base}/confession?id=${conf.confession_id}`, "ghost");
    });
  }

  return snapRes(buildSnap("page", els));
});


// ─── Submit GET ─────────────────────────────────────────────────────────────
app.get("/submit", async (c) => {
  if (!isSnap(c.req.raw)) return c.html(htmlFallback());
  const base = getBase(c.req.raw);
  return snapRes(buildSnap("page", {
    page: vstack("title", "hint", "conf-input", "rules", "submit-btn", "cancel-btn"),
    title: txt("🤫 Submit a Confession", { weight: "bold" }),
    hint: txt("Completely anonymous. Your FID is never exposed.", { size: "sm" }),
    "conf-input": inp("confession", "Your confession", "I secretly…", 280),
    rules: txt("Max 3 per day · No hate speech · Genuine only", { size: "sm" }),
    "submit-btn": btn("Submit Anonymously", `${base}/submit`, "primary"),
    "cancel-btn": btn("Cancel", `${base}/feed`, "ghost"),
  }));
});

// ─── Submit POST ─────────────────────────────────────────────────────────────
app.post("/submit", async (c) => {
  const base = getBase(c.req.raw);
  const body = await getBody(c.req.raw);
  const fid = getFid(body);
  const inputs = getInputs(body);
  const confText = (inputs?.confession ?? "").trim();

  const errSnap = (msg: string) => snapRes(buildSnap("page", {
    page: vstack("err", "back"),
    err: txt(msg, { weight: "bold" }),
    back: btn("← Back", `${base}/submit`, "ghost"),
  }, "red"));

  if (!fid) return errSnap("❌ Could not verify your identity.");
  if (confText.length < 10) return errSnap("❌ Too short. At least 10 characters.");
  if (confText.length > 280) return errSnap("❌ Too long. Max 280 characters.");
  if (!canSubmitToday(fid)) return snapRes(buildSnap("page", {
    page: vstack("err", "sub", "back"),
    err: txt("🚫 Daily Limit Reached", { weight: "bold" }),
    sub: txt("Max 3 confessions per day.", { size: "sm" }),
    back: btn("← Feed", `${base}/feed`, "ghost"),
  }, "red"));

  let confession;
  try { confession = createConfession(fid, confText); }
  catch { return errSnap("❌ Server error. Please try again."); }

  postCast(`🤫 Anonymous Confession #${confession.confession_id.slice(0, 6)}\n\n"${confText}"\n\nVote Real or Fake 👇`)
    .then((hash) => { if (hash) updateCastHash(confession.confession_id, hash); });

  return snapRes(buildSnap("page", {
    page: vstack("success", "sub", "note", "view-btn", "feed-btn"),
    success: txt("✅ Confession Submitted!", { weight: "bold" }),
    sub: txt(`Save your claim token:\n🔑 ${confession.claim_token}`, { size: "sm" }),
    note: txt("⚠️ Shown once only. Screenshot to claim rewards.", { size: "sm" }),
    "view-btn": btn("View Confession", `${base}/confession?id=${confession.confession_id}`, "primary"),
    "feed-btn": btn("← Feed", `${base}/feed`, "ghost"),
  }, "green"));
});

// ─── Confession detail ──────────────────────────────────────────────────────
app.get("/confession", async (c) => {
  if (!isSnap(c.req.raw)) return c.html(htmlFallback());
  const base = getBase(c.req.raw);
  const id = c.req.query("id") ?? "";
  const viewerFid = parseInt(c.req.query("fid") ?? "0", 10);
  const conf = getConfession(id);

  if (!conf) return snapRes(buildSnap("page", {
    page: vstack("err", "back"),
    err: txt("❌ Confession not found.", { weight: "bold" }),
    back: btn("← Feed", `${base}/feed`, "ghost"),
  }, "red"));

  if (viewerFid) recordView(id, viewerFid);

  const realPct = getRealPct(conf);
  const fakePct = getFakePct(conf);
  const total = conf.real_votes + conf.fake_votes;
  const isOpen = conf.status === "open";

  return snapRes(buildSnap("page", {
    page: vstack("brand", "conf", "stats", "rl", "rb", "fl", "fb", "timer", "verdict", "actions", "back"),
    brand: txt("🤫 SnapMe", { size: "sm" }),
    conf: txt(`"${conf.text}"`, { weight: "bold" }),
    stats: txt(`👁 ${conf.views_count}  ·  💬 ${total} votes  ·  💰 $${Number(conf.total_tips_amount).toFixed(2)}`, { size: "sm" }),
    rl: txt(`✅ Real — ${realPct}%`, { size: "sm" }),
    rb: bar(realPct, 100, `${realPct}%`),
    fl: txt(`❌ Fake — ${fakePct}%`, { size: "sm" }),
    fb: bar(fakePct, 100, `${fakePct}%`),
    timer: txt(getCountdown(conf), { size: "sm" }),
    verdict: txt(getVerdictBadge(conf), { weight: "bold", align: "center" }),
    actions: isOpen
      ? hstack("real-btn", "fake-btn", "tip-btn")
      : hstack("closed", "tip-btn"),
    "real-btn": btn("✅ Real", `${base}/vote?id=${id}&type=real`, "primary"),
    "fake-btn": btn("❌ Fake", `${base}/vote?id=${id}&type=fake`),
    closed: txt("🔒 Voting closed", { size: "sm" }),
    "tip-btn": btn("💰 Tip", `${base}/tip?id=${id}`),
    back: btn("← Feed", `${base}/feed`, "ghost"),
  }));
});

// ─── Vote GET ───────────────────────────────────────────────────────────────
app.get("/vote", async (c) => {
  if (!isSnap(c.req.raw)) return c.html(htmlFallback());
  const base = getBase(c.req.raw);
  const id = c.req.query("id") ?? "";
  const type = c.req.query("type") as "real" | "fake" | undefined;
  const conf = getConfession(id);

  if (!conf) return snapRes(buildSnap("page", {
    page: vstack("err", "back"),
    err: txt("❌ Confession not found.", { weight: "bold" }),
    back: btn("← Feed", `${base}/feed`, "ghost"),
  }, "red"));

  return snapRes(buildSnap("page", {
    page: vstack("brand", "q", "preview", "vote-row", "back"),
    brand: txt("🤫 Cast Your Vote", { weight: "bold" }),
    q: txt("Real or Fake?", { size: "sm" }),
    preview: txt(`"${conf.text.slice(0, 120)}${conf.text.length > 120 ? "…" : ""}"`),
    "vote-row": hstack("real-btn", "fake-btn"),
    "real-btn": btn("✅ Real", `${base}/vote?id=${id}&type=real`, "primary"),
    "fake-btn": btn("❌ Fake", `${base}/vote?id=${id}&type=fake`),
    back: btn("← Cancel", `${base}/confession?id=${id}`, "ghost"),
  }));
});

// ─── Vote POST ──────────────────────────────────────────────────────────────
app.post("/vote", async (c) => {
  const base = getBase(c.req.raw);
  const url = new URL(c.req.url);
  const id = url.searchParams.get("id") ?? "";
  const type = url.searchParams.get("type") as "real" | "fake" | null;
  const body = await getBody(c.req.raw);
  const fid = getFid(body);
  const conf = getConfession(id);

  if (!fid || !conf || !type) return snapRes(buildSnap("page", {
    page: vstack("err", "back"),
    err: txt("❌ Invalid request.", { weight: "bold" }),
    back: btn("← Feed", `${base}/feed`, "ghost"),
  }, "red"));

  const result = castVote(id, fid, type);

  if (result === "already_voted") {
    const prev = hasVoted(id, fid);
    return snapRes(buildSnap("page", {
      page: vstack("title", "msg", "rb", "fb", "back"),
      title: txt("Already Voted", { weight: "bold" }),
      msg: txt(`Your vote: ${prev === "real" ? "✅ Real" : "❌ Fake"}`, { size: "sm" }),
      rb: bar(getRealPct(conf), 100, `✅ ${getRealPct(conf)}%`),
      fb: bar(getFakePct(conf), 100, `❌ ${getFakePct(conf)}%`),
      back: btn("← Back", `${base}/confession?id=${id}`, "ghost"),
    }));
  }

  if (result === "closed") return snapRes(buildSnap("page", {
    page: vstack("err", "back"),
    err: txt("🔒 Voting is closed (24h elapsed).", { weight: "bold" }),
    back: btn("← Back", `${base}/confession?id=${id}`, "ghost"),
  }, "red"));

  const updated = getConfession(id)!;
  return snapRes(buildSnap("page", {
    page: vstack("title", "your-vote", "divider", "rb", "fb", "total", "verdict", "actions"),
    title: txt("🤫 Vote Recorded!", { weight: "bold" }),
    "your-vote": txt(`Your vote: ${type === "real" ? "✅ Real" : "❌ Fake"}`, { size: "sm" }),
    divider: txt("Live Results:", { size: "sm" }),
    rb: bar(getRealPct(updated), 100, `✅ Real — ${getRealPct(updated)}%`),
    fb: bar(getFakePct(updated), 100, `❌ Fake — ${getFakePct(updated)}%`),
    total: txt(`${updated.real_votes + updated.fake_votes} total votes`, { size: "sm" }),
    verdict: txt(getVerdictBadge(updated), { weight: "bold", align: "center" }),
    actions: hstack("tip-btn", "back"),
    "tip-btn": btn("💰 Tip this", `${base}/tip?id=${id}`, "primary"),
    back: btn("← Feed", `${base}/feed`, "ghost"),
  }, "green"));
});

// ─── Tip GET ────────────────────────────────────────────────────────────────
app.get("/tip", async (c) => {
  if (!isSnap(c.req.raw)) return c.html(htmlFallback());
  const base = getBase(c.req.raw);
  const id = c.req.query("id") ?? "";
  const conf = getConfession(id);

  if (!conf) return snapRes(buildSnap("page", {
    page: vstack("err", "back"),
    err: txt("❌ Confession not found.", { weight: "bold" }),
    back: btn("← Feed", `${base}/feed`, "ghost"),
  }, "red"));

  return snapRes(buildSnap("page", {
    page: vstack("title", "sub", "preview", "amount-input", "pool-info", "confirm-btn", "back"),
    title: txt("💰 Tip This Confession", { weight: "bold" }),
    sub: txt("Tips go to the anonymous reward pool.", { size: "sm" }),
    preview: txt(`"${conf.text.slice(0, 100)}${conf.text.length > 100 ? "…" : ""}"`),
    "amount-input": inp("amount", "Amount (USDC)", "e.g. 1.00", 8),
    "pool-info": txt(`${Math.round(WEEKLY_POOL_SHARE * 100)}% Rewards · ${Math.round(APP_REVENUE_SHARE * 100)}% App · ${Math.round(JACKPOT_SHARE * 100)}% Jackpot`, { size: "sm" }),
    "confirm-btn": btn("Send Tip (USDC)", `${base}/tip?id=${id}`, "primary"),
    back: btn("← Cancel", `${base}/confession?id=${id}`, "ghost"),
  }));
});

// ─── Tip POST ────────────────────────────────────────────────────────────────
app.post("/tip", async (c) => {
  const base = getBase(c.req.raw);
  const id = new URL(c.req.url).searchParams.get("id") ?? "";
  const body = await getBody(c.req.raw);
  const fid = getFid(body);
  const inputs = getInputs(body);
  const rawAmount = parseFloat(inputs?.amount ?? "0");
  const amount = isNaN(rawAmount) || rawAmount <= 0 ? 0 : Math.round(rawAmount * 100) / 100;
  const conf = getConfession(id);

  if (!fid || amount <= 0 || !conf) return snapRes(buildSnap("page", {
    page: vstack("err", "back"),
    err: txt("❌ Invalid tip request.", { weight: "bold" }),
    back: btn("← Back", `${base}/tip?id=${id}`, "ghost"),
  }, "red"));

  recordTip(id, fid, amount);
  const newTotal = Number(conf.total_tips_amount) + amount;

  return snapRes(buildSnap("page", {
    page: vstack("title", "amount-sent", "split-info", "total", "back"),
    title: txt("💰 Tip Recorded!", { weight: "bold" }),
    "amount-sent": txt(`$${amount.toFixed(2)} USDC tip registered.`),
    "split-info": txt(`🏆 $${(amount * WEEKLY_POOL_SHARE).toFixed(2)} Rewards · 💼 $${(amount * APP_REVENUE_SHARE).toFixed(2)} App · 🎰 $${(amount * JACKPOT_SHARE).toFixed(2)} Jackpot`, { size: "sm" }),
    total: txt(`Total tips: $${newTotal.toFixed(2)} (${conf.tip_count + 1} tips)`, { size: "sm" }),
    back: btn("← Confession", `${base}/confession?id=${id}`, "ghost"),
  }, "green"));
});

// ─── Leaderboard ─────────────────────────────────────────────────────────────
app.get("/leaderboard", async (c) => {
  if (!isSnap(c.req.raw)) return c.html(htmlFallback());
  const base = getBase(c.req.raw);
  const tab = c.req.query("tab") ?? "trending";

  let items, title;
  if (tab === "supported") { items = getMostSupported(); title = "💰 Most Supported"; }
  else if (tab === "controversial") { items = getMostControversial(); title = "🧢 Most Controversial"; }
  else { items = getTrending(); title = "🔥 Trending"; }

  const medals = ["🥇", "🥈", "🥉"];
  const top = items.slice(0, 3);
  const els: Record<string, unknown> = {
    page: vstack("title", "tabs", ...top.flatMap((_, i) => [`e${i}`, `s${i}`, `ob${i}`]), "confess-btn", "back"),
    title: txt(`🤫 SnapMe  ·  ${title}`, { weight: "bold" }),
    tabs: hstack("t1", "t2", "t3"),
    t1: btn("🔥", `${base}/leaderboard?tab=trending`, tab === "trending" ? "primary" : "ghost"),
    t2: btn("💰", `${base}/leaderboard?tab=supported`, tab === "supported" ? "primary" : "ghost"),
    t3: btn("🧢", `${base}/leaderboard?tab=controversial`, tab === "controversial" ? "primary" : "ghost"),
    "confess-btn": btn("➕ Confess", `${base}/submit`, "primary"),
    back: btn("← Feed", `${base}/feed`, "ghost"),
  };

  if (top.length === 0) {
    els.page = vstack("title", "tabs", "empty", "confess-btn", "back");
    els.empty = txt("No confessions yet. Be the first!", { size: "sm" });
  } else {
    top.forEach((conf, i) => {
      els[`e${i}`] = txt(`${medals[i]} "${conf.text.slice(0, 70)}${conf.text.length > 70 ? "…" : ""}"`, { size: "sm", weight: i === 0 ? "bold" : undefined });
      els[`s${i}`] = txt(`${getVerdictBadge(conf)}  ✅ ${getRealPct(conf)}%  👁 ${conf.views_count}  💰 $${Number(conf.total_tips_amount).toFixed(2)}`, { size: "sm" });
      els[`ob${i}`] = btn("Open", `${base}/confession?id=${conf.confession_id}`, "ghost");
    });
  }

  return snapRes(buildSnap("page", els));
});

// ─── Claim GET ────────────────────────────────────────────────────────────────
app.get("/claim", async (c) => {
  if (!isSnap(c.req.raw)) return c.html(htmlFallback());
  const base = getBase(c.req.raw);
  return snapRes(buildSnap("page", {
    page: vstack("title", "sub", "token-input", "claim-btn", "back"),
    title: txt("🏆 Claim Your Reward", { weight: "bold" }),
    sub: txt("Enter your claim token from when you submitted.", { size: "sm" }),
    "token-input": inp("token", "Claim Token", "Paste token here…", 64),
    "claim-btn": btn("Check Reward", `${base}/claim`, "primary"),
    back: btn("← Feed", `${base}/feed`, "ghost"),
  }));
});

app.post("/claim", async (c) => {
  const base = getBase(c.req.raw);
  const body = await getBody(c.req.raw);
  const inputs = getInputs(body);
  const token = (inputs?.token ?? "").trim();
  const match = findByClaimToken(token);

  if (!match) return snapRes(buildSnap("page", {
    page: vstack("err", "back"),
    err: txt("❌ Token not found. Copy it exactly as shown.", { weight: "bold" }),
    back: btn("← Try again", `${base}/claim`, "ghost"),
  }, "red"));

  return snapRes(buildSnap("page", {
    page: vstack("title", "conf", "stats", "verdict", "note", "back"),
    title: txt("✅ Token Verified!", { weight: "bold" }),
    conf: txt(`"${match.text.slice(0, 100)}${match.text.length > 100 ? "…" : ""}"`),
    stats: txt(`👁 ${match.views_count} · 💬 ${match.real_votes + match.fake_votes} votes · 💰 $${Number(match.total_tips_amount).toFixed(2)}`, { size: "sm" }),
    verdict: txt(getVerdictBadge(match), { weight: "bold", align: "center" }),
    note: txt("Rewards batched weekly. Paid to your connected wallet. Fully anonymous.", { size: "sm" }),
    back: btn("← Feed", `${base}/feed`, "ghost"),
  }, "green"));
});

// ─── HTML Fallback ─────────────────────────────────────────────────────────────
function htmlFallback(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="alternate" type="application/vnd.farcaster.snap+json" href="https://snapmx-4ruw32fay-obobhemyariis-projects.vercel.app/" />
  <title>SnapMe — Anonymous Confessions on Farcaster</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0d0d0f; color: #f4f4f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem; }
    .card { max-width: 480px; width: 100%; background: #18181c; border: 1px solid #27272a; border-radius: 1.5rem; padding: 3rem 2.5rem; text-align: center; }
    .icon { font-size: 3.5rem; margin-bottom: 1.5rem; display: block; }
    h1 { font-size: 2rem; font-weight: 800; margin-bottom: 0.75rem; }
    p { color: #71717a; line-height: 1.6; margin-bottom: 1rem; }
    .pill { display: inline-block; background: linear-gradient(135deg,#7c3aed,#a855f7); color: white; border-radius: 9999px; padding: 0.5rem 1.5rem; font-size: 0.875rem; font-weight: 700; margin-top: 1rem; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin: 1.5rem 0; text-align: left; }
    .feat { background: rgba(168,85,247,0.08); border: 1px solid rgba(168,85,247,0.2); border-radius: 0.75rem; padding: 1rem; font-size: 0.875rem; }
    .feat strong { color: #f4f4f5; display: block; } .feat span { color: #71717a; }
  </style>
</head>
<body>
  <div class="card">
    <span class="icon">🤫</span>
    <h1>SnapMe</h1>
    <p>Anonymous confessions on Farcaster.</p>
  </div>
</body>
</html>`;
}
export default app;

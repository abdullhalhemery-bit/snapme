// index.ts — SnapMe: Full server with Neynar + Supabase
import { Hono } from "hono";

import {
  createConfession,
  canSubmitToday,
  getConfession,
  recordView,
  castVote,
  hasVoted,
  recordTip,
  getTrending,
  getMostSupported,
  getMostControversial,
  getVerdictBadge,
  getRealPct,
  getFakePct,
  getCountdown,
  findByClaimToken,
  updateCastHash,
  WEEKLY_POOL_SHARE,
  APP_REVENUE_SHARE,
  JACKPOT_SHARE,
} from "./db.js";
import { text, button, stack, progress, input, buildSnap } from "./ui.js";

// ─── Config ────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? "3003", 10);
const SNAP_CONTENT_TYPE = "application/vnd.farcaster.snap+json";
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY!;
const SIGNER_UUID = process.env.SIGNER_UUID!;
const TREASURY_WALLET = process.env.TREASURY_WALLET!;

// ─── Neynar: Post cast ─────────────────────────────────────────────────────
async function postCastViaNeynar(text: string, parentHash?: string): Promise<string | null> {
  try {
    const body: Record<string, unknown> = {
      signer_uuid: SIGNER_UUID,
      text,
    };
    if (parentHash) body.parent = parentHash;

    const res = await fetch("https://api.neynar.com/v2/farcaster/cast", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api_key": NEYNAR_API_KEY,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error("Neynar cast error:", await res.text());
      return null;
    }

    const data = await res.json() as { cast: { hash: string } };
    return data.cast.hash;
  } catch (err) {
    console.error("Neynar cast failed:", err);
    return null;
  }
}

// ─── Neynar: Verify FID (optional Neynar score check) ─────────────────────
async function getFidScore(fid: number): Promise<number> {
  try {
    const res = await fetch(`https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`, {
      headers: { "api_key": NEYNAR_API_KEY },
    });
    const data = await res.json() as { users: { score?: number }[] };
    return data.users?.[0]?.score ?? 0;
  } catch {
    return 0;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function getBase(req: Request): string {
  const env = process.env.SNAP_PUBLIC_BASE_URL?.trim();
  if (env) return env.replace(/\/$/, "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? `localhost:${PORT}`;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ?? "http";
  return `${proto}://${host}`;
}

function isSnapRequest(req: Request): boolean {
  return (req.headers.get("Accept") ?? "").includes(SNAP_CONTENT_TYPE);
}

function snapResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": SNAP_CONTENT_TYPE, Vary: "Accept" },
  });
}

function errSnap(base: string, msg: string, backUrl: string) {
  return buildSnap({
    page: stack(["err", "back"]),
    err: text(msg, { weight: "bold" }),
    back: button("← Back", "submit", backUrl, { variant: "ghost" }),
  }, "page", "red");
}

// ─── App ───────────────────────────────────────────────────────────────────
const app = new Hono();

// ─── Home Feed ─────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  if (!isSnapRequest(c.req.raw)) return c.html(htmlFallback());

  const base = getBase(c.req.raw);
  const confessions = await getTrending();

  if (confessions.length === 0) {
    return snapResponse(buildSnap({
      page: stack(["title", "sub", "cta"]),
      title: text("🤫 SnapMe", { weight: "bold", size: "lg" }),
      sub: text("No confessions yet. Be the first to confess anonymously.", { size: "sm" }),
      cta: button("Submit a Confession", "submit", `${base}/submit`, { variant: "primary" }),
    }, "page", "purple"));
  }

  const top = confessions[0];
  const realPct = getRealPct(top);
  const fakePct = getFakePct(top);
  const total = top.real_votes + top.fake_votes;
  const badge = getVerdictBadge(top);
  const countdown = getCountdown(top);

  return snapResponse(buildSnap({
    page: stack(["brand", "confession-text", "stats-row", "vote-bars", "timer", "verdict", "action-row"]),
    brand: text("🤫 SnapMe — Anonymous Confessions", { size: "sm" }),
    "confession-text": text(`"${top.text}"`, { weight: "bold" }),
    "stats-row": text(`👁 ${top.views_count} views · 💬 ${total} votes · 💰 $${Number(top.total_tips_amount).toFixed(2)} tipped`, { size: "sm" }),
    "vote-bars": stack(["real-label", "real-bar", "fake-label", "fake-bar"]),
    "real-label": text(`✅ Real — ${realPct}%`, { size: "sm" }),
    "real-bar": progress(realPct, 100, `${realPct}%`),
    "fake-label": text(`❌ Fake — ${fakePct}%`, { size: "sm" }),
    "fake-bar": progress(fakePct, 100, `${fakePct}%`),
    timer: text(countdown, { size: "sm" }),
    verdict: text(badge, { weight: "bold", align: "center" }),
    "action-row": stack(["vote-btn", "tip-btn", "more-btn"], "horizontal"),
    "vote-btn": button("Vote", "submit", `${base}/vote?id=${top.confession_id}`, { variant: "primary" }),
    "tip-btn": button("💰 Tip", "submit", `${base}/tip?id=${top.confession_id}`),
    "more-btn": button("More →", "submit", `${base}/feed`, { variant: "ghost" }),
  }, "page", "purple"));
});

// ─── Feed ──────────────────────────────────────────────────────────────────
app.get("/feed", async (c) => {
  if (!isSnapRequest(c.req.raw)) return c.html(htmlFallback());

  const base = getBase(c.req.raw);
  const tab = c.req.query("tab") ?? "trending";

  let items;
  let tabLabel;
  if (tab === "supported") { items = await getMostSupported(); tabLabel = "💰 Most Supported"; }
  else if (tab === "controversial") { items = await getMostControversial(); tabLabel = "🧢 Most Controversial"; }
  else { items = await getTrending(); tabLabel = "🔥 Trending"; }

  const top = items.slice(0, 3);
  const elements: Record<string, any> = {
    page: stack([
      "brand", "tab-row",
      ...top.flatMap((_, i) => [`conf-${i}`, `stats-${i}`, `vote-btn-${i}`]),
      "submit-btn",
    ]),
    brand: text(`🤫 SnapMe  ·  ${tabLabel}`, { weight: "bold" }),
    "tab-row": stack(["tab-trending", "tab-supported", "tab-controversial"], "horizontal"),
    "tab-trending": button("🔥", "submit", `${base}/feed?tab=trending`, { variant: tab === "trending" ? "primary" : "ghost" }),
    "tab-supported": button("💰", "submit", `${base}/feed?tab=supported`, { variant: tab === "supported" ? "primary" : "ghost" }),
    "tab-controversial": button("🧢", "submit", `${base}/feed?tab=controversial`, { variant: tab === "controversial" ? "primary" : "ghost" }),
    "submit-btn": button("➕ Confess", "submit", `${base}/submit`, { variant: "primary" }),
  };

  top.forEach((conf, i) => {
    const realPct = getRealPct(conf);
    const badge = getVerdictBadge(conf);
    elements[`conf-${i}`] = text(`${i + 1}. "${conf.text.slice(0, 80)}${conf.text.length > 80 ? "…" : ""}"`, { weight: i === 0 ? "bold" : "normal", size: "sm" });
    elements[`stats-${i}`] = text(`${badge}  ·  👁 ${conf.views_count}  ·  ✅ ${realPct}%  ·  💰 $${Number(conf.total_tips_amount).toFixed(2)}`, { size: "sm" });
    elements[`vote-btn-${i}`] = button("Open →", "submit", `${base}/confession?id=${conf.confession_id}`, { variant: "ghost" });
  });

  if (top.length === 0) {
    elements.page = stack(["brand", "tab-row", "empty", "submit-btn"]);
    elements.empty = text("No confessions yet in this category.", { size: "sm" });
  }

  return snapResponse(buildSnap(elements, "page", "purple"));
});

// ─── Submit Form ────────────────────────────────────────────────────────────
app.get("/submit", async (c) => {
  if (!isSnapRequest(c.req.raw)) return c.html(htmlFallback());
  const base = getBase(c.req.raw);

  return snapResponse(buildSnap({
    page: stack(["title", "hint", "confession-input", "rules", "submit-btn", "cancel-btn"]),
    title: text("🤫 Submit a Confession", { weight: "bold" }),
    hint: text("Completely anonymous. Your FID is never exposed.", { size: "sm" }),
    "confession-input": input("confession", "Your confession", "I secretly...", 280),
    rules: text("Max 3 per day · No hate speech · Genuine only", { size: "sm" }),
    "submit-btn": button("Submit Anonymously", "submit", `${base}/submit`, { variant: "primary" }),
    "cancel-btn": button("Cancel", "submit", `${base}/feed`, { variant: "ghost" }),
  }, "page", "purple"));
});

// ─── Submit POST ────────────────────────────────────────────────────────────
app.post("/submit", async (c) => {
  const base = getBase(c.req.raw);
  const body = await c.req.json().catch(() => ({}));
  const fid: number = body?.untrustedData?.fid ?? body?.fid ?? 0;
  const inputs = body?.untrustedData?.inputValues ?? body?.inputValues ?? {};
  const confessionText: string = (inputs?.confession ?? "").trim();

  if (!fid) return snapResponse(errSnap(base, "❌ Could not verify your identity.", `${base}/submit`));
  if (!confessionText || confessionText.length < 10) return snapResponse(errSnap(base, "❌ Too short. Write at least 10 characters.", `${base}/submit`));
  if (confessionText.length > 280) return snapResponse(errSnap(base, "❌ Too long. Max 280 characters.", `${base}/submit`));

  const canSubmit = await canSubmitToday(fid);
  if (!canSubmit) {
    return snapResponse(buildSnap({
      page: stack(["err", "sub", "back"]),
      err: text("🚫 Daily Limit Reached", { weight: "bold" }),
      sub: text("Max 3 confessions per day. Come back tomorrow.", { size: "sm" }),
      back: button("← Feed", "submit", `${base}/feed`, { variant: "ghost" }),
    }, "page", "red"));
  }

  let confession;
  try {
    confession = await createConfession(fid, confessionText);
  } catch (err) {
    console.error("DB error:", err);
    return snapResponse(errSnap(base, "❌ Server error. Please try again.", `${base}/submit`));
  }

  // Post cast via Neynar (fire and forget)
  postCastViaNeynar(`🤫 Anonymous Confession #${confession.confession_id.slice(0, 6)}\n\n"${confessionText}"\n\nVote Real or Fake 👇`)
    .then((hash) => {
      if (hash) updateCastHash(confession.confession_id, hash);
    });

  return snapResponse(buildSnap({
    page: stack(["success", "sub", "token-note", "view-btn", "feed-btn"]),
    success: text("✅ Confession Submitted!", { weight: "bold" }),
    sub: text(`Your confession is live. Save your claim token:\n\n🔑 ${confession.claim_token}`, { size: "sm" }),
    "token-note": text("⚠️ Shown once only. Screenshot to claim future rewards.", { size: "sm" }),
    "view-btn": button("View Confession", "submit", `${base}/confession?id=${confession.confession_id}`, { variant: "primary" }),
    "feed-btn": button("← Feed", "submit", `${base}/feed`, { variant: "ghost" }),
  }, "page", "green"));
});

// ─── Confession Detail ──────────────────────────────────────────────────────
app.get("/confession", async (c) => {
  if (!isSnapRequest(c.req.raw)) return c.html(htmlFallback());

  const base = getBase(c.req.raw);
  const id = c.req.query("id") ?? "";
  const viewerFid = parseInt(c.req.query("fid") ?? "0", 10);

  const conf = await getConfession(id);
  if (!conf) return snapResponse(errSnap(base, "❌ Confession not found.", `${base}/feed`));

  if (viewerFid) recordView(id, viewerFid);

  const realPct = getRealPct(conf);
  const fakePct = getFakePct(conf);
  const total = conf.real_votes + conf.fake_votes;
  const badge = getVerdictBadge(conf);
  const countdown = getCountdown(conf);
  const isOpen = conf.status === "open";

  const elements: Record<string, any> = {
    page: stack(["brand", "conf-text", "stats", "real-label", "real-bar", "fake-label", "fake-bar", "timer", "verdict", "action-row", "back"]),
    brand: text("🤫 SnapMe", { size: "sm" }),
    "conf-text": text(`"${conf.text}"`, { weight: "bold" }),
    stats: text(`👁 ${conf.views_count}  ·  💬 ${total} votes  ·  💰 $${Number(conf.total_tips_amount).toFixed(2)}`, { size: "sm" }),
    "real-label": text(`✅ Real — ${realPct}%`, { size: "sm" }),
    "real-bar": progress(realPct, 100, `${realPct}%`),
    "fake-label": text(`❌ Fake — ${fakePct}%`, { size: "sm" }),
    "fake-bar": progress(fakePct, 100, `${fakePct}%`),
    timer: text(countdown, { size: "sm" }),
    verdict: text(badge, { weight: "bold", align: "center" }),
    "action-row": stack(["vote-real-btn", "vote-fake-btn", "tip-btn"], "horizontal"),
    "vote-real-btn": isOpen ? button("✅ Real", "submit", `${base}/vote?id=${id}&type=real`, { variant: "primary" }) : text("🔒 Voting closed", { size: "sm" }),
    "vote-fake-btn": isOpen ? button("❌ Fake", "submit", `${base}/vote?id=${id}&type=fake`) : text("", {}),
    "tip-btn": button("💰 Tip", "submit", `${base}/tip?id=${id}`),
    back: button("← Feed", "submit", `${base}/feed`, { variant: "ghost" }),
  };

  return snapResponse(buildSnap(elements, "page", "purple"));
});

// ─── Vote POST ─────────────────────────────────────────────────────────────
app.post("/vote", async (c) => {
  const base = getBase(c.req.raw);
  const url = new URL(c.req.url);
  const id = url.searchParams.get("id") ?? "";
  const typeParam = url.searchParams.get("type") as "real" | "fake" | null;

  const body = await c.req.json().catch(() => ({}));
  const fid: number = body?.untrustedData?.fid ?? body?.fid ?? 0;

  if (!fid) return snapResponse(errSnap(base, "❌ Could not verify identity.", `${base}/confession?id=${id}`));

  const conf = await getConfession(id);
  if (!conf) return snapResponse(errSnap(base, "❌ Confession not found.", `${base}/feed`));

  if (!typeParam) {
    const prevVote = await hasVoted(id, fid);
    if (prevVote) {
      return snapResponse(buildSnap({
        page: stack(["title", "msg", "real-bar", "fake-bar", "back"]),
        title: text("Already Voted", { weight: "bold" }),
        msg: text(`Your vote: ${prevVote === "real" ? "✅ Real" : "❌ Fake"}`, { size: "sm" }),
        "real-bar": progress(getRealPct(conf), 100, `✅ ${getRealPct(conf)}%`),
        "fake-bar": progress(getFakePct(conf), 100, `❌ ${getFakePct(conf)}%`),
        back: button("← Back", "submit", `${base}/confession?id=${id}`, { variant: "ghost" }),
      }, "page", "purple"));
    }
    return snapResponse(buildSnap({
      page: stack(["brand", "question", "preview", "vote-row", "back"]),
      brand: text("🤫 Cast Your Vote", { weight: "bold" }),
      question: text("Real or Fake?", { size: "sm" }),
      preview: text(`"${conf.text.slice(0, 120)}${conf.text.length > 120 ? "…" : ""}"`),
      "vote-row": stack(["real-btn", "fake-btn"], "horizontal"),
      "real-btn": button("✅ Real", "submit", `${base}/vote?id=${id}&type=real`, { variant: "primary" }),
      "fake-btn": button("❌ Fake", "submit", `${base}/vote?id=${id}&type=fake`),
      back: button("← Cancel", "submit", `${base}/confession?id=${id}`, { variant: "ghost" }),
    }, "page", "purple"));
  }

  const result = await castVote(id, fid, typeParam);

  if (result === "already_voted") {
    return snapResponse(buildSnap({
      page: stack(["title", "msg", "real-bar", "fake-bar", "back"]),
      title: text("Already Voted", { weight: "bold" }),
      msg: text("You already voted on this confession.", { size: "sm" }),
      "real-bar": progress(getRealPct(conf), 100, `✅ ${getRealPct(conf)}%`),
      "fake-bar": progress(getFakePct(conf), 100, `❌ ${getFakePct(conf)}%`),
      back: button("← Back", "submit", `${base}/confession?id=${id}`, { variant: "ghost" }),
    }, "page", "purple"));
  }

  if (result === "closed") {
    return snapResponse(errSnap(base, "🔒 Voting is closed (24h elapsed).", `${base}/confession?id=${id}`));
  }

  const updated = await getConfession(id);
  if (!updated) return snapResponse(errSnap(base, "❌ Error loading results.", `${base}/feed`));

  const realPct = getRealPct(updated);
  const fakePct = getFakePct(updated);
  const total = updated.real_votes + updated.fake_votes;
  const badge = getVerdictBadge(updated);

  return snapResponse(buildSnap({
    page: stack(["title", "your-vote", "divider-t", "real-bar", "fake-bar", "total", "verdict", "action-row"]),
    title: text("🤫 Vote Recorded!", { weight: "bold" }),
    "your-vote": text(`Your vote: ${typeParam === "real" ? "✅ Real" : "❌ Fake"}`, { size: "sm" }),
    "divider-t": text("Live Results:", { size: "sm" }),
    "real-bar": progress(realPct, 100, `✅ Real — ${realPct}%`),
    "fake-bar": progress(fakePct, 100, `❌ Fake — ${fakePct}%`),
    total: text(`${total} total votes`, { size: "sm" }),
    verdict: text(badge, { weight: "bold", align: "center" }),
    "action-row": stack(["tip-btn", "back"], "horizontal"),
    "tip-btn": button("💰 Tip this", "submit", `${base}/tip?id=${id}`, { variant: "primary" }),
    back: button("← Feed", "submit", `${base}/feed`, { variant: "ghost" }),
  }, "page", "green"));
});

// ─── Tip Form ───────────────────────────────────────────────────────────────
app.get("/tip", async (c) => {
  if (!isSnapRequest(c.req.raw)) return c.html(htmlFallback());
  const base = getBase(c.req.raw);
  const id = c.req.query("id") ?? "";
  const conf = await getConfession(id);
  if (!conf) return snapResponse(errSnap(base, "❌ Confession not found.", `${base}/feed`));

  return snapResponse(buildSnap({
    page: stack(["title", "sub", "preview", "amount-input", "treasury-info", "pool-info", "confirm-btn", "back"]),
    title: text("💰 Tip This Confession", { weight: "bold" }),
    sub: text("Tips go to the anonymous reward pool. Author identity is never revealed.", { size: "sm" }),
    preview: text(`"${conf.text.slice(0, 100)}${conf.text.length > 100 ? "…" : ""}"`),
    "amount-input": { type: "input", props: { name: "amount", label: "Amount (USDC)", placeholder: "e.g. 1.00", maxLength: 8 } },
    "treasury-info": text(`Treasury: ${TREASURY_WALLET.slice(0, 10)}...${TREASURY_WALLET.slice(-6)}`, { size: "sm" }),
    "pool-info": text(`${Math.round(WEEKLY_POOL_SHARE * 100)}% Rewards · ${Math.round(APP_REVENUE_SHARE * 100)}% App · ${Math.round(JACKPOT_SHARE * 100)}% Jackpot`, { size: "sm" }),
    "confirm-btn": button("Send Tip (USDC)", "submit", `${base}/tip?id=${id}`, { variant: "primary" }),
    back: button("← Cancel", "submit", `${base}/confession?id=${id}`, { variant: "ghost" }),
  }, "page", "purple"));
});

// ─── Tip POST ───────────────────────────────────────────────────────────────
app.post("/tip", async (c) => {
  const base = getBase(c.req.raw);
  const id = new URL(c.req.url).searchParams.get("id") ?? "";
  const body = await c.req.json().catch(() => ({}));
  const fid: number = body?.untrustedData?.fid ?? body?.fid ?? 0;
  const inputs = body?.untrustedData?.inputValues ?? body?.inputValues ?? {};
  const rawAmount = parseFloat(inputs?.amount ?? "0");
  const amount = isNaN(rawAmount) || rawAmount <= 0 ? 0 : Math.round(rawAmount * 100) / 100;

  if (!fid) return snapResponse(errSnap(base, "❌ Could not verify identity.", `${base}/tip?id=${id}`));
  if (amount <= 0) return snapResponse(errSnap(base, "❌ Enter a valid amount (e.g. 1.00).", `${base}/tip?id=${id}`));

  const conf = await getConfession(id);
  if (!conf) return snapResponse(errSnap(base, "❌ Confession not found.", `${base}/feed`));

  // Record tip in DB (actual USDC transfer happens via Farcaster Wallet in client)
  await recordTip(id, fid, amount);

  const weeklyPool = amount * WEEKLY_POOL_SHARE;
  const appRevenue = amount * APP_REVENUE_SHARE;
  const jackpot = amount * JACKPOT_SHARE;
  const newTotal = Number(conf.total_tips_amount) + amount;

  return snapResponse(buildSnap({
    page: stack(["title", "amount-sent", "split-info", "updated-total", "leaderboard-btn", "back"]),
    title: text("💰 Tip Recorded!", { weight: "bold" }),
    "amount-sent": text(`$${amount.toFixed(2)} USDC tip registered.`, {}),
    "split-info": text(`🏆 $${weeklyPool.toFixed(2)} Rewards · 💼 $${appRevenue.toFixed(2)} App · 🎰 $${jackpot.toFixed(2)} Jackpot`, { size: "sm" }),
    "updated-total": text(`Total tips: $${newTotal.toFixed(2)} (${conf.tip_count + 1} tips)`, { size: "sm" }),
    "leaderboard-btn": button("🏆 Leaderboard", "submit", `${base}/leaderboard`, { variant: "primary" }),
    back: button("← Confession", "submit", `${base}/confession?id=${id}`, { variant: "ghost" }),
  }, "page", "green"));
});

// ─── Leaderboard ────────────────────────────────────────────────────────────
app.get("/leaderboard", async (c) => {
  if (!isSnapRequest(c.req.raw)) return c.html(htmlFallback());
  const base = getBase(c.req.raw);
  const tab = c.req.query("tab") ?? "trending";

  let items, title;
  if (tab === "supported") { items = await getMostSupported(); title = "💰 Most Supported"; }
  else if (tab === "controversial") { items = await getMostControversial(); title = "🧢 Most Controversial"; }
  else { items = await getTrending(); title = "🔥 Trending"; }

  const medals = ["🥇", "🥈", "🥉"];
  const top = items.slice(0, 3);

  const elements: Record<string, any> = {
    page: stack([
      "title", "tab-row",
      ...top.flatMap((_, i) => [`entry-${i}`, `stats-${i}`, `btn-${i}`]),
      "confess-btn", "back",
    ]),
    title: text(`🤫 SnapMe  ·  ${title}`, { weight: "bold" }),
    "tab-row": stack(["t1", "t2", "t3"], "horizontal"),
    t1: button("🔥", "submit", `${base}/leaderboard?tab=trending`, { variant: tab === "trending" ? "primary" : "ghost" }),
    t2: button("💰", "submit", `${base}/leaderboard?tab=supported`, { variant: tab === "supported" ? "primary" : "ghost" }),
    t3: button("🧢", "submit", `${base}/leaderboard?tab=controversial`, { variant: tab === "controversial" ? "primary" : "ghost" }),
    "confess-btn": button("➕ Confess", "submit", `${base}/submit`, { variant: "primary" }),
    back: button("← Feed", "submit", `${base}/feed`, { variant: "ghost" }),
  };

  top.forEach((conf, i) => {
    elements[`entry-${i}`] = text(`${medals[i] ?? `${i + 1}.`} "${conf.text.slice(0, 70)}${conf.text.length > 70 ? "…" : ""}"`, { weight: i === 0 ? "bold" : "normal", size: "sm" });
    elements[`stats-${i}`] = text(`${getVerdictBadge(conf)}  ✅ ${getRealPct(conf)}%  👁 ${conf.views_count}  💰 $${Number(conf.total_tips_amount).toFixed(2)}`, { size: "sm" });
    elements[`btn-${i}`] = button("Open", "submit", `${base}/confession?id=${conf.confession_id}`, { variant: "ghost" });
  });

  if (top.length === 0) {
    elements.page = stack(["title", "tab-row", "empty", "confess-btn", "back"]);
    elements.empty = text("No confessions yet. Be the first!", { size: "sm" });
  }

  return snapResponse(buildSnap(elements, "page", "purple"));
});

// ─── Claim Token ────────────────────────────────────────────────────────────
app.get("/claim", async (c) => {
  if (!isSnapRequest(c.req.raw)) return c.html(htmlFallback());
  const base = getBase(c.req.raw);

  return snapResponse(buildSnap({
    page: stack(["title", "sub", "token-input", "claim-btn", "back"]),
    title: text("🏆 Claim Your Reward", { weight: "bold" }),
    sub: text("Enter your claim token from when you submitted. Rewards paid weekly to preserve anonymity.", { size: "sm" }),
    "token-input": { type: "input", props: { name: "token", label: "Claim Token", placeholder: "Paste token here…", maxLength: 64 } },
    "claim-btn": button("Check Reward", "submit", `${base}/claim`, { variant: "primary" }),
    back: button("← Feed", "submit", `${base}/feed`, { variant: "ghost" }),
  }, "page", "purple"));
});

app.post("/claim", async (c) => {
  const base = getBase(c.req.raw);
  const body = await c.req.json().catch(() => ({}));
  const inputs = body?.untrustedData?.inputValues ?? body?.inputValues ?? {};
  const token: string = (inputs?.token ?? "").trim();

  const match = await findByClaimToken(token);
  if (!match) {
    return snapResponse(errSnap(base, "❌ Token not found. Copy it exactly as shown at submission.", `${base}/claim`));
  }

  const realPct = getRealPct(match);
  const badge = getVerdictBadge(match);
  const total = match.real_votes + match.fake_votes;

  return snapResponse(buildSnap({
    page: stack(["title", "conf-text", "stats", "verdict", "payout-note", "back"]),
    title: text("✅ Token Verified!", { weight: "bold" }),
    "conf-text": text(`"${match.text.slice(0, 100)}${match.text.length > 100 ? "…" : ""}"`),
    stats: text(`👁 ${match.views_count} · 💬 ${total} votes · 💰 $${Number(match.total_tips_amount).toFixed(2)}`, { size: "sm" }),
    verdict: text(badge, { weight: "bold", align: "center" }),
    "payout-note": text("Rewards batched weekly. Paid to wallet connected to your Farcaster account. Fully anonymous.", { size: "sm" }),
    back: button("← Feed", "submit", `${base}/feed`, { variant: "ghost" }),
  }, "page", "green"));
});

// ─── HTML Fallback ──────────────────────────────────────────────────────────
function htmlFallback(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SnapMe — Anonymous Confessions on Farcaster</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Syne', sans-serif; background: #0d0d0f; color: #f4f4f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem; }
    .card { max-width: 480px; width: 100%; background: #18181c; border: 1px solid #27272a; border-radius: 1.5rem; padding: 3rem 2.5rem; text-align: center; }
    .icon { font-size: 3.5rem; margin-bottom: 1.5rem; display: block; }
    h1 { font-size: 2rem; font-weight: 800; margin-bottom: 0.75rem; }
    p { color: #71717a; line-height: 1.6; margin-bottom: 2rem; }
    .pill { display: inline-block; background: linear-gradient(135deg, #7c3aed, #a855f7); color: white; border-radius: 9999px; padding: 0.5rem 1.5rem; font-size: 0.875rem; font-weight: 700; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin: 2rem 0; text-align: left; }
    .feat { background: rgba(168,85,247,0.08); border: 1px solid rgba(168,85,247,0.2); border-radius: 0.75rem; padding: 1rem; font-size: 0.875rem; }
    .feat strong { color: #f4f4f5; display: block; } .feat span { color: #71717a; }
  </style>
</head>
<body>
  <div class="card">
    <span class="icon">🤫</span>
    <h1>SnapMe</h1>
    <p>Anonymous confessions on Farcaster. Vote Real or Fake. Tip your favorites. Earn from the weekly reward pool.</p>
    <div class="grid">
      <div class="feat"><strong>🔐 100% Anonymous</strong><span>Your identity is never revealed</span></div>
      <div class="feat"><strong>🗳 Real or Fake?</strong><span>Community votes each confession</span></div>
      <div class="feat"><strong>💰 Tip & Earn</strong><span>Support great confessions</span></div>
      <div class="feat"><strong>🏆 Weekly Rewards</strong><span>Top confessions earn from pool</span></div>
    </div>
    <p style="font-size:0.875rem">Open this URL in a Farcaster client to use the Snap.</p>
    <span class="pill">Open in Farcaster</span>
  </div>
</body>
</html>`;
}


// ─── Export for Vercel serverless ──────────────────────────────────────────
export default app;

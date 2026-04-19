// index.ts — SnapMe: Anonymous Confession Snap for Farcaster
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import {
  createConfession,
  canSubmitToday,
  getConfession,
  getAllConfessions,
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
  seedDemoData,
  WEEKLY_POOL_SHARE,
  APP_REVENUE_SHARE,
  JACKPOT_SHARE,
} from "./db.js";
import { text, button, stack, progress, input, buildSnap } from "./ui.js";

// ─── Config ────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? "3003", 10);
const SNAP_CONTENT_TYPE = "application/vnd.farcaster.snap+json";

function getBase(req: Request): string {
  const env = process.env.SNAP_PUBLIC_BASE_URL?.trim();
  if (env) return env.replace(/\/$/, "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? `localhost:${PORT}`;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ?? "http";
  return `${proto}://${host}`;
}

// ─── App ───────────────────────────────────────────────────────────────────
const app = new Hono();

// Seed demo data on startup
seedDemoData();

// ─── Snap content negotiation middleware ───────────────────────────────────
function isSnapRequest(req: Request): boolean {
  return (req.headers.get("Accept") ?? "").includes(SNAP_CONTENT_TYPE);
}

function snapResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": SNAP_CONTENT_TYPE,
      Vary: "Accept",
    },
  });
}

// ─── Parse FID from verified message (Farcaster client sends signed POST) ──
async function getFidFromContext(c: any): Promise<number> {
  // In production the Farcaster client sends a signed message body.
  // For the emulator / dev, SKIP_JFS_VERIFICATION=1 is set.
  try {
    const body = await c.req.json().catch(() => ({}));
    return body?.untrustedData?.fid ?? body?.fid ?? 0;
  } catch {
    return 0;
  }
}

// ─── Home Feed (GET /) ──────────────────────────────────────────────────────
app.get("/", async (c) => {
  if (!isSnapRequest(c.req.raw)) return c.html(htmlFallback());

  const base = getBase(c.req.raw);
  const confessions = getTrending().slice(0, 1); // Show latest top confession on feed card

  if (confessions.length === 0) {
    // Empty state
    const snap = buildSnap(
      {
        page: stack(["title", "sub", "cta"]),
        title: text("SnapMe 🤫", { weight: "bold", size: "lg" }),
        sub: text("No confessions yet. Be the first to confess anonymously.", { size: "sm" }),
        cta: button("Submit a Confession", "submit", `${base}/?action=submit_form`, { variant: "primary" }),
      },
      "page",
      "purple"
    );
    return snapResponse(snap);
  }

  const top = confessions[0];
  const realPct = getRealPct(top);
  const fakePct = getFakePct(top);
  const total = top.real_votes + top.fake_votes;
  const badge = getVerdictBadge(top);
  const countdown = getCountdown(top);

  const snap = buildSnap(
    {
      page: stack(["brand", "confession-text", "stats-row", "vote-bars", "timer", "verdict", "action-row"]),

      brand: text("🤫 SnapMe — Anonymous Confessions", { size: "sm" }),
      "confession-text": text(`"${top.text}"`, { weight: "bold" }),

      "stats-row": text(
        `👁 ${top.views_count} views · 💬 ${total} votes · 💰 $${top.total_tips_amount.toFixed(2)} tipped`,
        { size: "sm" }
      ),

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
    },
    "page",
    "purple"
  );

  return snapResponse(snap);
});

// ─── Submit Confession Form (GET /submit) ──────────────────────────────────
app.get("/submit", async (c) => {
  if (!isSnapRequest(c.req.raw)) return c.html(htmlFallback());

  const base = getBase(c.req.raw);

  const snap = buildSnap(
    {
      page: stack(["title", "hint", "confession-input", "rules", "submit-btn", "cancel-btn"]),
      title: text("🤫 Submit a Confession", { weight: "bold" }),
      hint: text("Completely anonymous. Your FID is never exposed.", { size: "sm" }),
      "confession-input": input("confession", "Your confession", "I secretly...", 280),
      rules: text("Max 3 submissions per day · Must be genuine · No hate speech", { size: "sm" }),
      "submit-btn": button("Submit Anonymously", "submit", `${base}/submit`, { variant: "primary" }),
      "cancel-btn": button("Cancel", "submit", `${base}/feed`, { variant: "ghost" }),
    },
    "page",
    "purple"
  );

  return snapResponse(snap);
});

// ─── Submit Confession (POST /submit) ──────────────────────────────────────
app.post("/submit", async (c) => {
  const base = getBase(c.req.raw);
  const body = await c.req.json().catch(() => ({}));
  const fid: number = body?.untrustedData?.fid ?? body?.fid ?? 0;
  const inputs = body?.untrustedData?.inputValues ?? body?.inputValues ?? {};
  const confessionText: string = (inputs?.confession ?? "").trim();

  // Validations
  if (!fid) {
    return snapResponse(
      buildSnap(
        {
          page: stack(["err", "back"]),
          err: text("❌ Could not verify your identity. Please try again.", { weight: "bold" }),
          back: button("← Back", "submit", `${base}/feed`, { variant: "ghost" }),
        },
        "page",
        "red"
      )
    );
  }

  if (!confessionText || confessionText.length < 10) {
    return snapResponse(
      buildSnap(
        {
          page: stack(["err", "back"]),
          err: text("❌ Confession is too short. Write at least 10 characters.", { weight: "bold" }),
          back: button("Try again", "submit", `${base}/submit`, { variant: "primary" }),
        },
        "page",
        "red"
      )
    );
  }

  if (confessionText.length > 280) {
    return snapResponse(
      buildSnap(
        {
          page: stack(["err", "back"]),
          err: text("❌ Confession is too long. Max 280 characters.", { weight: "bold" }),
          back: button("Try again", "submit", `${base}/submit`, { variant: "primary" }),
        },
        "page",
        "red"
      )
    );
  }

  if (!canSubmitToday(fid)) {
    return snapResponse(
      buildSnap(
        {
          page: stack(["err", "sub", "back"]),
          err: text("🚫 Daily Limit Reached", { weight: "bold" }),
          sub: text("You can submit a maximum of 3 confessions per day. Come back tomorrow.", { size: "sm" }),
          back: button("← Feed", "submit", `${base}/feed`, { variant: "ghost" }),
        },
        "page",
        "red"
      )
    );
  }

  const confession = createConfession(fid, confessionText);

  // In production: post confession as cast via Developer signer here
  // await postCastFromAppAccount(confession.text, threadHash);

  return snapResponse(
    buildSnap(
      {
        page: stack(["success", "sub", "token-note", "view-btn", "feed-btn"]),
        success: text("✅ Confession Submitted!", { weight: "bold" }),
        sub: text(
          `Your confession has been posted anonymously. Save your claim token to collect rewards:\n\n🔑 ${confession.claim_token}`,
          { size: "sm" }
        ),
        "token-note": text("⚠️ This token is shown once. Screenshot it to claim future rewards.", { size: "sm" }),
        "view-btn": button("View My Confession", "submit", `${base}/confession?id=${confession.confession_id}`, {
          variant: "primary",
        }),
        "feed-btn": button("← Back to Feed", "submit", `${base}/feed`, { variant: "ghost" }),
      },
      "page",
      "green"
    )
  );
});

// ─── Feed (GET /feed) ──────────────────────────────────────────────────────
app.get("/feed", async (c) => {
  if (!isSnapRequest(c.req.raw)) return c.html(htmlFallback());

  const base = getBase(c.req.raw);
  const tab = c.req.query("tab") ?? "trending";

  let items;
  let tabLabel;
  if (tab === "supported") {
    items = getMostSupported();
    tabLabel = "💰 Most Supported";
  } else if (tab === "controversial") {
    items = getMostControversial();
    tabLabel = "🧢 Most Controversial";
  } else {
    items = getTrending();
    tabLabel = "🔥 Trending";
  }

  const topItems = items.slice(0, 3);

  const elements: Record<string, any> = {
    page: stack([
      "brand",
      "tab-row",
      ...topItems.flatMap((c, i) => [
        `conf-${i}`,
        `stats-${i}`,
        `vote-btn-${i}`,
      ]),
      "submit-btn",
    ]),
    brand: text(`🤫 SnapMe  ·  ${tabLabel}`, { weight: "bold" }),
    "tab-row": stack(["tab-trending", "tab-supported", "tab-controversial"], "horizontal"),
    "tab-trending": button("🔥", "submit", `${base}/feed?tab=trending`, {
      variant: tab === "trending" ? "primary" : "ghost",
    }),
    "tab-supported": button("💰", "submit", `${base}/feed?tab=supported`, {
      variant: tab === "supported" ? "primary" : "ghost",
    }),
    "tab-controversial": button("🧢", "submit", `${base}/feed?tab=controversial`, {
      variant: tab === "controversial" ? "primary" : "ghost",
    }),
    "submit-btn": button("➕ Confess", "submit", `${base}/submit`, { variant: "primary" }),
  };

  topItems.forEach((conf, i) => {
    const realPct = getRealPct(conf);
    const badge = getVerdictBadge(conf);
    elements[`conf-${i}`] = text(
      `${i + 1}. "${conf.text.slice(0, 80)}${conf.text.length > 80 ? "…" : ""}"`,
      { weight: i === 0 ? "bold" : "normal", size: "sm" }
    );
    elements[`stats-${i}`] = text(
      `${badge}  ·  👁 ${conf.views_count}  ·  ✅ ${realPct}%  ·  💰 $${conf.total_tips_amount.toFixed(2)}`,
      { size: "sm" }
    );
    elements[`vote-btn-${i}`] = button(
      "Open →",
      "submit",
      `${base}/confession?id=${conf.confession_id}`,
      { variant: "ghost" }
    );
  });

  if (topItems.length === 0) {
    elements.page = stack(["brand", "tab-row", "empty", "submit-btn"]);
    elements.empty = text("No confessions yet in this category.", { size: "sm" });
  }

  return snapResponse(buildSnap(elements, "page", "purple"));
});

// ─── Confession Detail (GET /confession) ──────────────────────────────────
app.get("/confession", async (c) => {
  if (!isSnapRequest(c.req.raw)) return c.html(htmlFallback());

  const base = getBase(c.req.raw);
  const id = c.req.query("id") ?? "";
  const viewerFid = parseInt(c.req.query("fid") ?? "0", 10);

  const conf = getConfession(id);
  if (!conf) {
    return snapResponse(
      buildSnap(
        {
          page: stack(["err", "back"]),
          err: text("❌ Confession not found.", { weight: "bold" }),
          back: button("← Feed", "submit", `${base}/feed`, { variant: "ghost" }),
        },
        "page",
        "red"
      )
    );
  }

  if (viewerFid) recordView(id, viewerFid);

  const realPct = getRealPct(conf);
  const fakePct = getFakePct(conf);
  const total = conf.real_votes + conf.fake_votes;
  const badge = getVerdictBadge(conf);
  const countdown = getCountdown(conf);
  const isOpen = conf.status === "open";

  const elements: Record<string, any> = {
    page: stack([
      "brand",
      "text",
      "stats",
      "real-label", "real-bar",
      "fake-label", "fake-bar",
      "timer",
      "verdict",
      "action-row",
      "back",
    ]),
    brand: text("🤫 SnapMe", { size: "sm" }),
    text: text(`"${conf.text}"`, { weight: "bold" }),
    stats: text(
      `👁 ${conf.views_count} views  ·  💬 ${total} votes  ·  💰 $${conf.total_tips_amount.toFixed(2)} tipped`,
      { size: "sm" }
    ),
    "real-label": text(`✅ Real — ${realPct}%`, { size: "sm" }),
    "real-bar": progress(realPct, 100, `${realPct}%`),
    "fake-label": text(`❌ Fake — ${fakePct}%`, { size: "sm" }),
    "fake-bar": progress(fakePct, 100, `${fakePct}%`),
    timer: text(countdown, { size: "sm" }),
    verdict: text(badge, { weight: "bold", align: "center" }),
    "action-row": stack(["vote-real-btn", "vote-fake-btn", "tip-btn"], "horizontal"),
    "vote-real-btn": isOpen
      ? button("✅ Real", "submit", `${base}/vote?id=${id}&type=real`, { variant: "primary" })
      : text("Voting closed", { size: "sm" }),
    "vote-fake-btn": isOpen
      ? button("❌ Fake", "submit", `${base}/vote?id=${id}&type=fake`)
      : text("", {}),
    "tip-btn": button("💰 Tip", "submit", `${base}/tip?id=${id}`),
    back: button("← Feed", "submit", `${base}/feed`, { variant: "ghost" }),
  };

  if (!isOpen) {
    elements["action-row"] = stack(["closed-note", "tip-btn", "back"], "horizontal");
    elements["closed-note"] = text("🔒 Voting closed", { size: "sm" });
  }

  return snapResponse(buildSnap(elements, "page", "purple"));
});

// ─── Vote (POST /vote) ─────────────────────────────────────────────────────
app.post("/vote", async (c) => {
  const base = getBase(c.req.raw);
  const id = new URL(c.req.url).searchParams.get("id") ?? "";
  const typeParam = new URL(c.req.url).searchParams.get("type") as "real" | "fake" | null;

  const body = await c.req.json().catch(() => ({}));
  const fid: number = body?.untrustedData?.fid ?? body?.fid ?? 0;

  if (!fid) {
    return snapResponse(buildSnap({
      page: stack(["err", "back"]),
      err: text("❌ Could not verify identity.", { weight: "bold" }),
      back: button("← Back", "submit", `${base}/confession?id=${id}`, { variant: "ghost" }),
    }, "page", "red"));
  }

  const conf = getConfession(id);
  if (!conf) {
    return snapResponse(buildSnap({
      page: stack(["err", "back"]),
      err: text("❌ Confession not found.", { weight: "bold" }),
      back: button("← Feed", "submit", `${base}/feed`, { variant: "ghost" }),
    }, "page", "red"));
  }

  // If no type from URL param, show vote UI
  if (!typeParam) {
    const prevVote = hasVoted(id, fid);
    if (prevVote) {
      const realPct = getRealPct(conf);
      const fakePct = getFakePct(conf);
      return snapResponse(buildSnap({
        page: stack(["title", "voted-msg", "real-bar", "fake-bar", "back"]),
        title: text("🤫 SnapMe", { size: "sm" }),
        "voted-msg": text(`You voted: ${prevVote === "real" ? "✅ Real" : "❌ Fake"}`, { weight: "bold" }),
        "real-bar": progress(realPct, 100, `✅ Real ${realPct}%`),
        "fake-bar": progress(fakePct, 100, `❌ Fake ${fakePct}%`),
        back: button("← Confession", "submit", `${base}/confession?id=${id}`, { variant: "ghost" }),
      }, "page", "purple"));
    }

    return snapResponse(buildSnap({
      page: stack(["brand", "question", "text-preview", "vote-row", "back"]),
      brand: text("🤫 SnapMe — Cast Your Vote", { weight: "bold" }),
      question: text("Is this confession Real or Fake?", { size: "sm" }),
      "text-preview": text(`"${conf.text.slice(0, 120)}${conf.text.length > 120 ? "…" : ""}"`, {}),
      "vote-row": stack(["real-btn", "fake-btn"], "horizontal"),
      "real-btn": button("✅ Real", "submit", `${base}/vote?id=${id}&type=real`, { variant: "primary" }),
      "fake-btn": button("❌ Fake", "submit", `${base}/vote?id=${id}&type=fake`),
      back: button("← Cancel", "submit", `${base}/confession?id=${id}`, { variant: "ghost" }),
    }, "page", "purple"));
  }

  const result = castVote(id, fid, typeParam);

  if (result === "already_voted") {
    const existing = hasVoted(id, fid);
    const realPct = getRealPct(conf);
    const fakePct = getFakePct(conf);
    return snapResponse(buildSnap({
      page: stack(["title", "msg", "real-bar", "fake-bar", "back"]),
      title: text("Already Voted", { weight: "bold" }),
      msg: text(`You already voted: ${existing === "real" ? "✅ Real" : "❌ Fake"}`, { size: "sm" }),
      "real-bar": progress(realPct, 100, `✅ ${realPct}%`),
      "fake-bar": progress(fakePct, 100, `❌ ${fakePct}%`),
      back: button("← Confession", "submit", `${base}/confession?id=${id}`, { variant: "ghost" }),
    }, "page", "purple"));
  }

  if (result === "closed") {
    return snapResponse(buildSnap({
      page: stack(["msg", "back"]),
      msg: text("🔒 Voting is closed for this confession (24h elapsed).", { weight: "bold" }),
      back: button("← Confession", "submit", `${base}/confession?id=${id}`, { variant: "ghost" }),
    }, "page", "red"));
  }

  // Success — show updated results
  const updatedConf = getConfession(id)!;
  const realPct = getRealPct(updatedConf);
  const fakePct = getFakePct(updatedConf);
  const total = updatedConf.real_votes + updatedConf.fake_votes;
  const badge = getVerdictBadge(updatedConf);

  return snapResponse(buildSnap({
    page: stack(["title", "your-vote", "divider-text", "real-bar", "fake-bar", "total", "verdict", "action-row"]),
    title: text("🤫 SnapMe — Vote Recorded!", { weight: "bold" }),
    "your-vote": text(`Your vote: ${typeParam === "real" ? "✅ Real" : "❌ Fake"}`, { size: "sm" }),
    "divider-text": text("Live Results:", { size: "sm" }),
    "real-bar": progress(realPct, 100, `✅ Real — ${realPct}%`),
    "fake-bar": progress(fakePct, 100, `❌ Fake — ${fakePct}%`),
    total: text(`${total} total votes`, { size: "sm" }),
    verdict: text(badge, { weight: "bold", align: "center" }),
    "action-row": stack(["tip-btn", "back"], "horizontal"),
    "tip-btn": button("💰 Tip this", "submit", `${base}/tip?id=${id}`, { variant: "primary" }),
    back: button("← Feed", "submit", `${base}/feed`, { variant: "ghost" }),
  }, "page", "green"));
});

// ─── Tip Form (GET /tip) ───────────────────────────────────────────────────
app.get("/tip", async (c) => {
  if (!isSnapRequest(c.req.raw)) return c.html(htmlFallback());

  const base = getBase(c.req.raw);
  const id = c.req.query("id") ?? "";
  const conf = getConfession(id);

  if (!conf) {
    return snapResponse(buildSnap({
      page: stack(["err", "back"]),
      err: text("❌ Confession not found.", { weight: "bold" }),
      back: button("← Feed", "submit", `${base}/feed`, { variant: "ghost" }),
    }, "page", "red"));
  }

  return snapResponse(buildSnap({
    page: stack(["title", "sub", "confession-preview", "amount-input", "pool-info", "confirm-btn", "back"]),
    title: text("💰 Tip This Confession", { weight: "bold" }),
    sub: text("Tips go to the anonymous reward pool. Author identity is never revealed.", { size: "sm" }),
    "confession-preview": text(`"${conf.text.slice(0, 100)}${conf.text.length > 100 ? "…" : ""}"`, {}),
    "amount-input": {
      type: "input",
      props: { name: "amount", label: "Amount (USDC)", placeholder: "e.g. 1.00", maxLength: 8 },
    },
    "pool-info": text(
      `Split: ${Math.round(WEEKLY_POOL_SHARE * 100)}% Weekly Rewards · ${Math.round(APP_REVENUE_SHARE * 100)}% App · ${Math.round(JACKPOT_SHARE * 100)}% Jackpot`,
      { size: "sm" }
    ),
    "confirm-btn": button("Send Tip (USDC)", "submit", `${base}/tip?id=${id}`, { variant: "primary" }),
    back: button("← Cancel", "submit", `${base}/confession?id=${id}`, { variant: "ghost" }),
  }, "page", "purple"));
});

// ─── Tip Submit (POST /tip) ────────────────────────────────────────────────
app.post("/tip", async (c) => {
  const base = getBase(c.req.raw);
  const id = new URL(c.req.url).searchParams.get("id") ?? "";

  const body = await c.req.json().catch(() => ({}));
  const fid: number = body?.untrustedData?.fid ?? body?.fid ?? 0;
  const inputs = body?.untrustedData?.inputValues ?? body?.inputValues ?? {};
  const rawAmount = parseFloat(inputs?.amount ?? "0");
  const amount = isNaN(rawAmount) || rawAmount <= 0 ? 0 : Math.round(rawAmount * 100) / 100;

  if (!fid) {
    return snapResponse(buildSnap({
      page: stack(["err", "back"]),
      err: text("❌ Could not verify identity.", { weight: "bold" }),
      back: button("← Back", "submit", `${base}/tip?id=${id}`, { variant: "ghost" }),
    }, "page", "red"));
  }

  if (amount <= 0) {
    return snapResponse(buildSnap({
      page: stack(["err", "back"]),
      err: text("❌ Please enter a valid tip amount (e.g. 1.00).", { weight: "bold" }),
      back: button("← Try Again", "submit", `${base}/tip?id=${id}`, { variant: "primary" }),
    }, "page", "red"));
  }

  const conf = getConfession(id);
  if (!conf) {
    return snapResponse(buildSnap({
      page: stack(["err", "back"]),
      err: text("❌ Confession not found.", { weight: "bold" }),
      back: button("← Feed", "submit", `${base}/feed`, { variant: "ghost" }),
    }, "page", "red"));
  }

  // In production: execute Farcaster wallet USDC transaction here
  // await executeFarcasterWalletTip(fid, TREASURY_WALLET, amount);

  recordTip(id, fid, amount);

  const weeklyPool = amount * WEEKLY_POOL_SHARE;
  const appRevenue = amount * APP_REVENUE_SHARE;
  const jackpot = amount * JACKPOT_SHARE;

  return snapResponse(buildSnap({
    page: stack(["title", "amount-sent", "split-info", "updated-total", "leaderboard-btn", "back"]),
    title: text("💰 Tip Sent!", { weight: "bold" }),
    "amount-sent": text(`$${amount.toFixed(2)} USDC sent to the anonymous reward pool.`, {}),
    "split-info": text(
      `🏆 $${weeklyPool.toFixed(2)} → Rewards Pool\n💼 $${appRevenue.toFixed(2)} → App\n🎰 $${jackpot.toFixed(2)} → Jackpot`,
      { size: "sm" }
    ),
    "updated-total": text(`Total tips for this confession: $${conf.total_tips_amount.toFixed(2)} (${conf.tip_count} tips)`, { size: "sm" }),
    "leaderboard-btn": button("🏆 Leaderboard", "submit", `${base}/leaderboard`, { variant: "primary" }),
    back: button("← Confession", "submit", `${base}/confession?id=${id}`, { variant: "ghost" }),
  }, "page", "green"));
});

// ─── Leaderboard (GET /leaderboard) ───────────────────────────────────────
app.get("/leaderboard", async (c) => {
  if (!isSnapRequest(c.req.raw)) return c.html(htmlFallback());

  const base = getBase(c.req.raw);
  const tab = c.req.query("tab") ?? "trending";

  let items;
  let title;
  if (tab === "supported") {
    items = getMostSupported();
    title = "💰 Most Supported";
  } else if (tab === "controversial") {
    items = getMostControversial();
    title = "🧢 Most Controversial";
  } else {
    items = getTrending();
    title = "🔥 Trending Confessions";
  }

  const medals = ["🥇", "🥈", "🥉"];
  const top = items.slice(0, 3);

  const elements: Record<string, any> = {
    page: stack([
      "title",
      "tab-row",
      ...top.flatMap((_, i) => [`entry-${i}`, `entry-stats-${i}`, `entry-btn-${i}`]),
      "confess-btn",
      "back",
    ]),
    title: text(`🤫 SnapMe  ·  ${title}`, { weight: "bold" }),
    "tab-row": stack(["t1", "t2", "t3"], "horizontal"),
    t1: button("🔥", "submit", `${base}/leaderboard?tab=trending`, {
      variant: tab === "trending" ? "primary" : "ghost",
    }),
    t2: button("💰", "submit", `${base}/leaderboard?tab=supported`, {
      variant: tab === "supported" ? "primary" : "ghost",
    }),
    t3: button("🧢", "submit", `${base}/leaderboard?tab=controversial`, {
      variant: tab === "controversial" ? "primary" : "ghost",
    }),
    "confess-btn": button("➕ Confess", "submit", `${base}/submit`, { variant: "primary" }),
    back: button("← Feed", "submit", `${base}/feed`, { variant: "ghost" }),
  };

  top.forEach((conf, i) => {
    const realPct = getRealPct(conf);
    const badge = getVerdictBadge(conf);
    elements[`entry-${i}`] = text(
      `${medals[i] ?? `${i + 1}.`} "${conf.text.slice(0, 70)}${conf.text.length > 70 ? "…" : ""}"`,
      { weight: i === 0 ? "bold" : "normal", size: "sm" }
    );
    elements[`entry-stats-${i}`] = text(
      `${badge}  ✅ ${realPct}%  👁 ${conf.views_count}  💰 $${conf.total_tips_amount.toFixed(2)}`,
      { size: "sm" }
    );
    elements[`entry-btn-${i}`] = button("Open", "submit", `${base}/confession?id=${conf.confession_id}`, {
      variant: "ghost",
    });
  });

  if (top.length === 0) {
    elements.page = stack(["title", "tab-row", "empty", "confess-btn", "back"]);
    elements.empty = text("No confessions here yet. Be the first!", { size: "sm" });
  }

  return snapResponse(buildSnap(elements, "page", "purple"));
});

// ─── Claim Reward Form (GET /claim) ───────────────────────────────────────
app.get("/claim", async (c) => {
  if (!isSnapRequest(c.req.raw)) return c.html(htmlFallback());

  const base = getBase(c.req.raw);

  return snapResponse(buildSnap({
    page: stack(["title", "sub", "token-input", "claim-btn", "back"]),
    title: text("🏆 Claim Your Reward", { weight: "bold" }),
    sub: text(
      "Enter the claim token shown when you submitted your confession. Rewards are distributed weekly to preserve anonymity.",
      { size: "sm" }
    ),
    "token-input": { type: "input", props: { name: "token", label: "Claim Token", placeholder: "Paste your token here…", maxLength: 64 } },
    "claim-btn": button("Check Reward", "submit", `${base}/claim`, { variant: "primary" }),
    back: button("← Feed", "submit", `${base}/feed`, { variant: "ghost" }),
  }, "page", "purple"));
});

// ─── Claim Reward Submit (POST /claim) ────────────────────────────────────
app.post("/claim", async (c) => {
  const base = getBase(c.req.raw);
  const body = await c.req.json().catch(() => ({}));
  const inputs = body?.untrustedData?.inputValues ?? body?.inputValues ?? {};
  const token: string = (inputs?.token ?? "").trim();

  const all = getAllConfessions();
  const match = all.find((c) => c.claim_token === token);

  if (!match) {
    return snapResponse(buildSnap({
      page: stack(["err", "sub", "back"]),
      err: text("❌ Token not found.", { weight: "bold" }),
      sub: text("Make sure you copied the token exactly as shown after submission.", { size: "sm" }),
      back: button("← Try Again", "submit", `${base}/claim`, { variant: "primary" }),
    }, "page", "red"));
  }

  const realPct = getRealPct(match);
  const badge = getVerdictBadge(match);
  const total = match.real_votes + match.fake_votes;

  return snapResponse(buildSnap({
    page: stack(["title", "confession-text", "stats", "verdict", "payout-note", "back"]),
    title: text("✅ Token Verified!", { weight: "bold" }),
    "confession-text": text(`"${match.text.slice(0, 100)}${match.text.length > 100 ? "…" : ""}"`, {}),
    stats: text(`👁 ${match.views_count} views · 💬 ${total} votes · 💰 $${match.total_tips_amount.toFixed(2)} tipped`, { size: "sm" }),
    verdict: text(badge, { weight: "bold", align: "center" }),
    "payout-note": text(
      "Rewards are batched weekly and paid to the wallet connected to your Farcaster account. Payouts preserve full anonymity.",
      { size: "sm" }
    ),
    back: button("← Feed", "submit", `${base}/feed`, { variant: "ghost" }),
  }, "page", "green"));
});

// ─── About / Help (GET /about) ─────────────────────────────────────────────
app.get("/about", async (c) => {
  if (!isSnapRequest(c.req.raw)) return c.html(htmlFallback());

  const base = getBase(c.req.raw);

  return snapResponse(buildSnap({
    page: stack(["title", "desc", "rules-header", "rules", "token-header", "token-info", "cta", "back"]),
    title: text("🤫 SnapMe — How It Works", { weight: "bold" }),
    desc: text("Submit confessions anonymously. The community votes Real or Fake. Top confessions earn from the weekly reward pool.", { size: "sm" }),
    "rules-header": text("Rules", { weight: "bold" }),
    rules: text(
      "• Max 3 confessions per day\n• One vote per FID per confession\n• Voting closes after 24 hours\n• 70% Real → 🔥 REAL · 70% Fake → 🧢 CAP · Otherwise → 🤨 Controversial",
      { size: "sm" }
    ),
    "token-header": text("Claim Tokens", { weight: "bold" }),
    "token-info": text("You receive a unique claim token when you submit. Save it — it proves your confession for reward claiming. It's shown once.", { size: "sm" }),
    cta: button("Submit a Confession", "submit", `${base}/submit`, { variant: "primary" }),
    back: button("← Feed", "submit", `${base}/feed`, { variant: "ghost" }),
  }, "page", "purple"));
});

// ─── HTML Fallback ─────────────────────────────────────────────────────────
function htmlFallback(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SnapMe — Anonymous Confessions on Farcaster</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=DM+Mono:wght@400;500&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0d0d0f;
      --surface: #18181c;
      --accent: #a855f7;
      --accent2: #7c3aed;
      --text: #f4f4f5;
      --muted: #71717a;
      --border: #27272a;
    }
    body {
      font-family: 'Syne', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .card {
      max-width: 480px;
      width: 100%;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 1.5rem;
      padding: 3rem 2.5rem;
      text-align: center;
    }
    .icon { font-size: 3.5rem; margin-bottom: 1.5rem; display: block; }
    h1 { font-size: 2rem; font-weight: 800; margin-bottom: 0.75rem; letter-spacing: -0.03em; }
    p { color: var(--muted); line-height: 1.6; margin-bottom: 2rem; }
    .pill {
      display: inline-block;
      background: linear-gradient(135deg, var(--accent2), var(--accent));
      color: white;
      border-radius: 9999px;
      padding: 0.5rem 1.5rem;
      font-size: 0.875rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .features {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
      margin: 2rem 0;
      text-align: left;
    }
    .feature {
      background: rgba(168,85,247,0.08);
      border: 1px solid rgba(168,85,247,0.2);
      border-radius: 0.75rem;
      padding: 1rem;
      font-size: 0.875rem;
    }
    .feature .emoji { font-size: 1.25rem; display: block; margin-bottom: 0.25rem; }
    .feature strong { color: var(--text); display: block; }
    .feature span { color: var(--muted); }
  </style>
</head>
<body>
  <div class="card">
    <span class="icon">🤫</span>
    <h1>SnapMe</h1>
    <p>Anonymous confessions on Farcaster. Vote Real or Fake. Tip your favorites. Earn from the weekly reward pool.</p>
    <div class="features">
      <div class="feature"><span class="emoji">🔐</span><strong>100% Anonymous</strong><span>Your identity is never revealed</span></div>
      <div class="feature"><span class="emoji">🗳</span><strong>Real or Fake?</strong><span>Community votes on each confession</span></div>
      <div class="feature"><span class="emoji">💰</span><strong>Tip & Earn</strong><span>Support great confessions</span></div>
      <div class="feature"><span class="emoji">🏆</span><strong>Weekly Rewards</strong><span>Top confessions earn from the pool</span></div>
    </div>
    <p style="margin-bottom: 1rem; color: var(--muted); font-size: 0.875rem;">Open this URL in a Farcaster client to use the Snap.</p>
    <span class="pill">Open in Farcaster</span>
  </div>
</body>
</html>`;
}

// ─── Start server ──────────────────────────────────────────────────────────
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`🤫 SnapMe running at http://localhost:${info.port}`);
  console.log(`   Test: curl -sS -H 'Accept: application/vnd.farcaster.snap+json' http://localhost:${info.port}/`);
});

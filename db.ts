// db.ts — In-memory store
import { v4 as uuidv4 } from "uuid";

export interface Confession {
  confession_id: string;
  text: string;
  timestamp: number;
  cast_hash?: string;
  real_votes: number;
  fake_votes: number;
  views_count: number;
  total_tips_amount: number;
  tip_count: number;
  status: "open" | "closed";
  submission_fid: number;
  claim_token: string;
}

export interface Vote {
  confession_id: string;
  voter_fid: number;
  vote_type: "real" | "fake";
  timestamp: number;
}

export interface Tip {
  confession_id: string;
  tipper_fid: number;
  amount: number;
  timestamp: number;
}

const confessions = new Map<string, Confession>();
const votes = new Map<string, Vote>();
const tips: Tip[] = [];
const views = new Set<string>();
const dailySubmissions = new Map<string, number>();

export const WEEKLY_POOL_SHARE = 0.7;
export const APP_REVENUE_SHARE = 0.2;
export const JACKPOT_SHARE = 0.1;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getEngagementScore(c: Confession): number {
  return c.real_votes + c.fake_votes + c.total_tips_amount * 10;
}

export function getVerdictBadge(c: Confession): string {
  const total = c.real_votes + c.fake_votes;
  if (total === 0) return "🤷 No votes yet";
  const realPct = (c.real_votes / total) * 100;
  if (realPct >= 70) return "🔥 REAL";
  if (realPct <= 30) return "🧢 CAP";
  return "🤨 Controversial";
}

export function getRealPct(c: Confession): number {
  const total = c.real_votes + c.fake_votes;
  if (total === 0) return 0;
  return Math.round((c.real_votes / total) * 100);
}

export function getFakePct(c: Confession): number {
  const total = c.real_votes + c.fake_votes;
  if (total === 0) return 0;
  return Math.round((c.fake_votes / total) * 100);
}

export function getControversyScore(c: Confession): number {
  const total = c.real_votes + c.fake_votes;
  if (total === 0) return 0;
  const realPct = (c.real_votes / total) * 100;
  return 100 - Math.abs(realPct - 50) * 2;
}

export function getCountdown(c: Confession): string {
  const elapsed = Date.now() - c.timestamp;
  const remaining = 24 * 60 * 60 * 1000 - elapsed;
  if (remaining <= 0) return "Voting closed";
  const h = Math.floor(remaining / 3600000);
  const m = Math.floor((remaining % 3600000) / 60000);
  return `${h}h ${m}m left`;
}

export function createConfession(fid: number, text: string): Confession {
  const id = uuidv4();
  const confession: Confession = {
    confession_id: id,
    text,
    timestamp: Date.now(),
    real_votes: 0,
    fake_votes: 0,
    views_count: 0,
    total_tips_amount: 0,
    tip_count: 0,
    status: "open",
    submission_fid: fid,
    claim_token: uuidv4().replace(/-/g, ""),
  };
  confessions.set(id, confession);
  const key = `${fid}:${todayStr()}`;
  dailySubmissions.set(key, (dailySubmissions.get(key) ?? 0) + 1);
  return confession;
}

export function canSubmitToday(fid: number): boolean {
  const key = `${fid}:${todayStr()}`;
  return (dailySubmissions.get(key) ?? 0) < 3;
}

export function getConfession(id: string): Confession | null {
  return confessions.get(id) ?? null;
}

export function getAllConfessions(): Confession[] {
  for (const [, c] of confessions) {
    if (c.status === "open" && Date.now() - c.timestamp > 24 * 60 * 60 * 1000) {
      c.status = "closed";
    }
  }
  return Array.from(confessions.values());
}

export function recordView(confessionId: string, viewerFid: number): boolean {
  const key = `${confessionId}:${viewerFid}`;
  if (views.has(key)) return false;
  views.add(key);
  const c = confessions.get(confessionId);
  if (c) c.views_count++;
  return true;
}

export function castVote(
  confessionId: string,
  voterFid: number,
  voteType: "real" | "fake"
): "ok" | "already_voted" | "closed" | "not_found" {
  const c = confessions.get(confessionId);
  if (!c) return "not_found";
  if (c.status === "closed" || Date.now() - c.timestamp > 24 * 60 * 60 * 1000) {
    c.status = "closed";
    return "closed";
  }
  const key = `${confessionId}:${voterFid}`;
  if (votes.has(key)) return "already_voted";
  votes.set(key, { confession_id: confessionId, voter_fid: voterFid, vote_type: voteType, timestamp: Date.now() });
  if (voteType === "real") c.real_votes++;
  else c.fake_votes++;
  return "ok";
}

export function hasVoted(confessionId: string, voterFid: number): "real" | "fake" | null {
  return votes.get(`${confessionId}:${voterFid}`)?.vote_type ?? null;
}

export function recordTip(confessionId: string, tipperFid: number, amount: number): boolean {
  const c = confessions.get(confessionId);
  if (!c) return false;
  tips.push({ confession_id: confessionId, tipper_fid: tipperFid, amount, timestamp: Date.now() });
  c.total_tips_amount += amount;
  c.tip_count++;
  return true;
}

export function findByClaimToken(token: string): Confession | null {
  for (const c of confessions.values()) {
    if (c.claim_token === token) return c;
  }
  return null;
}

export function updateCastHash(confessionId: string, hash: string): void {
  const c = confessions.get(confessionId);
  if (c) c.cast_hash = hash;
}

export function getTrending(): Confession[] {
  return getAllConfessions().sort((a, b) => getEngagementScore(b) - getEngagementScore(a)).slice(0, 10);
}

export function getMostSupported(): Confession[] {
  return getAllConfessions().sort((a, b) => b.total_tips_amount - a.total_tips_amount).slice(0, 10);
}

export function getMostControversial(): Confession[] {
  return getAllConfessions()
    .filter((c) => c.real_votes + c.fake_votes > 0)
    .sort((a, b) => getControversyScore(b) - getControversyScore(a))
    .slice(0, 10);
}

let seeded = false;
export function seedDemoData() {
  if (seeded) return;
  seeded = true;
  const demos = [
    { text: "I ghosted my best friend for 6 months and blamed it on anxiety but really I was just jealous of their success.", fid: 99991 },
    { text: "I've been pretending to work from home for 3 months. I actually quit and have been living off savings while job hunting.", fid: 99992 },
    { text: "I told everyone I was vegan but I eat chicken nuggets every week at the airport where nobody knows me.", fid: 99993 },
    { text: "I'm a doctor and I still Google my patients' symptoms before their appointments.", fid: 99994 },
    { text: "I've been dating two people simultaneously for 8 months. Neither knows. They've met each other at my parties.", fid: 99995 },
  ];
  for (const d of demos) {
    const c = createConfession(d.fid, d.text);
    for (let i = 1; i <= 45; i++) castVote(c.confession_id, i, i % 3 === 0 ? "fake" : "real");
    recordTip(c.confession_id, 1001, 2.5);
    recordTip(c.confession_id, 1002, 1.0);
    recordView(c.confession_id, 9001);
    recordView(c.confession_id, 9002);
    recordView(c.confession_id, 9003);
  }
}

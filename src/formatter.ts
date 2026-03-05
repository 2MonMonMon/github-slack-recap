import type { GitHubData, PullRequest, ReviewRequest } from "./github.js";

type SlackBlock = Record<string, unknown>;

const MAX_BLOCKS = 50;

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ciEmoji(status: PullRequest["ciStatus"]): string {
  return { success: "✅", failure: "❌", pending: "🔄", unknown: "⬜" }[status];
}

function reviewEmoji(decision: string | null): string {
  if (decision === "APPROVED") return "✅ Approved";
  if (decision === "CHANGES_REQUESTED") return "🔴 Changes requested";
  return "⏳ Awaiting review";
}

function prLine(pr: PullRequest): string {
  const draft = pr.draft ? " `[Draft]`" : "";
  const ci = ciEmoji(pr.ciStatus);
  const review = reviewEmoji(pr.reviewDecision);
  const approvals = `👍 ${pr.approvalCount} approval${pr.approvalCount !== 1 ? "s" : ""}`;
  const threads =
    pr.unresolvedThreadCount > 0
      ? ` · 💬 ${pr.unresolvedThreadCount} unresolved`
      : "";
  const overdue =
    pr.overdueReviewers.length > 0
      ? ` · ⏰ ${pr.overdueReviewers.map((r) => `@${r}`).join(", ")} overdue`
      : "";
  const diff = `+${pr.additions}/-${pr.deletions}`;
  return `*<${pr.url}|${pr.title}>*${draft}\n\`${pr.repo}\` · ${review} · ${approvals}${threads}${overdue} · ${ci} CI · \`${diff}\` · _${relativeTime(pr.updatedAt)}_`;
}

function reviewRequestLine(pr: ReviewRequest): string {
  return `*<${pr.url}|${pr.title}>*\n\`${pr.repo}\` · by @${pr.author} · _${relativeTime(pr.updatedAt)}_`;
}


function divider(): SlackBlock {
  return { type: "divider" };
}

function header(text: string): SlackBlock {
  return { type: "header", text: { type: "plain_text", text, emoji: true } };
}

function section(text: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

export function buildSlackBlocks(data: GitHubData): SlackBlock[] {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const blocks: SlackBlock[] = [];

  blocks.push(header(`📊 Daily GitHub Recap — ${today}`));

  // --- Ready to Merge ---
  const readyToMerge = data.myOpenPRs.filter(
    (pr) => pr.approvalCount >= 2 && pr.baseBranch === "develop"
  );
  blocks.push(divider());
  if (readyToMerge.length === 0) {
    blocks.push(section("*🚀 Ready to Merge*\nNo PRs ready to merge yet."));
  } else {
    blocks.push(section(`*🚀 Ready to Merge* (${readyToMerge.length})`));
    const lines = readyToMerge.map((pr) => `• *<${pr.url}|${pr.title}>*`).join("\n");
    blocks.push(section(lines));
  }

  // --- My Open PRs ---
  // Show only PRs that need attention:
  //   - has unresolved review threads, OR
  //   - has < 2 approvals AND at least one reviewer is overdue (asked 24h+ ago, no response)
  const prsNeedingAttention = data.myOpenPRs.filter(
    (pr) =>
      pr.unresolvedThreadCount > 0 ||
      (pr.approvalCount < 2 && pr.overdueReviewers.length > 0)
  );
  blocks.push(divider());
  if (prsNeedingAttention.length === 0) {
    blocks.push(section("*🔀 Your Open PRs*\nNo PRs need attention right now."));
  } else {
    blocks.push(section(`*🔀 Your Open PRs* (${prsNeedingAttention.length})`));
    for (const pr of prsNeedingAttention) {
      blocks.push(section(prLine(pr)));
    }
  }

  // --- Review Requests ---
  blocks.push(divider());
  if (data.reviewRequests.length === 0) {
    blocks.push(section("*👀 PRs Awaiting Your Review*\nNothing waiting for you."));
  } else {
    blocks.push(section(`*👀 PRs Awaiting Your Review* (${data.reviewRequests.length})`));
    for (const pr of data.reviewRequests) {
      blocks.push(section(reviewRequestLine(pr)));
    }
  }

  blocks.push(divider());
  blocks.push(section(`_Recap generated at ${new Date().toUTCString()}_`));

  // Slack hard limit: 50 blocks per message
  if (blocks.length > MAX_BLOCKS) {
    return [
      ...blocks.slice(0, MAX_BLOCKS - 2),
      divider(),
      section(`_⚠️ Message truncated — ${blocks.length - MAX_BLOCKS + 2} block(s) omitted. Too much activity!_`),
    ];
  }

  return blocks;
}

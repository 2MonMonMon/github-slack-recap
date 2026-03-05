import "dotenv/config";
import { fetchGitHubData } from "./github.js";
import { buildSlackBlocks } from "./formatter.js";
import { sendSlackMessage } from "./slack.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main() {
  const githubToken = requireEnv("GITHUB_TOKEN");
  const slackWebhookUrl = requireEnv("SLACK_WEBHOOK_URL");
  const githubUsername = requireEnv("GITHUB_USERNAME");

  console.log(`Fetching GitHub data for @${githubUsername}...`);
  const data = await fetchGitHubData(githubToken, githubUsername);

  console.log(`Found ${data.myOpenPRs.length} open PR(s), ${data.reviewRequests.length} review request(s).`);

  const blocks = buildSlackBlocks(data);

  console.log("Sending recap to Slack...");
  await sendSlackMessage(slackWebhookUrl, blocks);

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

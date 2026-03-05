type SlackBlock = Record<string, unknown>;

export async function sendSlackMessage(
  webhookUrl: string,
  blocks: SlackBlock[]
): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blocks }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Slack API error ${response.status}: ${text}`);
  }
}
